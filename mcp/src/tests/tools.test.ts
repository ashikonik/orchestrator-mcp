/**
 * The tool surface's tests.
 *
 * These drive the real server over an in-memory transport, in a real
 * git repository and a real board. The point is not that the functions
 * work -- the unit tests cover that -- but that the *server* enforces
 * what the policy promises:
 *
 *   - the surface is exactly 17 tools, no more and no less;
 *   - a refusal does not change anything;
 *   - a gate names the evidence that is missing;
 *   - a write tool runs by default, and `dry_run` writes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool, cleanup, connectClient, expectError, makeRepo, tempDir } from './helpers.js';
import { RULES } from '../policy-rules.js';

const ENV_KEYS = ['ORCHESTRATOR_ROOT', 'ORCHESTRATOR_BOARD', 'ORCHESTRATOR_POLICY'];

/**
 * The annotations of one tool.
 *
 * The SDK types them as optional, so every read of them needs a check.
 * This helper does the check once and returns them.
 */
function annotationsOf(tool: { name: string; annotations?: Record<string, unknown> | undefined }): Record<string, unknown> {
  assert.ok(tool.annotations, `${tool.name} has no annotations`);
  return tool.annotations;
}

/** The annotations of one tool, by name. */
function annotationsByName(tools: Array<{ name: string; annotations?: Record<string, unknown> | undefined }>, name: string): Record<string, unknown> {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `no tool named '${name}'`);
  return annotationsOf(tool);
}

/** A list field of a tool result, asserted to be present. */
function listOf(result: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = result[key];
  assert.ok(Array.isArray(value), `${key} is not an array`);
  return value as Array<Record<string, unknown>>;
}

/** An object field of a tool result, asserted to be present. */
function objOf(result: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = result[key];
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${key} is not an object`);
  return value as Record<string, unknown>;
}

/** A string field of a tool result, asserted to be present. */
function strOf(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  assert.equal(typeof value, 'string', `${key} is not a string`);
  return value as string;
}

/** Run a body with a clean environment, then restore what was there. */
async function withEnv<T>(overrides: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    for (const key of ENV_KEYS) {
      if (overrides[key] === undefined) delete process.env[key];
      else process.env[key] = overrides[key];
    }
    return await body();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** A repository with a board, wired up as the project root. */
function makeProject(): { root: string; board: string } {
  const root = tempDir('orchestrator-project-');
  makeRepo(root);
  const board = join(root, '.orchestrator', 'board.json');
  return { root, board };
}

async function withClient(
  root: string,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const { client, server } = await connectClient();
  try {
    await withEnv({ ORCHESTRATOR_ROOT: root }, () => body(client));
  } finally {
    await client.close();
    await server.close();
  }
}

// ==========================================================================
// The surface
// ==========================================================================

test('the server exposes exactly 22 tools', async () => {
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 22);
  } finally {
    await client.close();
    await server.close();
  }
});

test('the tool names are the expected 22', async () => {
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'board_get',
      'board_set',
      'git_combine',
      'git_commit',
      'git_diff',
      'git_log',
      'git_operate',
      'git_status',
      'git_worktree',
      'open_pr',
      'plan_from_commits',
      'policy_get',
      'policy_set',
      'task_claim',
      'task_create',
      'task_delete',
      'task_get',
      'task_list',
      'task_move',
      'task_next',
      'task_note',
      'task_update',
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('every tool has a title, a description and annotations', async () => {
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has no title`);
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} has a thin description`);
      assert.equal(typeof annotationsOf(tool).readOnlyHint, 'boolean');
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('the read tools are marked read-only and the write tools are not', async () => {
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    for (const name of ['board_get', 'task_list', 'task_get', 'task_next', 'git_status', 'git_diff', 'git_log', 'git_combine', 'policy_get']) {
      assert.equal(annotationsByName(tools, name).readOnlyHint, true, `${name} should be read-only`);
    }
    for (const name of ['board_set', 'task_create', 'task_update', 'task_move', 'task_delete', 'task_claim', 'task_note', 'git_commit', 'git_operate', 'git_worktree', 'open_pr', 'plan_from_commits', 'policy_set']) {
      assert.equal(annotationsByName(tools, name).readOnlyHint, false, `${name} should not be read-only`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('the destructive tools are marked destructive', async () => {
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    for (const name of ['board_set', 'task_delete', 'git_operate', 'git_worktree']) {
      assert.equal(annotationsByName(tools, name).destructiveHint, true, `${name} should be destructive`);
    }
    assert.equal(annotationsByName(tools, 'git_status').destructiveHint, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('open_pr is the only tool that reaches the network', async () => {
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (tool.name === 'open_pr') {
        assert.equal(annotationsOf(tool).openWorldHint, true);
      } else {
        assert.equal(annotationsOf(tool).openWorldHint, false, `${tool.name} should not be open-world`);
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('no tool description tells the model what to do', async () => {
  // A description states scope: what the tool covers and what it does
  // not. "Use X instead" is a directive, and a directive in a schema
  // competes with the model's own judgement about the task at hand.
  //
  // "The message must match the convention" is not a directive -- it
  // states a constraint the tool enforces. So these patterns look for
  // the imperative form: a verb addressed to the reader.
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const description = tool.description ?? '';
      assert.ok(!/\buse\b[^.]*\binstead\b/i.test(description), `${tool.name} has a directive description`);
      assert.ok(!/\byou (must|should|need to)\b/i.test(description), `${tool.name} has a directive description`);
      assert.ok(!/\balways (use|call|run|invoke)\b/i.test(description), `${tool.name} has a directive description`);
      assert.ok(!/\b(prefer|avoid) \w+ing\b/i.test(description), `${tool.name} has a directive description`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('every tool description says what it does not cover', async () => {
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.match(tool.description ?? '', /Not covered by/, `${tool.name} does not scope itself`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('every write tool takes dry_run, and no read tool does', async () => {
  // The server's contract is that write tools execute by default and
  // offer a preview. A write tool without `dry_run` has no preview, and
  // a read tool with one invites a caller to wait for a write that will
  // never happen.
  const { client, server } = await connectClient();
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
      const properties = schema?.properties ?? {};
      const readOnly = annotationsOf(tool).readOnlyHint === true;
      const hasDryRun = 'dry_run' in properties;
      if (readOnly) {
        assert.equal(hasDryRun, false, `${tool.name} is read-only and should not take dry_run`);
      } else {
        assert.equal(hasDryRun, true, `${tool.name} writes and should take dry_run`);
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ==========================================================================
// The board
// ==========================================================================

test('board_get on an empty project reports an empty board', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'board_get');
      assert.equal(result.board_exists, false);
      assert.equal(result.task_count, 0);
      assert.deepEqual(result.tasks, []);
    });
  } finally {
    cleanup(root);
  }
});

test('task_create writes a task to the board', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'task_create', { title: 'Write the parser' });
      assert.equal(result.created, true);
      assert.equal(result.id, 'T-001');
      assert.ok(existsSync(board));

      const written = JSON.parse(readFileSync(board, 'utf-8'));
      assert.equal(written.tasks.length, 1);
      assert.equal(written.tasks[0].title, 'Write the parser');
      assert.equal(written.tasks[0].state, 'todo');
    });
  } finally {
    cleanup(root);
  }
});

test('task_create allocates increasing ids', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const second = await callTool(client, 'task_create', { title: 'Two' });
      assert.equal(second.id, 'T-002');
    });
  } finally {
    cleanup(root);
  }
});

test('task_create refuses a duplicate id', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const error = await expectError(client, 'task_create', { title: 'Again', id: 'T-001' });
      assert.match(error, /already exists/);
    });
  } finally {
    cleanup(root);
  }
});

test('task_get returns the task with its history', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const result = await callTool(client, 'task_get', { id: 'T-001' });
      assert.equal(result.id, 'T-001');
      assert.equal(listOf(result, 'history').length, 1);
    });
  } finally {
    cleanup(root);
  }
});

test('task_get on a missing task is an error', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const error = await expectError(client, 'task_get', { id: 'T-404' });
      assert.match(error, /not found/);
    });
  } finally {
    cleanup(root);
  }
});

test('task_list filters by state', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      await callTool(client, 'task_create', { title: 'Two', state: 'backlog' });
      const result = await callTool(client, 'task_list', { state: 'backlog' });
      assert.equal(result.total_matched, 1);
      assert.equal(listOf(result, 'tasks')[0].title, 'Two');
    });
  } finally {
    cleanup(root);
  }
});

test('task_list matches a free-text query', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'Write the parser' });
      await callTool(client, 'task_create', { title: 'Write the tests' });
      const result = await callTool(client, 'task_list', { query: 'parser' });
      assert.equal(result.total_matched, 1);
    });
  } finally {
    cleanup(root);
  }
});

test('task_list paginates', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      for (const title of ['a', 'b', 'c']) await callTool(client, 'task_create', { title });
      const result = await callTool(client, 'task_list', { limit: 2 });
      assert.equal(result.returned, 2);
      assert.equal(result.total_matched, 3);
      assert.equal(result.truncated, true);
    });
  } finally {
    cleanup(root);
  }
});

test('task_update changes the fields it is given and nothing else', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const result = await callTool(client, 'task_update', { id: 'T-001', title: 'Renamed' });
      assert.equal(result.applied, true);
      assert.deepEqual(result.updated, ['title']);
      assert.equal(objOf(result, 'task').title, 'Renamed');
    });
  } finally {
    cleanup(root);
  }
});

test('task_update with nothing to change writes nothing', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const before = readFileSync(board, 'utf-8');
      const result = await callTool(client, 'task_update', { id: 'T-001', title: 'One' });
      assert.equal(result.applied, false);
      assert.deepEqual(result.updated, []);
      assert.equal(readFileSync(board, 'utf-8'), before);
    });
  } finally {
    cleanup(root);
  }
});

test('task_delete needs a confirmation', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const held = await callTool(client, 'task_delete', { id: 'T-001' });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-37');
      assert.equal(existsSync(board), true);

      const deleted = await callTool(client, 'task_delete', { id: 'T-001', confirm: true });
      assert.equal(deleted.deleted, 1);
      const written = JSON.parse(readFileSync(board, 'utf-8'));
      assert.equal(written.tasks.length, 0);
    });
  } finally {
    cleanup(root);
  }
});

test('task_delete refuses a done task', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'done' });
      const result = await callTool(client, 'task_delete', { id: 'T-001', confirm: true });
      assert.equal(result.refused, true);
      assert.equal(result.rule, 'PR-37');
    });
  } finally {
    cleanup(root);
  }
});

test('board_set replaces the board wholesale', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'board_set', {
        board: {
          schema_version: 1,
          project: 'test',
          updated_at: '2026-11-07T00:00:00Z',
          tasks: [
            {
              id: 'T-001',
              title: 'One',
              body: '',
              state: 'todo',
              labels: [],
              assignee: null,
              blocked_by: [],
              branch: null,
              created_at: '2026-11-07T00:00:00Z',
              updated_at: '2026-11-07T00:00:00Z',
              history: [],
            },
          ],
        },
      });
      assert.equal(result.written, 1);
      const written = JSON.parse(readFileSync(board, 'utf-8'));
      assert.equal(written.tasks.length, 1);
    });
  } finally {
    cleanup(root);
  }
});

test('board_set refuses a board that breaks an invariant', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'board_set', {
        board: {
          schema_version: 1,
          project: 'test',
          updated_at: '2026-11-07T00:00:00Z',
          tasks: [
            {
              id: 'T-001',
              title: 'One',
              body: '',
              state: 'todo',
              labels: [],
              assignee: null,
              blocked_by: ['T-404'],
              branch: null,
              created_at: '2026-11-07T00:00:00Z',
              updated_at: '2026-11-07T00:00:00Z',
              history: [],
            },
          ],
        },
      });
      assert.equal(result.written, 0);
      assert.equal(listOf(result, 'violations')[0].invariant, 'INV-4');
      assert.equal(existsSync(board), false);
    });
  } finally {
    cleanup(root);
  }
});

test('board_set with dry_run writes nothing', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'board_set', {
        dry_run: true,
        board: {
          schema_version: 1,
          project: 'test',
          updated_at: '2026-11-07T00:00:00Z',
          tasks: [],
        },
      });
      assert.equal(result.dry_run, true);
      assert.equal(result.written, 0);
      assert.equal(existsSync(board), false);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The task state machine
// ==========================================================================

test('task_move allows a permitted transition', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const result = await callTool(client, 'task_move', { id: 'T-001', to: 'in_progress' });
      assert.equal(result.applied, true);
      assert.equal(objOf(result, 'task').state, 'in_progress');
    });
  } finally {
    cleanup(root);
  }
});

test('task_move refuses todo -> done and changes nothing', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const before = readFileSync(board, 'utf-8');
      const result = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(result.refused, true);
      assert.equal(result.rule, 'ST-9');
      assert.equal(readFileSync(board, 'utf-8'), before);
    });
  } finally {
    cleanup(root);
  }
});

test('task_move refuses backlog -> in_progress', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'backlog' });
      const result = await callTool(client, 'task_move', { id: 'T-001', to: 'in_progress' });
      assert.equal(result.refused, true);
      assert.equal(result.rule, 'ST-3');
    });
  } finally {
    cleanup(root);
  }
});

test('task_move holds a cancellation without a reason', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      const before = readFileSync(board, 'utf-8');
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'cancelled' });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-2');
      assert.equal(readFileSync(board, 'utf-8'), before);

      const allowed = await callTool(client, 'task_move', { id: 'T-001', to: 'cancelled', reason: 'superseded' });
      assert.equal(allowed.applied, true);
    });
  } finally {
    cleanup(root);
  }
});

test('task_move holds a completion without a commit and changes nothing', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress' });
      const before = readFileSync(board, 'utf-8');
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-3');
      assert.equal(readFileSync(board, 'utf-8'), before);
    });
  } finally {
    cleanup(root);
  }
});

test('task_move refuses entry into in_progress while a blocker is unfinished', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'Blocker' });
      await callTool(client, 'task_create', { title: 'Blocked', blocked_by: ['T-001'] });
      const result = await callTool(client, 'task_move', { id: 'T-002', to: 'in_progress' });
      assert.equal(result.refused, true);
      assert.equal(result.rule, 'ST-DEP');
      assert.equal(listOf(result, 'blocking_tasks')[0].id, 'T-001');
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// Git
// ==========================================================================

test('git_status reports the branch and a clean tree', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_status');
      assert.equal(result.branch, 'main');
      assert.equal(result.clean, true);
      assert.deepEqual(result.staged, []);
    });
  } finally {
    cleanup(root);
  }
});

test('git_status reports untracked files', async () => {
  const { root } = makeProject();
  try {
    writeFileSync(join(root, 'new.txt'), 'x', 'utf-8');
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_status');
      assert.equal(result.clean, false);
      assert.deepEqual(result.untracked, ['new.txt']);
    });
  } finally {
    cleanup(root);
  }
});

test('git_status outside a repository is refused', async () => {
  const root = tempDir('orchestrator-norepo-');
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_status');
      assert.equal(result.denied, true);
      assert.equal(result.rule, 'PR-8');
    });
  } finally {
    cleanup(root);
  }
});

test('git_diff reports the staged changes', async () => {
  const { root } = makeProject();
  try {
    writeFileSync(join(root, 'new.txt'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', '--', 'new.txt'], { cwd: root, encoding: 'utf-8' });
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_diff', { staged: true });
      assert.equal(result.mode, 'staged');
      assert.match(strOf(result, 'diff'), /new\.txt/);
    });
  } finally {
    cleanup(root);
  }
});

test('git_diff refuses a path that escapes the repository', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const error = await expectError(client, 'git_diff', { path: '../../etc/passwd' });
      assert.match(error, /Invalid path/);
    });
  } finally {
    cleanup(root);
  }
});

test('git_log reports the commits', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_log');
      assert.equal(result.total, 1);
      assert.equal(listOf(result, 'commits')[0].subject, 'chore: init');
    });
  } finally {
    cleanup(root);
  }
});

test('git_commit refuses a message that breaks the convention', async () => {
  const { root } = makeProject();
  try {
    writeFileSync(join(root, 'new.txt'), 'hello\n', 'utf-8');
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_commit', { message: 'just some words' });
      assert.equal(result.denied, true);
      assert.equal(result.rule, 'PR-9');
      // The refusal names the pattern that was not matched, so the
      // caller can see what the convention actually is.
      assert.match(strOf(result, 'reason'), /commit_message_pattern|feat/);
      assert.match(strOf(result, 'hint'), /feat:/);
    });
  } finally {
    cleanup(root);
  }
});

test('git_commit with dry_run commits nothing', async () => {
  const { root } = makeProject();
  try {
    writeFileSync(join(root, 'new.txt'), 'hello\n', 'utf-8');
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_commit', { message: 'feat: add a file', dry_run: true });
      assert.equal(result.dry_run, true);
      assert.equal(result.status, 'planned');
      assert.equal(result.commit_hash, null);
      const log = await callTool(client, 'git_log');
      assert.equal(log.total, 1);
    });
  } finally {
    cleanup(root);
  }
});

test('git_commit commits by default', async () => {
  const { root } = makeProject();
  try {
    writeFileSync(join(root, 'new.txt'), 'hello\n', 'utf-8');
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_commit', { message: 'feat: add a file', include_untracked: true });
      assert.equal(result.applied, true);
      assert.equal(result.status, 'committed');
      assert.ok(result.commit_hash);

      const log = await callTool(client, 'git_log');
      assert.equal(log.total, 2);
      assert.equal(listOf(log, 'commits')[0].subject, 'feat: add a file');
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate refuses to push a protected branch', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_operate', {
        operation: 'push',
        args: { branch: 'main', remote: 'origin' },
      });
      assert.equal(result.denied, true);
      assert.equal(result.rule, 'PR-16');
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate refuses a force push', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_operate', {
        operation: 'push',
        args: { branch: 'feature', force: true },
        force: true,
      });
      assert.equal(result.denied, true);
      assert.equal(result.rule, 'PR-17');
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate refuses a squash merge', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_operate', {
        operation: 'merge',
        args: { source: 'main', strategy: 'squash' },
      });
      assert.equal(result.denied, true);
      assert.equal(result.rule, 'PR-19');
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate holds a hard reset without a confirmation', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const held = await callTool(client, 'git_operate', {
        operation: 'reset',
        args: { mode: 'hard', target: 'HEAD~1' },
      });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-21');

      const allowed = await callTool(client, 'git_operate', {
        operation: 'reset',
        args: { mode: 'hard', target: 'HEAD~1' },
        confirm: true,
        dry_run: true,
      });
      assert.equal(allowed.dry_run, true);
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate refuses a branch delete of an unmerged branch without force', async () => {
  const { root } = makeProject();
  try {
    // The commit has to land *on* the branch, otherwise the branch
    // points at the same commit as main and is trivially merged.
    execFileSync('git', ['checkout', '-qb', 'feat/x'], { cwd: root, encoding: 'utf-8' });
    writeFileSync(join(root, 'work.txt'), 'work\n', 'utf-8');
    execFileSync('git', ['add', '--', 'work.txt'], { cwd: root, encoding: 'utf-8' });
    execFileSync('git', ['commit', '-qm', 'feat: work'], { cwd: root, encoding: 'utf-8' });

    await withClient(root, async (client) => {
      const held = await callTool(client, 'git_operate', {
        operation: 'branch',
        args: { action: 'delete', name: 'feat/x' },
      });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-13');
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate deletes a merged branch without a force', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'git_operate', { operation: 'branch', args: { action: 'create', name: 'feat/x' } });
      const result = await callTool(client, 'git_operate', {
        operation: 'branch',
        args: { action: 'delete', name: 'feat/x' },
        dry_run: true,
      });
      assert.equal(result.dry_run, true);
      assert.equal(result.applied, false);
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate refuses a remote add', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_operate', {
        operation: 'remote',
        args: { action: 'add', name: 'origin' },
      });
      assert.equal(result.denied, true);
      assert.equal(result.rule, 'PR-27');
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate refuses a stash drop without a confirmation', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const held = await callTool(client, 'git_operate', {
        operation: 'stash',
        args: { action: 'drop' },
      });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-24');

      const allowed = await callTool(client, 'git_operate', {
        operation: 'stash',
        args: { action: 'drop' },
        confirm: true,
        dry_run: true,
      });
      assert.equal(allowed.dry_run, true);
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate refuses a tag delete without a confirmation', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const held = await callTool(client, 'git_operate', {
        operation: 'tag',
        args: { action: 'delete', name: 'v1' },
      });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-26');
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate refuses an invalid branch name', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const error = await expectError(client, 'git_operate', {
        operation: 'branch',
        args: { action: 'create', name: '--force' },
      });
      assert.match(error, /Invalid branch name/);
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate with dry_run runs nothing', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_operate', {
        operation: 'branch',
        args: { action: 'create', name: 'feat/x' },
        dry_run: true,
      });
      assert.equal(result.dry_run, true);
      assert.equal(result.applied, false);

      const list = await callTool(client, 'git_operate', { operation: 'branch', args: { action: 'list' } });
      assert.doesNotMatch(strOf(list, 'stdout'), /feat\/x/);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The forge and the planner
// ==========================================================================

test('open_pr refuses a protected branch', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'open_pr', { title: 'A change' });
      assert.equal(result.gated, true);
      assert.equal(result.gate, 'PR-42');
    });
  } finally {
    cleanup(root);
  }
});

test('open_pr with dry_run opens nothing', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      // The pull request comes from the *current* branch, so it has to
      // be checked out first.
      await callTool(client, 'git_operate', { operation: 'branch', args: { action: 'create', name: 'feat/x' } });
      await callTool(client, 'git_operate', { operation: 'branch', args: { action: 'checkout', name: 'feat/x' } });
      const result = await callTool(client, 'open_pr', { title: 'A change', dry_run: true });
      assert.equal(result.dry_run, true);
      assert.equal(result.applied, false);
      assert.equal(result.url, null);
      assert.equal(result.branch, 'feat/x');
    });
  } finally {
    cleanup(root);
  }
});

test('plan_from_commits proposes without writing by default', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'plan_from_commits');
      assert.deepEqual(result.created, []);
      assert.match(strOf(result, 'note'), /Nothing was written/);
      assert.equal(existsSync(board), false);
    });
  } finally {
    cleanup(root);
  }
});

test('plan_from_commits creates tasks when asked', async () => {
  const { root, board } = makeProject();
  try {
    // A branch with a commit of its own, so the range against the base
    // is not empty.
    execFileSync('git', ['checkout', '-qb', 'feat/x'], { cwd: root, encoding: 'utf-8' });
    writeFileSync(join(root, 'work.txt'), 'work\n', 'utf-8');
    execFileSync('git', ['add', '--', 'work.txt'], { cwd: root, encoding: 'utf-8' });
    execFileSync('git', ['commit', '-qm', 'feat: do the work'], { cwd: root, encoding: 'utf-8' });

    await withClient(root, async (client) => {
      const result = await callTool(client, 'plan_from_commits', { branch: 'feat/x', create_tasks: true });
      assert.equal(result.applied, true);
      assert.equal(result.commits_read, 1);
      assert.equal(listOf(result, 'created').length, 1);
      assert.ok(existsSync(board));

      const written = JSON.parse(readFileSync(board, 'utf-8'));
      assert.equal(written.tasks.length, 1);
      assert.equal(written.tasks[0].title, 'feat: do the work');
    });
  } finally {
    cleanup(root);
  }
});

test('plan_from_commits without create_tasks proposes and writes nothing', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'plan_from_commits', { create_tasks: false });
      assert.equal(result.gated, undefined);
      assert.equal(result.applied, undefined);
      assert.deepEqual(result.created, []);
      assert.equal(existsSync(board), false);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The policy
// ==========================================================================

test('policy_get reports every rule', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'policy_get');
      const rules = listOf(result, 'rules');
      assert.equal(rules.length, RULES.length);
      assert.equal(result.source, 'default');
      const pr16 = rules.find((r) => r.id === 'PR-16');
      assert.equal(pr16?.verdict, 'deny');
    });
  } finally {
    cleanup(root);
  }
});

test('policy_set needs a confirmation', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const policy = {
        schema_version: 1,
        default_branch: 'main',
        protected_branches: ['main'],
        allowed_merge_strategies: ['merge'],
        commit_message_pattern: '^.+$',
        deny: ['PR-12'],
      };
      const held = await callTool(client, 'policy_set', { policy });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-41');

      const written = await callTool(client, 'policy_set', { policy, confirm: true });
      assert.equal(written.written, true);
    });
  } finally {
    cleanup(root);
  }
});

test('policy_set refuses to loosen a built-in rule', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'policy_set', {
        confirm: true,
        policy: {
          schema_version: 1,
          default_branch: 'main',
          protected_branches: ['main'],
          allowed_merge_strategies: ['merge'],
          commit_message_pattern: '^.+$',
          deny: ['PR-999'],
        },
      });
      assert.equal(result.refused, true);
      assert.equal(result.rule, 'PR-41');
    });
  } finally {
    cleanup(root);
  }
});

test('a policy file may tighten a rule and the tools honour it', async () => {
  const { root } = makeProject();
  try {
    mkdirSync(join(root, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(root, '.orchestrator', 'policy.json'),
      JSON.stringify({
        schema_version: 1,
        default_branch: 'main',
        protected_branches: ['main'],
        allowed_merge_strategies: ['merge'],
        commit_message_pattern: '^.+$',
        deny: ['PR-12'],
      }),
      'utf-8',
    );
    await withClient(root, async (client) => {
      const policy = await callTool(client, 'policy_get');
      assert.equal(policy.source, 'file');
      assert.deepEqual(policy.overrides, ['PR-12']);

      const result = await callTool(client, 'git_operate', {
        operation: 'branch',
        args: { action: 'create', name: 'feat/x' },
      });
      assert.equal(result.denied, true);
      assert.equal(result.rule, 'PR-12');
    });
  } finally {
    cleanup(root);
  }
});

test('a tightened read rule stops the read tools too', async () => {
  // A rule that says "reading is allowed" is only worth having if a
  // repository can tighten it. The read tools ask the policy just like
  // the write tools do -- otherwise a tightened read rule is a rule that
  // is not really enforced.
  const { root } = makeProject();
  try {
    mkdirSync(join(root, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(root, '.orchestrator', 'policy.json'),
      JSON.stringify({
        schema_version: 1,
        default_branch: 'main',
        protected_branches: ['main'],
        allowed_merge_strategies: ['merge'],
        commit_message_pattern: '^.+$',
        deny: ['PR-1', 'PR-38', 'PR-39', 'PR-5', 'PR-6', 'PR-7'],
      }),
      'utf-8',
    );

    await withClient(root, async (client) => {
      // One read tool per tightened rule.
      const cases = [
        { name: 'board_get', args: {}, rule: 'PR-1' },
        { name: 'task_list', args: {}, rule: 'PR-38' },
        { name: 'task_get', args: { id: 'T-001' }, rule: 'PR-39' },
        { name: 'git_status', args: {}, rule: 'PR-5' },
        { name: 'git_diff', args: {}, rule: 'PR-6' },
        { name: 'git_log', args: {}, rule: 'PR-7' },
      ];
      for (const c of cases) {
        const result = await callTool(client, c.name, c.args);
        assert.equal(result.denied, true, `${c.name} was not denied by ${c.rule}`);
        assert.equal(result.rule, c.rule, `${c.name} was denied by the wrong rule`);
      }
    });
  } finally {
    cleanup(root);
  }
});
