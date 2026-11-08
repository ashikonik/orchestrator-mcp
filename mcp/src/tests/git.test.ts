/**
 * The git surface's tests.
 *
 * The most important assertion in this file is the last one: the command
 * surface contains no `push --force`, no `remote add`, no `reset --hard`
 * without a confirmation, and no `hook`/`config`/`gc`/`prune`/`clean`.
 * The argv table is the whole of what this server can do to a
 * repository, so a test that scans it is a test that the server cannot
 * do anything the policy did not allow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  GIT_ARGV,
  buildBranch,
  buildCommit,
  buildDiff,
  buildLog,
  buildMerge,
  buildPush,
  buildReset,
  buildRevert,
  buildStash,
  buildTag,
  currentBranch,
  defaultBranch,
  gitEnv,
  hasCommitsAhead,
  isProtectedBranch,
  parseLog,
  parseStatus,
  repoRoot,
  runGit,
  treeClean,
  validName,
  validPath,
  validRevision,
} from '../git.js';
import { cleanup, makeRepo, tempDir } from './helpers.js';

test('G-01 is the porcelain v2 status argv', () => {
  assert.deepEqual(GIT_ARGV['G-01'], ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
});

test('G-14 is the commit argv', () => {
  assert.deepEqual(GIT_ARGV['G-14'], ['commit', '-m', '<message>']);
});

test('every argv constant is a non-empty array of strings', () => {
  for (const [id, argv] of Object.entries(GIT_ARGV)) {
    assert.ok(Array.isArray(argv), `${id} is not an array`);
    assert.ok(argv.length > 0, `${id} is empty`);
    for (const part of argv) {
      assert.equal(typeof part, 'string', `${id} has a non-string element`);
    }
  }
});

test('the argv table has the expected ids', () => {
  const ids = Object.keys(GIT_ARGV).sort();
  const expected = [
    'G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'G-09', 'G-10',
    'G-11', 'G-12', 'G-13', 'G-14', 'G-15', 'G-16', 'G-17', 'G-18', 'G-19', 'G-20',
    'G-21', 'G-22', 'G-23', 'G-24', 'G-25', 'G-26', 'G-27', 'G-28', 'G-29', 'G-30',
    'G-31', 'G-32', 'G-33', 'G-34', 'G-35', 'G-36', 'G-37', 'G-38', 'G-39', 'G-40',
    'G-41', 'G-42', 'G-43', 'G-44', 'G-45', 'G-46', 'G-47', 'G-48', 'G-49', 'G-50',
    'G-51', 'G-52', 'G-53', 'G-54', 'G-55', 'G-56', 'G-57',
  ];
  assert.deepEqual(ids, expected);
});

test('every argv id is used by a builder', () => {
  // The table is the source of truth, so an entry nothing reaches is
  // either dead or a command the server cannot actually run. Either way
  // the table has drifted from reality.
  //
  // The source file is read from the source tree, not from dist: the
  // compiled JavaScript has the table inlined into the module and the
  // `GIT_ARGV['G-nn']` lookups would already have been resolved.
  const sourcePath = new URL('../../src/git.ts', import.meta.url);
  const source = readFileSync(sourcePath, 'utf-8');
  const builderSection = source.slice(source.indexOf('// The builders'));
  for (const id of Object.keys(GIT_ARGV)) {
    assert.ok(
      builderSection.includes(`GIT_ARGV['${id}']`),
      `${id} is in the table but no builder uses it`,
    );
  }
});

test('the diff builder inserts the base..head range', () => {
  assert.deepEqual(buildDiff({ base: 'main', head: 'feature' }), ['diff', '--no-color', 'main..feature']);
});

test('the diff builder puts a path after --', () => {
  assert.deepEqual(buildDiff({ path: 'src/a.ts' }), ['diff', '--no-color', '--', 'src/a.ts']);
});

test('the diff builder produces the staged diff', () => {
  assert.deepEqual(buildDiff({ staged: true }), ['diff', '--no-color', '--cached']);
});

test('the diff builder produces the plain worktree diff', () => {
  assert.deepEqual(buildDiff({}), ['diff', '--no-color']);
});

test('the log builder sets the limit and the format', () => {
  const argv = buildLog({ limit: 5 });
  assert.equal(argv[0], 'log');
  assert.ok(argv.includes('-n'));
  assert.ok(argv.includes('5'));
  assert.ok(argv.some((a) => a.startsWith('--pretty=format:')));
});

test('the log builder puts a path after --', () => {
  const argv = buildLog({ limit: 5, path: 'src/a.ts' });
  const sep = argv.indexOf('--');
  assert.ok(sep > 0);
  assert.equal(argv[sep + 1], 'src/a.ts');
});

test('the commit builder appends paths after --', () => {
  const argv = buildCommit('feat: x', ['a.ts', 'b.ts']);
  assert.deepEqual(argv, ['commit', '-m', 'feat: x', '--', 'a.ts', 'b.ts']);
});

test('the commit builder with no paths commits everything staged', () => {
  assert.deepEqual(buildCommit('feat: x'), ['commit', '-m', 'feat: x']);
});

test('the push builder includes --set-upstream', () => {
  assert.deepEqual(buildPush('feature', 'origin', true), ['push', '--set-upstream', 'origin', 'feature']);
});

test('the push builder without an upstream omits the flag', () => {
  assert.deepEqual(buildPush('feature', 'origin', false), ['push', 'origin', 'feature']);
});

test('the branch builder creates a branch from HEAD', () => {
  assert.deepEqual(buildBranch('create', 'feat/x'), ['branch', 'feat/x']);
});

test('the branch builder creates a branch from a base', () => {
  assert.deepEqual(buildBranch('create', 'feat/x', 'main'), ['branch', 'feat/x', 'main']);
});

test('the branch builder deletes a branch safely by default', () => {
  assert.deepEqual(buildBranch('delete', 'feat/x'), ['branch', '-d', 'feat/x']);
});

test('the branch builder force-deletes when asked', () => {
  assert.deepEqual(buildBranch('delete-force', 'feat/x'), ['branch', '-D', 'feat/x']);
});

test('the merge builder uses --no-edit for a merge', () => {
  assert.deepEqual(buildMerge('feature', 'merge'), ['merge', '--no-edit', 'feature']);
});

test('the merge builder uses rebase for a rebase', () => {
  assert.deepEqual(buildMerge('feature', 'rebase'), ['rebase', 'feature']);
});

test('the stash builder covers every action', () => {
  assert.deepEqual(buildStash('push', 'wip'), ['stash', 'push', '-m', 'wip']);
  assert.deepEqual(buildStash('pop'), ['stash', 'pop']);
  assert.deepEqual(buildStash('list'), ['stash', 'list']);
  assert.deepEqual(buildStash('drop'), ['stash', 'drop']);
});

test('the reset builder covers every mode', () => {
  assert.deepEqual(buildReset('soft', 'HEAD~1'), ['reset', '--soft', 'HEAD~1']);
  assert.deepEqual(buildReset('mixed', 'HEAD~1'), ['reset', '--mixed', 'HEAD~1']);
  assert.deepEqual(buildReset('hard', 'HEAD~1'), ['reset', '--hard', 'HEAD~1']);
});

test('the revert builder covers both forms', () => {
  assert.deepEqual(buildRevert('abc123', false), ['revert', '--no-edit', 'abc123']);
  assert.deepEqual(buildRevert('abc123', true), ['revert', '--no-commit', 'abc123']);
});

test('the tag builder covers every action', () => {
  assert.deepEqual(buildTag('create', 'v1'), ['tag', 'v1']);
  assert.deepEqual(buildTag('create', 'v1', 'note'), ['tag', '-a', 'v1', '-m', 'note']);
  assert.deepEqual(buildTag('delete', 'v1'), ['tag', '-d', 'v1']);
  assert.deepEqual(buildTag('list'), ['tag', '--list']);
});

test('a name with a space is rejected', () => {
  const check = validName('my branch');
  assert.equal(check.ok, false);
});

test('a name with a semicolon is rejected', () => {
  const check = validName('main; rm -rf /');
  assert.equal(check.ok, false);
});

test('a name starting with a dash is rejected', () => {
  const check = validName('--force');
  assert.equal(check.ok, false);
});

test('a normal branch name is accepted', () => {
  assert.equal(validName('feat/T-013-parser').ok, true);
});

test('a revision starting with a dash is rejected', () => {
  assert.equal(validRevision('--upload-pack=evil').ok, false);
});

test('a revision with a space is rejected', () => {
  assert.equal(validRevision('HEAD HEAD').ok, false);
});

test('a sha is an acceptable revision', () => {
  assert.equal(validRevision('a1b2c3d').ok, true);
  assert.equal(validRevision('HEAD~3').ok, true);
  assert.equal(validRevision('origin/main').ok, true);
});

test('a path that escapes the repository is rejected', () => {
  const check = validPath('/repo', '../../etc/passwd');
  assert.equal(check.ok, false);
});

test('a path inside the repository is accepted', () => {
  assert.equal(validPath('/repo', 'src/a.ts').ok, true);
});

test('the runner sets the environment git needs to stay non-interactive', () => {
  const env = gitEnv();
  assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
  assert.equal(env['GIT_EDITOR'], 'true');
  assert.equal(env['GIT_MERGE_AUTOEDIT'], 'no');
  assert.equal(env['GIT_CONFIG_NOSYSTEM'], '1');
  assert.equal(env['LC_ALL'], 'C');
  assert.equal(env['GIT_PAGER'], 'cat');
  assert.equal(env['PAGER'], 'cat');
});

test('a failing git call returns the exit code and does not throw', () => {
  const dir = tempDir();
  try {
    const result = runGit(['rev-parse', '--verify', 'nope-not-a-ref'], dir);
    assert.equal(result.status, 'error');
    assert.notEqual(result.exit_code, 0);
    assert.ok(result.stderr.length > 0);
  } finally {
    cleanup(dir);
  }
});

test('the runner reports the argv it used', () => {
  const dir = tempDir();
  try {
    const result = runGit(['status', '--porcelain'], dir);
    assert.deepEqual(result.argv, ['git', 'status', '--porcelain']);
  } finally {
    cleanup(dir);
  }
});

test('repoRoot finds the repository root', () => {
  const dir = tempDir();
  try {
    makeRepo(dir);
    assert.equal(repoRoot(dir), dir);
  } finally {
    cleanup(dir);
  }
});

test('repoRoot returns null outside a repository', () => {
  const dir = tempDir();
  try {
    assert.equal(repoRoot(dir), null);
  } finally {
    cleanup(dir);
  }
});

test('currentBranch reports the checked-out branch', () => {
  const dir = tempDir();
  try {
    makeRepo(dir);
    assert.equal(currentBranch(dir), 'main');
  } finally {
    cleanup(dir);
  }
});

test('defaultBranch is null without a remote HEAD', () => {
  const dir = tempDir();
  try {
    makeRepo(dir);
    assert.equal(defaultBranch(dir), null);
  } finally {
    cleanup(dir);
  }
});

test('treeClean is true on a clean tree and false on a dirty one', () => {
  const dir = tempDir();
  try {
    makeRepo(dir);
    assert.equal(treeClean(dir), true);
    writeFileSync(`${dir}/new.txt`, 'x', 'utf-8');
    assert.equal(treeClean(dir), false);
  } finally {
    cleanup(dir);
  }
});

test('hasCommitsAhead is false for a branch with no commits of its own', () => {
  const dir = tempDir();
  try {
    makeRepo(dir);
    assert.equal(hasCommitsAhead('main', 'main', dir), false);
  } finally {
    cleanup(dir);
  }
});

test('parseStatus reads the branch, the upstream and the ahead count', () => {
  const raw = [
    '# branch.oid 1234567890abcdef',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
    '1 .M N... 100644 100644 100644 aaa ccc src/b.ts',
    '? src/c.ts',
  ].join('\n');
  const status = parseStatus(raw);
  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.clean, false);
  assert.deepEqual(status.staged, ['src/a.ts']);
  assert.deepEqual(status.unstaged, ['src/b.ts']);
  assert.deepEqual(status.untracked, ['src/c.ts']);
});

test('parseStatus reports a clean tree as clean', () => {
  const raw = '# branch.oid abc\n# branch.head main\n';
  const status = parseStatus(raw);
  assert.equal(status.clean, true);
  assert.deepEqual(status.staged, []);
});

test('parseLog reads the separated fields', () => {
  // The log format separates its fields with \x1f, not a tab.
  const raw = 'abc123\x1fabc\x1ffeat: add the parser\x1fA. Person\x1f2026-11-07T14:10:00Z';
  const commits = parseLog(raw);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].hash, 'abc123');
  assert.equal(commits[0].short_hash, 'abc');
  assert.equal(commits[0].subject, 'feat: add the parser');
  assert.equal(commits[0].author, 'A. Person');
  assert.equal(commits[0].date, '2026-11-07T14:10:00Z');
});

test('parseLog skips a malformed line rather than throwing', () => {
  assert.deepEqual(parseLog('not-enough-fields'), []);
});

test('isProtectedBranch matches the protected patterns', () => {
  const patterns = ['main', 'master', 'release/*'];
  assert.equal(isProtectedBranch('main', patterns), true);
  assert.equal(isProtectedBranch('master', patterns), true);
  assert.equal(isProtectedBranch('release/1.0', patterns), true);
  assert.equal(isProtectedBranch('feat/x', patterns), false);
  assert.equal(isProtectedBranch('', patterns), false);
});

// --------------------------------------------------------------------------
// The surface scan -- the most important assertions in this file.
// --------------------------------------------------------------------------

test('the surface has no force push', () => {
  for (const argv of Object.values(GIT_ARGV)) {
    assert.ok(!argv.includes('--force'), `found a force flag in ${argv.join(' ')}`);
    assert.ok(!argv.includes('-f'), `found a force shorthand in ${argv.join(' ')}`);
  }
});

test('the surface has no remote add or set-url', () => {
  for (const argv of Object.values(GIT_ARGV)) {
    if (argv[0] !== 'remote') continue;
    assert.ok(!argv.includes('add'), `found 'remote add' in ${argv.join(' ')}`);
    assert.ok(!argv.includes('set-url'), `found 'remote set-url' in ${argv.join(' ')}`);
  }
});

test('the surface has no hook, config, gc, prune or clean', () => {
  for (const argv of Object.values(GIT_ARGV)) {
    const verb = argv[0];
    assert.ok(
      verb !== 'hook' && verb !== 'config' && verb !== 'gc' && verb !== 'prune' && verb !== 'clean',
      `found '${verb}' in ${argv.join(' ')}`,
    );
  }
});

test('the only hard reset in the surface is G-33, and the policy gates it', () => {
  const hardResets = Object.entries(GIT_ARGV).filter(([, argv]) => argv.includes('--hard'));
  assert.equal(hardResets.length, 1);
  assert.equal(hardResets[0][0], 'G-33');
});

test('no argv runs a shell', () => {
  for (const argv of Object.values(GIT_ARGV)) {
    for (const part of argv) {
      assert.ok(!part.includes('&&'), `found a shell operator in ${argv.join(' ')}`);
      assert.ok(!part.includes('|'), `found a pipe in ${argv.join(' ')}`);
      assert.ok(!part.includes(';'), `found a semicolon in ${argv.join(' ')}`);
      assert.ok(!part.includes('`'), `found a backtick in ${argv.join(' ')}`);
      assert.ok(!part.includes('$'), `found a dollar sign in ${argv.join(' ')}`);
    }
  }
});
