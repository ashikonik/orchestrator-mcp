/**
 * The PR-54 gate: "done" means verified, not merely committed.
 *
 * PR-3 asks whether the task's branch has a commit the base does not.
 * PR-54 asks the harder question: has that work been *checked*? The
 * answer comes from the verifier's run records -- files under
 * `<repo>/.verifier/runs/` whose digest is re-checked on every read, so
 * a record edited after the fact does not open the gate.
 *
 * These tests drive the real server over an in-memory transport, in a
 * real git repository with a real branch and a real run record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool, cleanup, connectClient, makeRepo, tempDir } from './helpers.js';

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

async function withClient(root: string, body: (client: Client) => Promise<void>): Promise<void> {
  const { client, server } = await connectClient();
  try {
    await withEnv({ ORCHESTRATOR_ROOT: root }, () => body(client));
  } finally {
    await client.close();
    await server.close();
  }
}

/** Run git in the fixture repository. */
function git(dir: string, argv: string[]): string {
  return execFileSync('git', argv, {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Orchestrator Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Orchestrator Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: dir,
    },
  });
}

/**
 * A repository with a feature branch that has one commit ahead of main.
 *
 * The branch exists so the PR-3 gate opens: a task on `main` compares
 * `main..main`, which is empty, and never opens. The branch tip is the
 * commit the verifier's record is looked up by.
 */
function makeBranchRepo(dir: string): { root: string; board: string; tip: string } {
  makeRepo(dir);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(dir, 'work.txt'), 'work\n', 'utf-8');
  git(dir, ['add', 'work.txt']);
  git(dir, ['commit', '-q', '-m', 'feat: work']);
  const tip = git(dir, ['rev-parse', 'HEAD']).trim();
  return { root: dir, board: join(dir, '.orchestrator', 'board.json'), tip };
}

/**
 * The fields the digest covers, and the order they are serialised in.
 *
 * Written out here rather than imported: the orchestrator and the
 * verifier are separate programs, and the digest is the contract
 * between them. The verifier sorts the keys; this list is already
 * sorted, and is the same list it uses.
 */
const DIGEST_FIELDS = [
  'argv',
  'branch',
  'check',
  'commit',
  'exit_code',
  'output',
  'output_truncated',
  'passed',
  'root',
  'signal',
  'source',
  'touched',
] as const;

/** The digest of a record's content, the way the verifier computes it. */
function digestOf(record: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {};
  for (const field of DIGEST_FIELDS) payload[field] = record[field];
  return createHash('sha256')
    .update(JSON.stringify(payload, DIGEST_FIELDS.slice().sort()), 'utf-8')
    .digest('hex');
}

/**
 * Write a verifier run record for a commit.
 *
 * The record is shaped exactly as the verifier writes it, so the
 * orchestrator's reader -- which depends on the record *format* and
 * not on the verifier being installed -- can read it.
 */
function writeRunRecord(
  root: string,
  opts: { commit: string; passed?: boolean; id?: string },
): string {
  const dir = join(root, '.verifier', 'runs');
  mkdirSync(dir, { recursive: true });
  const passed = opts.passed ?? true;
  const record: Record<string, unknown> = {
    id: opts.id ?? '20261107T142210Z-abcdef01',
    check: 'test',
    argv: ['npm', 'test'],
    passed,
    exit_code: passed ? 0 : 1,
    signal: null,
    output: passed ? 'all tests passed' : 'the tests failed',
    output_truncated: false,
    touched: [],
    commit: opts.commit,
    branch: 'feature',
    root,
    source: 'package.json',
    started_at: '2026-11-07T14:22:10Z',
  };
  record['digest'] = digestOf(record);
  const path = join(dir, `${record['id']}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
  return path;
}

// ==========================================================================
// The policy rule
// ==========================================================================

test('PR-54 holds a completion with no run record and names the evidence', async () => {
  const { root, board } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const before = readFileSync(board, 'utf-8');
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-54');
      assert.equal(typeof held.reason, 'string');
      assert.equal(typeof held.hint, 'string');
      // Nothing was written.
      assert.equal(readFileSync(board, 'utf-8'), before);
    });
  } finally {
    cleanup(root);
  }
});

test('PR-54 opens when a passing run record exists for the branch tip', async () => {
  const { root, board, tip } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    writeRunRecord(root, { commit: tip });
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const moved = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(moved.gated, undefined);
      assert.equal(moved.applied, true);
      const written = JSON.parse(readFileSync(board, 'utf-8'));
      assert.equal(written.tasks[0].state, 'done');
    });
  } finally {
    cleanup(root);
  }
});

test('a failing run record does not open the gate', async () => {
  const { root, board, tip } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    writeRunRecord(root, { commit: tip, passed: false });
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const before = readFileSync(board, 'utf-8');
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-54');
      assert.equal(readFileSync(board, 'utf-8'), before);
    });
  } finally {
    cleanup(root);
  }
});

test('a run record for a different commit does not open the gate', async () => {
  const { root, board } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    // A record for some other commit is evidence about different code.
    writeRunRecord(root, { commit: '0'.repeat(40) });
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-54');
    });
  } finally {
    cleanup(root);
  }
});

test('a run record whose digest was broken does not open the gate', async () => {
  const { root, board, tip } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    const path = writeRunRecord(root, { commit: tip });
    // Edit the record after the fact: the content says the check
    // passed, but the digest no longer matches it.
    const record = JSON.parse(readFileSync(path, 'utf-8'));
    record['passed'] = true;
    record['exit_code'] = 0;
    record['output'] = 'edited after the fact';
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');

    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(held.gated, true);
      assert.equal(held.gate, 'PR-54');
    });
  } finally {
    cleanup(root);
  }
});

test('the refusal says why the gate held', async () => {
  const { root } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(held.gate, 'PR-54');
      // "there is no run record" and "the check failed" are different
      // problems, so the reason distinguishes them.
      assert.match(String(held.verify_reason), /No run record/i);
    });
  } finally {
    cleanup(root);
  }
});

test('a failing check is reported as a failure, not as a missing record', async () => {
  const { root, tip } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    writeRunRecord(root, { commit: tip, passed: false });
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(held.gate, 'PR-54');
      assert.match(String(held.verify_reason), /did not pass/i);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The gate sits beside PR-3, not in place of it
// ==========================================================================

test('PR-3 still holds a completion with no commit', async () => {
  const root = tempDir('orchestrator-verify-');
  try {
    makeRepo(root);
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'main' });
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      assert.equal(held.gated, true);
      // PR-3 comes first in the table, and its absence is the more
      // basic failure: there is nothing to verify.
      assert.equal(held.gate, 'PR-3');
    });
  } finally {
    cleanup(root);
  }
});

test('a commit without a run record is held by PR-54, not PR-3', async () => {
  const { root } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      // The commit is there, so PR-3 is satisfied; PR-54 is what holds.
      assert.equal(held.gate, 'PR-54');
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The gate is a door, not a wall
// ==========================================================================

test('a repository may opt out by tightening PR-54 to deny', async () => {
  const { root, tip } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    writeRunRecord(root, { commit: tip });
    const policyDir = join(root, '.orchestrator');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'policy.json'),
      JSON.stringify({
        schema_version: 1,
        default_branch: 'main',
        protected_branches: ['main'],
        allowed_merge_strategies: ['merge', 'rebase'],
        commit_message_pattern: '^(feat|fix|chore): .+',
        deny: ['PR-54'],
      }),
      'utf-8',
    );

    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      const held = await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
      // PR-54 is now a wall: the completion is denied, not held.
      assert.equal(held.denied, true);
      assert.equal(held.rule, 'PR-54');
    });
  } finally {
    cleanup(root);
  }
});

test('the run records directory is not created when there is nothing to verify', async () => {
  const { root } = makeBranchRepo(tempDir('orchestrator-verify-'));
  try {
    await withClient(root, async (client) => {
      await callTool(client, 'task_create', { title: 'One', state: 'in_progress', branch: 'feature' });
      await callTool(client, 'task_move', { id: 'T-001', to: 'done' });
    });
    assert.equal(existsSync(join(root, '.verifier')), false);
  } finally {
    cleanup(root);
  }
});
