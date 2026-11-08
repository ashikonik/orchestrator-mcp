/**
 * The tests for the features the survey added.
 *
 * These cover the board's new fields, the workflow gates, and the five
 * new tools. Each one asserts the behaviour the feature promises --
 * including the refusals, because a gate that never fires is not a
 * gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool, cleanup, connectClient, expectError, makeRepo, tempDir } from './helpers.js';
import { findParentCycles, firstOverlap, pathsOverlap, taskIdForKey } from '../board.js';
import { validateBoard } from '../board.js';
import { emptyBoard } from '../board-schema.js';
import type { Board, Task } from '../types.js';

const ENV_KEYS = ['ORCHESTRATOR_ROOT', 'ORCHESTRATOR_BOARD', 'ORCHESTRATOR_POLICY'];

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
  const root = tempDir('orchestrator-feature-');
  makeRepo(root);
  const board = join(root, '.orchestrator', 'board.json');
  return { root, board };
}

async function withClient(root: string, body: (client: Client) => Promise<void>): Promise<void> {
  const { client, server } = await connectClient();
  try {
    await withEnv({ ORCHESTRATOR_ROOT: root }, () => body(client));
  } finally {
    await client.close();
    await server.close();
  }
}

/** A task, for the invariant tests. */
function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    body: '',
    state: 'todo',
    labels: [],
    assignee: null,
    blocked_by: [],
    branch: null,
    created_at: '2026-11-07T00:00:00Z',
    updated_at: '2026-11-07T00:00:00Z',
    history: [],
    ...extra,
  };
}

/** A board holding the given tasks. */
function board(tasks: Task[]): Board {
  return { ...emptyBoard('demo', '2026-11-07T00:00:00Z'), tasks };
}

// ==========================================================================
// The board fields
// ==========================================================================

test('task_create writes the parent, the priority and the locks', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const parent = await callTool(client, 'task_create', { title: 'The parent' });
      const parentId = String(parent.id);

      const child = await callTool(client, 'task_create', {
        title: 'The child',
        parent: parentId,
        priority: 5,
        locks: ['src/a.ts'],
      });
      assert.equal(child.created, true);
      const task = child.task as Record<string, unknown>;
      assert.equal(task['parent'], parentId);
      assert.equal(task['priority'], 5);
      assert.deepEqual(task['locks'], ['src/a.ts']);

      // And it reads back.
      const read = await callTool(client, 'task_get', { id: String(child.id) });
      assert.equal(read.parent, parentId);
      assert.equal(read.priority, 5);
      assert.deepEqual(read.locks, ['src/a.ts']);
    });
  } finally {
    cleanup(root);
  }
});

test('task_update changes the parent, the priority and the locks', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const parent = await callTool(client, 'task_create', { title: 'The parent' });
      const child = await callTool(client, 'task_create', { title: 'The child' });

      const updated = await callTool(client, 'task_update', {
        id: String(child.id),
        parent: String(parent.id),
        priority: 9,
        locks: ['src/b.ts'],
      });
      assert.equal(updated.applied, true);
      assert.deepEqual(updated.updated?.sort(), ['locks', 'parent', 'priority']);
    });
  } finally {
    cleanup(root);
  }
});

test('a task whose parent does not exist is refused', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'task_create', {
        title: 'Orphan',
        parent: 'T-999',
      });
      assert.equal(result.applied, false);
      assert.equal(result.created, false);
      // The refusal names the invariant that stopped it.
      const violations = result.violations as Array<Record<string, unknown>>;
      assert.ok(violations.some((v) => v['invariant'] === 'INV-8'));
      // The board was not written, because the invariant refused it.
      const read = await callTool(client, 'board_get');
      assert.equal(read.task_count, 0);
    });
  } finally {
    cleanup(root);
  }
});

test('a task that is its own parent is refused', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Self' });
      const id = String(created.id);
      const updated = await callTool(client, 'task_update', { id, parent: id });
      assert.notEqual(updated.applied, true);
    });
  } finally {
    cleanup(root);
  }
});

test('INV-8 refuses a parent that is not on the board', () => {
  const violations = validateBoard(board([task('T-001', { parent: 'T-404' })]));
  assert.ok(violations.some((v) => v.invariant === 'INV-8'));
});

test('INV-9 refuses a task that is its own parent', () => {
  const violations = validateBoard(board([task('T-001', { parent: 'T-001' })]));
  assert.ok(violations.some((v) => v.invariant === 'INV-9'));
});

test('INV-10 refuses a parent cycle', () => {
  const violations = validateBoard(
    board([task('T-001', { parent: 'T-002' }), task('T-002', { parent: 'T-001' })]),
  );
  assert.ok(violations.some((v) => v.invariant === 'INV-10'));
});

test('a parent chain that does not come back around is fine', () => {
  const violations = validateBoard(
    board([
      task('T-001', { parent: 'T-002' }),
      task('T-002', { parent: 'T-003' }),
      task('T-003'),
    ]),
  );
  assert.equal(violations.length, 0);
});

test('findParentCycles finds the cycle and names it', () => {
  const cycles = findParentCycles(
    board([task('T-001', { parent: 'T-002' }), task('T-002', { parent: 'T-001' })]),
  );
  assert.equal(cycles.length, 1);
  // The cycle closes on itself, so the first id appears twice -- the
  // same convention the dependency cycles use.
  assert.ok(cycles[0].includes('T-001'));
  assert.ok(cycles[0].includes('T-002'));
});

test('findParentCycles returns nothing for a hierarchy that is a tree', () => {
  const cycles = findParentCycles(
    board([
      task('T-001', { parent: 'T-002' }),
      task('T-002', { parent: 'T-003' }),
      task('T-003'),
    ]),
  );
  assert.deepEqual(cycles, []);
});

test('INV-11 refuses two tasks holding the same lock', () => {
  const violations = validateBoard(
    board([task('T-001', { locks: ['src/a.ts'] }), task('T-002', { locks: ['src/a.ts'] })]),
  );
  assert.ok(violations.some((v) => v.invariant === 'INV-11'));
});

test('two tasks holding different locks are fine', () => {
  const violations = validateBoard(
    board([task('T-001', { locks: ['src/a.ts'] }), task('T-002', { locks: ['src/b.ts'] })]),
  );
  assert.equal(violations.length, 0);
});

test('two tasks holding overlapping locks are refused', () => {
  // A directory lock covers everything under it.
  const violations = validateBoard(
    board([task('T-001', { locks: ['src'] }), task('T-002', { locks: ['src/a.ts'] })]),
  );
  assert.ok(violations.some((v) => v.invariant === 'INV-11'));
});

test('pathsOverlap covers a directory but not a sibling with a shared prefix', () => {
  assert.equal(pathsOverlap('src', 'src/a.ts'), true);
  assert.equal(pathsOverlap('src/a.ts', 'src'), true);
  assert.equal(pathsOverlap('src/a.ts', 'src/a.ts'), true);
  assert.equal(pathsOverlap('src/a.ts', 'src/a.ts.bak'), false);
  assert.equal(pathsOverlap('src/a.ts', 'src/b.ts'), false);
  assert.equal(firstOverlap(['src/a.ts'], ['src/a.ts.bak']), null);
  assert.equal(firstOverlap(['src'], ['src/a.ts']), 'src');
});

// ==========================================================================
// task_next
// ==========================================================================

test('task_next picks the task with the highest priority', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'Low', priority: 1 });
      await callTool(client, 'task_create', { title: 'High', priority: 9 });
      await callTool(client, 'task_create', { title: 'Middle', priority: 5 });

      const result = await callTool(client, 'task_next');
      const next = result.next as Record<string, unknown>;
      assert.equal(next['title'], 'High');
    });
  } finally {
    cleanup(root);
  }
});

test('task_next is deterministic -- the same board gives the same answer', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One' });
      await callTool(client, 'task_create', { title: 'Two' });
      await callTool(client, 'task_create', { title: 'Three' });

      const first = await callTool(client, 'task_next');
      const second = await callTool(client, 'task_next');
      assert.equal((first.next as Record<string, unknown>)['id'], (second.next as Record<string, unknown>)['id']);
    });
  } finally {
    cleanup(root);
  }
});

test('task_next skips a blocked task', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const blocker = await callTool(client, 'task_create', { title: 'Blocker' });
      const blocked = await callTool(client, 'task_create', {
        title: 'Blocked',
        priority: 100,
        blocked_by: [String(blocker.id)],
      });
      await callTool(client, 'task_create', { title: 'Free', priority: 1 });

      const result = await callTool(client, 'task_next');
      const next = result.next as Record<string, unknown>;
      assert.equal(next['title'], 'Free');
      assert.notEqual(next['id'], blocked.id);
    });
  } finally {
    cleanup(root);
  }
});

test('task_next skips a task somebody else holds a live claim on', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const claimed = await callTool(client, 'task_create', { title: 'Claimed', priority: 100 });
      await callTool(client, 'task_claim', { id: String(claimed.id), agent: 'agent-a' });
      await callTool(client, 'task_create', { title: 'Free', priority: 1 });

      const result = await callTool(client, 'task_next');
      assert.equal((result.next as Record<string, unknown>)['title'], 'Free');
    });
  } finally {
    cleanup(root);
  }
});

test('task_next skips a done task', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'Done', state: 'done' });
      await callTool(client, 'task_create', { title: 'Live' });
      const result = await callTool(client, 'task_next');
      assert.equal((result.next as Record<string, unknown>)['title'], 'Live');
    });
  } finally {
    cleanup(root);
  }
});

test('task_next reports nothing when there is nothing to do', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'task_next');
      assert.equal(result.next, null);
      assert.equal(result.eligible, 0);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// task_claim
// ==========================================================================

test('task_claim claims an unblocked task and records the lease', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      const result = await callTool(client, 'task_claim', {
        id: String(created.id),
        agent: 'agent-a',
        lease_seconds: 600,
      });
      assert.equal(result.claimed, true);
      const claim = result.claim as Record<string, unknown>;
      assert.equal(claim['agent'], 'agent-a');
      assert.ok(typeof claim['lease_expires_at'] === 'string');
    });
  } finally {
    cleanup(root);
  }
});

test('task_claim refuses a task that is blocked, and names the blocker', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const blocker = await callTool(client, 'task_create', { title: 'Blocker' });
      const blocked = await callTool(client, 'task_create', {
        title: 'Blocked',
        blocked_by: [String(blocker.id)],
      });
      const result = await callTool(client, 'task_claim', { id: String(blocked.id), agent: 'agent-a' });
      assert.equal(result.gated, true);
      assert.equal(result.gate, 'PR-48');
      const blockers = result.blocking_tasks as Array<Record<string, unknown>>;
      assert.equal(blockers.length, 1);
      assert.equal(blockers[0]['id'], blocker.id);
    });
  } finally {
    cleanup(root);
  }
});

test('task_claim refuses a task somebody else holds', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      await callTool(client, 'task_claim', { id: String(created.id), agent: 'agent-a' });
      const second = await callTool(client, 'task_claim', { id: String(created.id), agent: 'agent-b' });
      assert.equal(second.gated, true);
      assert.equal(second.gate, 'PR-48');
      assert.match(String(second.reason), /agent-a/);
    });
  } finally {
    cleanup(root);
  }
});

test('task_claim releases a claim', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      await callTool(client, 'task_claim', { id: String(created.id), agent: 'agent-a' });
      const released = await callTool(client, 'task_claim', {
        id: String(created.id),
        action: 'release',
        agent: 'agent-a',
      });
      assert.equal(released.released, 1);

      // And now somebody else can take it.
      const second = await callTool(client, 'task_claim', { id: String(created.id), agent: 'agent-b' });
      assert.equal(second.claimed, true);
    });
  } finally {
    cleanup(root);
  }
});

test('task_claim records the claim in the task history', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      await callTool(client, 'task_claim', { id: String(created.id), agent: 'agent-a' });
      const read = await callTool(client, 'task_get', { id: String(created.id) });
      const history = read.history as Array<Record<string, unknown>>;
      assert.ok(history.some((h) => String(h['note']).includes('claimed')));
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// task_note
// ==========================================================================

test('task_note appends a note', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      const result = await callTool(client, 'task_note', {
        id: String(created.id),
        text: 'I looked at this.',
        actor: 'agent-a',
      });
      assert.equal(result.notes_added, 1);

      const read = await callTool(client, 'task_get', { id: String(created.id) });
      const notes = read.notes as Array<Record<string, unknown>>;
      assert.equal(notes.length, 1);
      assert.equal(notes[0]['text'], 'I looked at this.');
      assert.equal(notes[0]['actor'], 'agent-a');
    });
  } finally {
    cleanup(root);
  }
});

test('task_note appends rather than replaces', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      await callTool(client, 'task_note', { id: String(created.id), text: 'First' });
      await callTool(client, 'task_note', { id: String(created.id), text: 'Second' });
      const read = await callTool(client, 'task_get', { id: String(created.id) });
      assert.equal((read.notes as unknown[]).length, 2);
    });
  } finally {
    cleanup(root);
  }
});

test('task_note does not change the task state', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      await callTool(client, 'task_note', { id: String(created.id), text: 'A note' });
      const read = await callTool(client, 'task_get', { id: String(created.id) });
      assert.equal(read.state, 'todo');
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The idempotency keys
// ==========================================================================

test('task_note with the same idempotency key appends once', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      const first = await callTool(client, 'task_note', {
        id: String(created.id),
        text: 'Only once',
        idempotency_key: 'key-1',
      });
      assert.equal(first.notes_added, 1);

      const second = await callTool(client, 'task_note', {
        id: String(created.id),
        text: 'Only once',
        idempotency_key: 'key-1',
      });
      assert.equal(second.notes_added, 0);
      assert.equal(second.duplicate, true);

      const read = await callTool(client, 'task_get', { id: String(created.id) });
      assert.equal((read.notes as unknown[]).length, 1);
    });
  } finally {
    cleanup(root);
  }
});

test('task_note without a key appends every time', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      await callTool(client, 'task_note', { id: String(created.id), text: 'Again' });
      await callTool(client, 'task_note', { id: String(created.id), text: 'Again' });
      const read = await callTool(client, 'task_get', { id: String(created.id) });
      assert.equal((read.notes as unknown[]).length, 2);
    });
  } finally {
    cleanup(root);
  }
});

test('task_create with the same idempotency key creates one task', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const first = await callTool(client, 'task_create', {
        title: 'Once',
        idempotency_key: 'task-key-1',
      });
      assert.equal(first.created, true);
      const id = String(first.id);

      const second = await callTool(client, 'task_create', {
        title: 'Once',
        idempotency_key: 'task-key-1',
      });
      assert.equal(second.created, false);
      assert.equal(second.duplicate, true);
      assert.equal(second.id, id);

      const read = await callTool(client, 'board_get');
      assert.equal(read.task_count, 1);
    });
  } finally {
    cleanup(root);
  }
});

test('task_create with an idempotency key does not disturb the sequential ids', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const keyed = await callTool(client, 'task_create', {
        title: 'Keyed',
        idempotency_key: 'task-key-2',
      });
      // The keyed id is a large number, not T-001.
      assert.notEqual(keyed.id, 'T-001');

      const next = await callTool(client, 'task_create', { title: 'Ordinary' });
      assert.equal(next.id, 'T-001');
    });
  } finally {
    cleanup(root);
  }
});

test('task_claim with the same idempotency key returns the same claim', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const created = await callTool(client, 'task_create', { title: 'Work' });
      const first = await callTool(client, 'task_claim', {
        id: String(created.id),
        agent: 'agent-a',
        idempotency_key: 'claim-1',
      });
      assert.equal(first.claimed, true);
      const expiresAt = (first.claim as Record<string, unknown>)['lease_expires_at'];

      const second = await callTool(client, 'task_claim', {
        id: String(created.id),
        agent: 'agent-a',
        idempotency_key: 'claim-1',
      });
      assert.equal(second.duplicate, true);
      assert.equal((second.claim as Record<string, unknown>)['lease_expires_at'], expiresAt);
    });
  } finally {
    cleanup(root);
  }
});

test('the keyed task id is stable for the same key', () => {
  assert.equal(taskIdForKey('abc'), taskIdForKey('abc'));
  assert.notEqual(taskIdForKey('abc'), taskIdForKey('abd'));
  // The id matches the board's id pattern.
  assert.match(taskIdForKey('abc'), /^T-\d{3,}$/);
});

// ==========================================================================
// git_combine
// ==========================================================================

test('git_combine reports two branches that combine cleanly', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
      writeFileSync(join(root, 'feature.txt'), 'x\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add the feature file'], { cwd: root });
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });

      const result = await callTool(client, 'git_combine', { branches: ['main', 'feature'] });
      assert.equal(result.combined, true);
      assert.deepEqual(result.conflicts, []);
      // Nothing was merged.
      const status = await callTool(client, 'git_status');
      assert.equal(status.branch, 'main');
    });
  } finally {
    cleanup(root);
  }
});

test('git_combine reports the conflicting paths', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      // Two branches change the same line of the same file.
      for (const branch of ['a', 'b']) {
        execFileSync('git', ['checkout', '-q', '-b', branch, 'main'], { cwd: root });
        writeFileSync(join(root, 'conflict.txt'), `from ${branch}\n`, 'utf-8');
        execFileSync('git', ['add', 'conflict.txt'], { cwd: root });
        execFileSync('git', ['commit', '-q', '-m', `feat: change it from ${branch}`], { cwd: root });
      }
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });

      const result = await callTool(client, 'git_combine', { branches: ['main', 'a', 'b'] });
      assert.equal(result.combined, false);
      assert.ok((result.conflicts as string[]).includes('conflict.txt'));
    });
  } finally {
    cleanup(root);
  }
});

test('git_combine refuses a single branch', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_combine', { branches: ['main'] });
      assert.equal(result.gated, true);
      assert.equal(result.gate, 'PR-52');
    });
  } finally {
    cleanup(root);
  }
});

test('git_combine leaves the working tree alone', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
      writeFileSync(join(root, 'feature.txt'), 'x\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add the feature file'], { cwd: root });
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });

      await callTool(client, 'git_combine', { branches: ['main', 'feature'] });
      const status = await callTool(client, 'git_status');
      assert.equal(status.clean, true);
      assert.equal(existsSync(join(root, 'feature.txt')), false);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// git_worktree
// ==========================================================================

test('git_worktree lists the worktrees', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_worktree', { action: 'list' });
      const worktrees = result.worktrees as Array<Record<string, unknown>>;
      assert.equal(worktrees.length, 1);
      assert.equal(worktrees[0]['branch'], 'main');
    });
  } finally {
    cleanup(root);
  }
});

test('git_worktree adds a worktree outside the repository', async () => {
  const { root } = makeProject();
  const sibling = `${root}-wt`;
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['branch', 'feat/work'], { cwd: root });
      const result = await callTool(client, 'git_worktree', {
        action: 'add',
        path: sibling,
        branch: 'feat/work',
      });
      assert.equal(result.applied, true);
      assert.equal(existsSync(join(sibling, '.git')), true);
    });
  } finally {
    cleanup(root);
    cleanup(sibling);
  }
});

test('git_worktree refuses a path inside the repository', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['branch', 'feat/work'], { cwd: root });
      const error = await expectError(client, 'git_worktree', {
        action: 'add',
        path: 'inside-wt',
        branch: 'feat/work',
      });
      assert.match(error, /inside the repository/);
      assert.equal(existsSync(join(root, 'inside-wt')), false);
    });
  } finally {
    cleanup(root);
  }
});

test('git_worktree refuses a removal without a confirmation', async () => {
  const { root } = makeProject();
  const sibling = `${root}-wt`;
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['branch', 'feat/work'], { cwd: root });
      await callTool(client, 'git_worktree', {
        action: 'add',
        path: sibling,
        branch: 'feat/work',
      });

      const held = await callTool(client, 'git_worktree', { action: 'remove', path: sibling });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-53');
      assert.equal(existsSync(sibling), true);

      const removed = await callTool(client, 'git_worktree', {
        action: 'remove',
        path: sibling,
        confirm: true,
      });
      assert.equal(removed.applied, true);
    });
  } finally {
    cleanup(root);
    cleanup(sibling);
  }
});

test('git_worktree lists and removes without a confirmation', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      // A list is not a removal, so it needs no confirmation.
      const result = await callTool(client, 'git_worktree', { action: 'list' });
      assert.equal(result.applied, undefined);
      assert.equal(result.count, 1);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// git_operate cherry-pick
// ==========================================================================

test('git_operate cherry-pick applies a commit', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
      writeFileSync(join(root, 'feature.txt'), 'x\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add the feature file'], { cwd: root });
      const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });

      const result = await callTool(client, 'git_operate', {
        operation: 'cherry-pick',
        args: { commit: hash },
      });
      assert.equal(result.applied, true);
      assert.equal(existsSync(join(root, 'feature.txt')), true);
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate cherry-pick is held on a dirty tree', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
      writeFileSync(join(root, 'feature.txt'), 'x\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add the feature file'], { cwd: root });
      const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });
      writeFileSync(join(root, 'dirty.txt'), 'uncommitted\n', 'utf-8');

      const result = await callTool(client, 'git_operate', {
        operation: 'cherry-pick',
        args: { commit: hash },
      });
      assert.equal(result.gated, true);
      assert.equal(result.gate, 'PR-49');
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The rules that had no evidence case
//
// PR-15 (push) and PR-18 (merge) had no case in `evidencePresent`, so
// they fell through to the default of `false` -- and the default of
// `false` makes a conditional rule permanently unsatisfiable. Every
// push and every merge was held, forever, with no way past.
//
// The refusal-path tests did not catch it, because a rule that always
// holds also always refuses. Only a test that asks whether the rule
// *can* be satisfied finds it.
// ==========================================================================

test('git_operate pushes a feature branch', async () => {
  const root = tempDir('orchestrator-push-');
  makeRepo(root, { remote: true });
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
      writeFileSync(join(root, 'feature.txt'), 'x\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add the feature file'], { cwd: root });

      const result = await callTool(client, 'git_operate', {
        operation: 'push',
        args: { branch: 'feature', remote: 'origin' },
      });
      assert.equal(result.applied, true);
      assert.equal(result.status, 'ok');
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate merges a branch', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
      writeFileSync(join(root, 'feature.txt'), 'x\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add the feature file'], { cwd: root });
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });

      const result = await callTool(client, 'git_operate', {
        operation: 'merge',
        args: { source: 'feature', strategy: 'merge' },
      });
      assert.equal(result.applied, true);
      // The merge actually happened.
      assert.equal(existsSync(join(root, 'feature.txt')), true);
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate resets with a permitted mode', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      writeFileSync(join(root, 'new.txt'), 'hello\n', 'utf-8');
      execFileSync('git', ['add', 'new.txt'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add a file'], { cwd: root });

      const result = await callTool(client, 'git_operate', {
        operation: 'reset',
        args: { mode: 'soft', target: 'HEAD~1' },
        confirm: true,
      });
      assert.equal(result.applied, true);
    });
  } finally {
    cleanup(root);
  }
});
