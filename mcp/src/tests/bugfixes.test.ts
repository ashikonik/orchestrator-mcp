/**
 * The regression tests for the defects the survey turned up.
 *
 * Each of these is a bug that was found by reading the code and
 * confirmed against the running server. They are here so the fix cannot
 * silently regress: every one of them failed before the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool, cleanup, connectClient, expectError, makeRepo, tempDir } from './helpers.js';
import { buildDiff, buildDiffStat, buildLog, buildMergeTree, parseMergeTree } from '../git.js';
import { evaluate } from '../policy.js';

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
  const root = tempDir('orchestrator-bugfix-');
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

// ==========================================================================
// B2 -- git_diff's stat ignored every mode
// ==========================================================================

test('the stat builder follows the mode of the diff it accompanies', () => {
  // The staged stat and the worktree stat are different commands.
  assert.deepEqual(buildDiffStat({ staged: true }), ['diff', '--no-color', '--cached', '--stat']);
  assert.deepEqual(buildDiffStat({}), ['diff', '--no-color', '--stat']);
  assert.deepEqual(buildDiffStat({ base: 'main', head: 'feat' }), [
    'diff',
    '--no-color',
    'main..feat',
    '--stat',
  ]);
  assert.deepEqual(buildDiffStat({ path: 'src/a.ts' }), [
    'diff',
    '--no-color',
    '--',
    'src/a.ts',
    '--stat',
  ]);
});

test('git_diff with staged and stat reports the staged stat', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      writeFileSync(join(root, 'staged.txt'), 'staged\n', 'utf-8');
      writeFileSync(join(root, 'unstaged.txt'), 'unstaged\n', 'utf-8');
      execFileSync('git', ['add', 'staged.txt'], { cwd: root });

      const result = await callTool(client, 'git_diff', { staged: true, stat: true });
      const stat = String(result.stat ?? '');
      assert.ok(stat.includes('staged.txt'), `the stat should name the staged file: ${stat}`);
      assert.ok(!stat.includes('unstaged.txt'), `the stat should not name the unstaged file: ${stat}`);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// B3 -- git_log ignored since and until, and misplaced branch
// ==========================================================================

test('the log builder puts the revision before the path separator', () => {
  const argv = buildLog({ limit: 5, path: 'src/a.ts', branch: 'main' });
  const sep = argv.indexOf('--');
  assert.ok(sep > 0, 'the separator should be present');
  // The branch has to come before the separator, or git reads it as
  // the name of a file to look at.
  assert.ok(argv.indexOf('main') < sep, `the branch should precede the separator: ${argv.join(' ')}`);
  assert.equal(argv[sep + 1], 'src/a.ts');
});

test('the log builder emits the since and until filters', () => {
  const argv = buildLog({ limit: 5, since: '2026-01-01', until: '2026-12-31' });
  assert.ok(argv.includes('--since'));
  assert.ok(argv.includes('2026-01-01'));
  assert.ok(argv.includes('--until'));
  assert.ok(argv.includes('2026-12-31'));
});

test('git_log with since filters the commits by date', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const all = await callTool(client, 'git_log', { limit: 50 });
      const total = (all.commits as unknown[])?.length ?? 0;
      assert.ok(total > 0);

      // A window that ends before the fixture's commit excludes it.
      const none = await callTool(client, 'git_log', { limit: 50, since: '2030-01-01' });
      assert.equal((none.commits as unknown[])?.length, 0);

      // A window that starts before it includes it.
      const some = await callTool(client, 'git_log', { limit: 50, since: '2000-01-01' });
      assert.equal((some.commits as unknown[])?.length, total);
    });
  } finally {
    cleanup(root);
  }
});

test('git_log with a branch and a path filters by revision and by path', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
      writeFileSync(join(root, 'feature.txt'), 'x\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: add the feature file'], { cwd: root });

      // The branch is the revision, and the path is a path -- not a
      // file named after the branch.
      const result = await callTool(client, 'git_log', { branch: 'feature', path: 'feature.txt' });
      const commits = (result.commits as Array<Record<string, unknown>>) ?? [];
      assert.equal(commits.length, 1);
      assert.equal(commits[0]['subject'], 'feat: add the feature file');

      // A path that was never committed yields nothing, which is what
      // a path filter does -- not an error about a missing revision.
      const other = await callTool(client, 'git_log', { branch: 'feature', path: 'never-committed.txt' });
      assert.equal((other.commits as unknown[])?.length, 0);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// B1 -- board_set wrote fields the next read destroyed
// ==========================================================================

test('board_set refuses a board with an unknown field', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'board_set', {
        board: {
          schema_version: 1,
          project: 'demo',
          updated_at: '2026-11-07T00:00:00Z',
          tasks: [
            {
              id: 'T-001',
              title: 'A task',
              body: '',
              state: 'todo',
              labels: [],
              assignee: null,
              blocked_by: [],
              branch: null,
              created_at: '2026-11-07T00:00:00Z',
              updated_at: '2026-11-07T00:00:00Z',
              history: [],
              BOGUS_FIELD: 'should not survive',
            },
          ],
        },
      });
      assert.equal(result.applied, false);
      assert.ok(typeof result.error === 'string');
      // Nothing was written.
      assert.equal(existsSync(board), false);
    });
  } finally {
    cleanup(root);
  }
});

test('board_set writes a board that reads back unchanged', async () => {
  const { root, board } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'board_set', {
        board: {
          schema_version: 1,
          project: 'demo',
          updated_at: '2026-11-07T00:00:00Z',
          tasks: [
            {
              id: 'T-001',
              title: 'A task',
              body: 'the body',
              state: 'todo',
              labels: ['one'],
              assignee: 'someone',
              blocked_by: [],
              branch: 'feat/x',
              created_at: '2026-11-07T00:00:00Z',
              updated_at: '2026-11-07T00:00:00Z',
              history: [],
            },
          ],
        },
      });
      assert.equal(result.applied, true);
      assert.equal(result.tasks_written, 1);

      const read = await callTool(client, 'board_get');
      const tasks = (read.tasks as Array<Record<string, unknown>>) ?? [];
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]['title'], 'A task');
      assert.equal(tasks[0]['body'], 'the body');
      assert.deepEqual(tasks[0]['labels'], ['one']);
      assert.equal(tasks[0]['assignee'], 'someone');
      assert.equal(tasks[0]['branch'], 'feat/x');

      // The file on disk is what was written, not a stripped version.
      const onDisk = JSON.parse(readFileSync(board, 'utf-8')) as Record<string, unknown>;
      assert.ok(onDisk['tasks']);
    });
  } finally {
    cleanup(root);
  }
});

test('board_set honours the project argument', async () => {
  const { root } = makeProject();
  try {
    const other = tempDir('orchestrator-other-');
    makeRepo(other);
    try {
      await withEnv({ ORCHESTRATOR_ROOT: root }, async () => {
        const { client, server } = await connectClient();
        try {
          const result = await callTool(client, 'board_set', {
            project: other,
            board: {
              schema_version: 1,
              project: 'demo',
              updated_at: '2026-11-07T00:00:00Z',
              tasks: [],
            },
          });
          assert.equal(result.applied, true);
          assert.equal(result.board_path, join(other, '.orchestrator', 'board.json'));
        } finally {
          await client.close();
          await server.close();
        }
      });
    } finally {
      cleanup(other);
    }
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The PR-9 trap -- evaluating git.commit unconditionally holds every commit
// ==========================================================================

test('an ordinary commit is not held by the untracked-files rule', () => {
  // PR-10's evidence IS `include_untracked`. Evaluating the commit
  // operation without it holds every ordinary commit, which is the
  // trap this split avoids.
  const decision = evaluate('git.commit', { message: 'feat: x' });
  assert.equal(decision.verdict, 'conditional');
  assert.equal(decision.satisfied, false);
  assert.equal(decision.rule, 'PR-10');

  // With the evidence, the same operation passes.
  const withEvidence = evaluate('git.commit', { message: 'feat: x', include_untracked: true });
  assert.equal(withEvidence.satisfied, true);
});

test('the message rule is separate from the untracked-files rule', () => {
  const pattern = '^(feat|fix|docs|refactor|test|chore|build|ci)(\\(.+\\))?: .+';
  const bad = evaluate('git.commit.message', {
    message: 'no prefix here',
    args: { message_pattern: pattern },
  });
  assert.equal(bad.satisfied, false);
  assert.equal(bad.rule, 'PR-9');

  // The commit operation itself knows nothing about the message
  // pattern -- that is the other scope's business.
  const commit = evaluate('git.commit', { include_untracked: true });
  assert.equal(commit.satisfied, true);
});

// ==========================================================================
// B5 -- git_operate accepted unknown argument keys
// ==========================================================================

test('git_operate refuses an argument key the operation does not take', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const error = await expectError(client, 'git_operate', {
        operation: 'branch',
        args: { action: 'create', name: 'feat/x', typo: 'oops' },
        dry_run: true,
      });
      assert.match(error, /typo/);
    });
  } finally {
    cleanup(root);
  }
});

test('git_operate still accepts the keys its operations do take', async () => {
  const { root } = makeProject();
  try {
    await withClient(root, async (client) => {
      const result = await callTool(client, 'git_operate', {
        operation: 'branch',
        args: { action: 'create', name: 'feat/x' },
        dry_run: true,
      });
      assert.equal(result.dry_run, true);
      assert.deepEqual(result.argv, ['git', 'branch', 'feat/x']);
    });
  } finally {
    cleanup(root);
  }
});

// ==========================================================================
// The merge-tree parser -- the combined-branch check's foundation
// ==========================================================================

test('the merge-tree parser reads a clean merge', () => {
  const result = parseMergeTree('a1b2c3d4e5f6\n');
  assert.equal(result.clean, true);
  assert.equal(result.tree, 'a1b2c3d4e5f6');
  assert.deepEqual(result.conflicts, []);
});

test('the merge-tree parser reads a conflict and names the path', () => {
  // The shape git 2.56 writes: the tree, the conflicted stages, a
  // blank line, then the Auto-merging and CONFLICT lines.
  const raw = [
    'a1b2c3d4e5f6',
    '100644 1111111111111111111111111111111111111111 1\tconflict.txt',
    '100644 2222222222222222222222222222222222222222 2\tconflict.txt',
    '100644 3333333333333333333333333333333333333333 3\tconflict.txt',
    '',
    'Auto-merging conflict.txt',
    'CONFLICT (content): Merge conflict in conflict.txt',
    '',
  ].join('\n');
  const result = parseMergeTree(raw);
  assert.equal(result.clean, false);
  assert.equal(result.tree, 'a1b2c3d4e5f6');
  assert.deepEqual(result.conflicts, ['conflict.txt']);
});

test('the merge-tree builder names both branches', () => {
  assert.deepEqual(buildMergeTree('main', 'feature'), [
    'merge-tree',
    '--write-tree',
    'main',
    'feature',
  ]);
});
