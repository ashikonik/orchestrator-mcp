/**
 * The git command surface.
 *
 * Every git operation the server can perform is an argv array in this
 * file. There is no pass-through `git` tool and no way to run an
 * arbitrary argv: the surface is fixed, and the policy layer decides
 * which of these may run.
 *
 * The file splits in two:
 *
 *  - **The argv constants** (`G-01` ... `G-52`). These are the whole
 *    surface, written out. They are data so that the tests can assert on
 *    them exactly, and so that a reader can see the entire set of things
 *    this server is capable of doing to a repository.
 *  - **The builders and the runner.** A builder turns typed arguments
 *    into an argv; the runner is the only code that spawns a process.
 *    Keeping the spawn in one place is what makes the surface testable
 *    without a repository.
 *
 * The table is the *source of truth*, not a catalogue. Every builder
 * looks its argv up in the table and substitutes the placeholders, so
 * there is exactly one place where a command is written down. A builder
 * that re-declared its argv as a literal would let the table drift away
 * from what actually runs -- which is what happened before, and why the
 * test `every argv id is used by a builder` exists.
 *
 * There is never a shell. Every value is a separate element of the argv
 * array, so a branch named `; rm -rf ~` is a (rejected) branch name and
 * never a command.
 */
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { GitResult } from './types.js';

/** The default per-call timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

// --------------------------------------------------------------------------
// The argv surface
// --------------------------------------------------------------------------

/**
 * The complete set of git invocations.
 *
 * Written literally rather than assembled from parts, so that reading this
 * table tells you exactly what runs -- and so that a test can assert the
 * absence of the dangerous ones.
 *
 * A `<placeholder>` is a slot for a value the caller supplies. The
 * builders below fill the slots and drop any that are left empty, so a
 * builder never passes a literal `<placeholder>` to git.
 */
export const GIT_ARGV = {
  // --- reading ------------------------------------------------------------
  'G-01': ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
  'G-02': ['status', '--porcelain'],
  'G-03': ['diff', '--no-color'],
  'G-04': ['diff', '--no-color', '--cached'],
  'G-05': ['diff', '--no-color', '<range>'],
  'G-06': ['diff', '--no-color', '--', '<path>'],
  'G-07': ['diff', '--no-color', '--stat'],
  'G-08': [
    'log',
    '--no-color',
    '-n',
    '<limit>',
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI',
  ],
  'G-09': [
    'log',
    '--no-color',
    '-n',
    '<limit>',
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI',
    '--',
    '<path>',
  ],
  'G-10': [
    'log',
    '--no-color',
    '-n',
    '<limit>',
    '--grep',
    '<grep>',
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI',
  ],
  'G-11': ['rev-parse', '--show-toplevel'],
  'G-12': ['rev-parse', '--abbrev-ref', 'HEAD'],
  'G-13': ['symbolic-ref', '--quiet', 'refs/remotes/<remote>/HEAD'],
  'G-44': ['log', '--oneline', '<range>'],
  'G-45': ['rev-list', '--left-right', '--count', '<divergence>'],

  // --- committing ---------------------------------------------------------
  'G-14': ['commit', '-m', '<message>'],
  'G-15': ['commit', '-m', '<message>', '--', '<path>'],
  'G-16': ['add', '--', '<path>'],

  // --- branches -----------------------------------------------------------
  'G-17': ['branch', '<name>'],
  'G-18': ['branch', '<name>', '<from>'],
  'G-19': ['branch', '-d', '<name>'],
  'G-20': ['branch', '-D', '<name>'],
  'G-21': ['branch', '--list'],
  'G-22': ['checkout', '<name>'],

  // --- pushing ------------------------------------------------------------
  'G-23': ['push', '--set-upstream', '<remote>', '<branch>'],
  'G-24': ['push', '<remote>', '<branch>'],

  // --- merging ------------------------------------------------------------
  'G-25': ['merge', '--no-edit', '<source>'],
  'G-26': ['rebase', '<source>'],

  // --- stashing -----------------------------------------------------------
  'G-27': ['stash', 'push', '-m', '<message>'],
  'G-28': ['stash', 'pop'],
  'G-29': ['stash', 'list'],
  'G-30': ['stash', 'drop'],

  // --- resetting ----------------------------------------------------------
  'G-31': ['reset', '--soft', '<target>'],
  'G-32': ['reset', '--mixed', '<target>'],
  'G-33': ['reset', '--hard', '<target>'],

  // --- reverting ----------------------------------------------------------
  'G-34': ['revert', '--no-edit', '<commit>'],
  'G-35': ['revert', '--no-commit', '<commit>'],

  // --- tagging ------------------------------------------------------------
  'G-36': ['tag', '<name>'],
  'G-37': ['tag', '-a', '<name>', '-m', '<message>'],
  'G-38': ['tag', '-d', '<name>'],
  'G-39': ['tag', '--list'],

  // --- remotes ------------------------------------------------------------
  'G-40': ['remote', '-v'],
  'G-41': ['remote', 'show', '<name>'],
  'G-42': ['fetch', '<remote>'],
  'G-43': ['pull', '--ff-only', '<remote>', '<branch>'],

  // --- worktrees ----------------------------------------------------------
  // `worktree add` and `worktree remove` are the two that change
  // anything. `list` and `prune` only read and clean up.
  'G-46': ['worktree', 'add', '<path>', '<branch>'],
  'G-47': ['worktree', 'list', '--porcelain'],
  'G-48': ['worktree', 'remove', '<path>'],
  'G-49': ['worktree', 'prune'],

  // --- combined-branch verification --------------------------------------
  // `merge-tree --write-tree` computes the merge without touching the
  // index or the working tree. It writes a dangling tree object and
  // nothing else. Requires git 2.38 or newer.
  'G-50': ['merge-tree', '--write-tree', '<branch>', '<other>'],

  // --- cherry-picking -----------------------------------------------------
  'G-51': ['cherry-pick', '<commit>'],

  // --- reading one revision ----------------------------------------------
  'G-52': ['show', '--no-color', '--stat', '<commit>'],

  // --- the staged file list and the current commit ------------------------
  'G-53': ['diff', '--no-color', '--cached', '--name-only'],
  'G-54': ['rev-parse', '--short', 'HEAD'],
  'G-55': ['branch', '--merged', '<base>'],
  'G-56': [
    'log',
    '--no-color',
    '-n',
    '<limit>',
    '--pretty=format:%H%x1f%s',
    '<range>',
  ],

  // --- turning a merged tree back into a commit ---------------------------
  // `merge-tree --write-tree` refuses a tree where a commit is expected,
  // so combining three or more branches needs the merged tree wrapped
  // in a commit before it can be merged with the next branch.
  'G-57': ['commit-tree', '<tree>', '-p', '<parent>', '-m', '<message>'],
} satisfies Record<string, readonly string[]>;

/**
 * Fill a table entry's placeholders.
 *
 * The values are substituted **positionally**: the first `<slot>` takes
 * the first value, the second `<slot>` takes the second, and so on. A
 * slot with no value is dropped.
 *
 * A value that is itself an array replaces the slot with all of its
 * elements, so `<path>` can stand for one path or many.
 */
export function fillArgv(template: readonly string[], values: Record<string, string | string[]>): string[] {
  const argv: string[] = [];

  for (const part of template) {
    if (!(part.startsWith('<') && part.endsWith('>'))) {
      argv.push(part);
      continue;
    }
    const slot = part.slice(1, -1);
    const value = values[slot];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      argv.push(...value);
    } else {
      argv.push(value);
    }
  }

  return argv;
}

export type GitArgvId = keyof typeof GIT_ARGV;

// --------------------------------------------------------------------------
// Argument validation
// --------------------------------------------------------------------------

/** A branch, tag or remote name. Deliberately narrow. */
const NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Is this a usable branch, tag or remote name?
 *
 * The pattern is narrow on purpose. The argv never passes through a
 * shell, so the worst case for a name that slips through is a confusing
 * git error rather than code execution -- but a narrow pattern means the
 * confusing case is rare.
 */
export function validName(name: string): ValidationResult {
  if (name.length === 0) return { ok: false, reason: 'the name is empty' };
  if (name.startsWith('-')) {
    return { ok: false, reason: `the name '${name}' starts with '-', which git would read as an option` };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: `the name '${name}' contains characters outside ${NAME_PATTERN.source}`,
    };
  }
  return { ok: true };
}

/**
 * Is this a usable revision, branch or tag for a comparison?
 *
 * Revisions are looser than names: a sha, `HEAD~3`, `origin/main` and
 * `main` are all legitimate. But they still may not start with `-`.
 */
export function validRevision(rev: string): ValidationResult {
  if (rev.length === 0) return { ok: false, reason: 'the revision is empty' };
  if (rev.startsWith('-')) {
    return { ok: false, reason: `the revision '${rev}' starts with '-', which git would read as an option` };
  }
  if (/[\s;&|`$(){}<>]/.test(rev)) {
    return { ok: false, reason: `the revision '${rev}' contains characters git would not accept` };
  }
  return { ok: true };
}

/**
 * Is this path inside the repository?
 *
 * Paths are resolved against the repo root and must stay within it. A
 * path that escapes is refused rather than sanitised -- the caller asked
 * for something outside the repository, and quietly rewriting it would
 * commit the wrong file.
 */
export function validPath(repoRoot: string, path: string): ValidationResult {
  if (path.length === 0) return { ok: false, reason: 'the path is empty' };
  const abs = resolve(repoRoot, path);
  const rel = relative(resolve(repoRoot), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: `the path '${path}' escapes the repository root` };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// The runner
// --------------------------------------------------------------------------

/** The environment every git call runs with. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // git must never stop and ask for a credential -- it would hang the
    // server rather than fail.
    GIT_TERMINAL_PROMPT: '0',
    // git must never open an editor -- it would hang the server.
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    // The system gitconfig is not read: the server's behaviour should not
    // depend on machine-wide settings.
    GIT_CONFIG_NOSYSTEM: '1',
    // Output is parseable byte-for-byte regardless of the locale.
    LC_ALL: 'C',
    // No pager is ever spawned.
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    ...extra,
  };
}

/**
 * Run one git command.
 *
 * The only place in the server that spawns git. No shell, ever: the argv
 * goes straight to `spawnSync`.
 */
export function runGit(
  argv: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): GitResult {
  const result = spawnSync('git', argv, {
    cwd,
    env: gitEnv(),
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });

  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return {
      argv: ['git', ...argv],
      status: 'error',
      exit_code: typeof result.status === 'number' ? result.status : -1,
      stdout: result.stdout ?? '',
      stderr: timedOut
        ? `git timed out after ${timeoutMs}ms and was killed`
        : result.stderr || result.error.message,
      timed_out: timedOut,
    };
  }

  return {
    argv: ['git', ...argv],
    status: result.status === 0 ? 'ok' : 'error',
    exit_code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// --------------------------------------------------------------------------
// The builders
//
// Every builder reads its shape from `GIT_ARGV`. The table is the single
// place a command is written down; a builder that spelled its argv out
// again would let the two drift apart, and the table would stop being a
// description of what the server can do.
// --------------------------------------------------------------------------

/** The argv for `git status` in porcelain v2 form. */
export function buildStatus(): string[] {
  return [...GIT_ARGV['G-01']];
}

/** The argv for `git status --porcelain`. */
export function buildStatusPorcelain(): string[] {
  return [...GIT_ARGV['G-02']];
}

/**
 * The argv for a diff.
 *
 * The mode decides which table entry is used: a range, a path, the
 * staged changes, or the working tree. The stat is a *separate* command
 * and has to follow the same mode -- a stat of the working tree beside
 * a staged diff describes something else entirely.
 */
export function buildDiff(opts: {
  staged?: boolean;
  base?: string;
  head?: string;
  path?: string;
  stat?: boolean;
}): string[] {
  if (opts.base && opts.head) {
    return fillArgv(GIT_ARGV['G-05'], { range: `${opts.base}..${opts.head}` });
  }
  if (opts.path) {
    return fillArgv(GIT_ARGV['G-06'], { path: opts.path });
  }
  if (opts.staged) {
    return [...GIT_ARGV['G-04']];
  }
  return [...GIT_ARGV['G-03']];
}

/**
 * The argv for the stat that accompanies a diff.
 *
 * The stat must describe the same set of changes as the diff it comes
 * with, so it takes the same mode. A staged diff gets a staged stat, a
 * range diff gets a range stat, and so on.
 */
export function buildDiffStat(opts: {
  staged?: boolean;
  base?: string;
  head?: string;
  path?: string;
}): string[] {
  if (opts.base && opts.head) {
    return [...fillArgv(GIT_ARGV['G-05'], { range: `${opts.base}..${opts.head}` }), '--stat'];
  }
  if (opts.path) {
    return [...fillArgv(GIT_ARGV['G-06'], { path: opts.path }), '--stat'];
  }
  if (opts.staged) {
    return [...GIT_ARGV['G-04'], '--stat'];
  }
  return [...GIT_ARGV['G-07']];
}

/**
 * The argv for a log.
 *
 * The order matters: the revision, the `--since` and `--until` filters
 * and the `--grep` all come **before** the `--` separator, because
 * everything after the separator is a path filter. A branch name
 * placed after `--` would be read as the name of a file to look at --
 * which is exactly the bug this shape exists to prevent.
 *
 * The base table entry is G-08. G-09 (a path filter) and G-10 (a grep
 * filter) are the shapes that carry one of those. The remaining
 * filters compose freely, so they are appended to whichever entry
 * applies -- but always before the separator.
 */
export function buildLog(opts: {
  limit: number;
  path?: string;
  grep?: string;
  since?: string;
  until?: string;
  branch?: string;
}): string[] {
  // The base entry is chosen by the filter it already carries: G-09
  // ends with `-- <path>`, G-10 carries `--grep <grep>`, and G-08
  // carries neither. The free filters -- `--since`, `--until` and the
  // revision -- are appended, and the separator always goes last.
  // The three log shapes: no filter, a path filter, a grep filter.
  const LOG_SHAPES = {
    plain: GIT_ARGV['G-08'],
    path: GIT_ARGV['G-09'],
    grep: GIT_ARGV['G-10'],
  } as const;
  const base = opts.path ? 'path' : opts.grep ? 'grep' : 'plain';
  const argv = [...LOG_SHAPES[base]];

  const limitAt = argv.indexOf('<limit>');
  if (limitAt >= 0) argv[limitAt] = String(opts.limit);

  // The revision and the date filters go before the separator, so
  // they are inserted at the position the separator occupies. The
  // position is recomputed each time, because every insertion moves
  // it.
  const before = (...parts: string[]): void => {
    const sepAt = argv.indexOf('--');
    if (sepAt >= 0) argv.splice(sepAt, 0, ...parts);
    else argv.push(...parts);
  };

  if (opts.grep) {
    const grepAt = argv.indexOf('<grep>');
    if (grepAt >= 0) {
      argv[grepAt] = opts.grep;
    } else {
      before('--grep', opts.grep);
    }
  }
  if (opts.since) before('--since', opts.since);
  if (opts.until) before('--until', opts.until);
  if (opts.branch) before(opts.branch);

  // The path filter replaces the table's placeholder.
  const pathAt = argv.indexOf('<path>');
  if (pathAt >= 0) argv[pathAt] = opts.path as string;
  return argv;
}

/** The argv for a commit. */
export function buildCommit(message: string, paths: string[] = []): string[] {
  if (paths.length === 0) return fillArgv(GIT_ARGV['G-14'], { message });
  return fillArgv(GIT_ARGV['G-15'], { message, path: paths });
}

/** The argv for a branch operation. */
export function buildBranch(action: string, name?: string, from?: string): string[] {
  switch (action) {
    case 'create':
      return from && from !== 'HEAD'
        ? fillArgv(GIT_ARGV['G-18'], { name: name as string, from })
        : fillArgv(GIT_ARGV['G-17'], { name: name as string });
    case 'delete':
      return fillArgv(GIT_ARGV['G-19'], { name: name as string });
    case 'delete-force':
      return fillArgv(GIT_ARGV['G-20'], { name: name as string });
    case 'list':
      return [...GIT_ARGV['G-21']];
    case 'checkout':
      return fillArgv(GIT_ARGV['G-22'], { name: name as string });
    default:
      throw new Error(`unknown branch action '${action}'`);
  }
}

/** The argv for a push. */
export function buildPush(branch: string, remote: string, setUpstream: boolean): string[] {
  return setUpstream
    ? fillArgv(GIT_ARGV['G-23'], { remote, branch })
    : fillArgv(GIT_ARGV['G-24'], { remote, branch });
}

/** The argv for a merge. */
export function buildMerge(source: string, strategy: string): string[] {
  if (strategy === 'rebase') return fillArgv(GIT_ARGV['G-26'], { source });
  return fillArgv(GIT_ARGV['G-25'], { source });
}

/** The argv for a stash operation. */
export function buildStash(action: string, message?: string): string[] {
  switch (action) {
    case 'push':
      return fillArgv(GIT_ARGV['G-27'], { message: message ?? '' });
    case 'pop':
      return [...GIT_ARGV['G-28']];
    case 'list':
      return [...GIT_ARGV['G-29']];
    case 'drop':
      return [...GIT_ARGV['G-30']];
    default:
      throw new Error(`unknown stash action '${action}'`);
  }
}

/** The argv for a reset. */
export function buildReset(mode: string, target: string): string[] {
  if (mode === 'soft') return fillArgv(GIT_ARGV['G-31'], { target });
  if (mode === 'hard') return fillArgv(GIT_ARGV['G-33'], { target });
  return fillArgv(GIT_ARGV['G-32'], { target });
}

/** The argv for a revert. */
export function buildRevert(commit: string, noCommit: boolean): string[] {
  return noCommit
    ? fillArgv(GIT_ARGV['G-35'], { commit })
    : fillArgv(GIT_ARGV['G-34'], { commit });
}

/** The argv for a tag operation. */
export function buildTag(action: string, name?: string, message?: string): string[] {
  switch (action) {
    case 'create':
      return message
        ? fillArgv(GIT_ARGV['G-37'], { name: name as string, message })
        : fillArgv(GIT_ARGV['G-36'], { name: name as string });
    case 'delete':
      return fillArgv(GIT_ARGV['G-38'], { name: name as string });
    case 'list':
      return [...GIT_ARGV['G-39']];
    default:
      throw new Error(`unknown tag action '${action}'`);
  }
}

/**
 * The argv for a remote operation.
 *
 * `add` and `set-url` are here so the tool can name them and the policy
 * can refuse them with a rule id, rather than the tool refusing them
 * with a sentence. The refusal is the policy's job.
 */
export function buildRemote(action: string, name?: string): string[] {
  switch (action) {
    case 'list':
      return [...GIT_ARGV['G-40']];
    case 'show':
      return fillArgv(GIT_ARGV['G-41'], { name: name as string });
    case 'fetch':
      return fillArgv(GIT_ARGV['G-42'], { name: name ?? 'origin' });
    case 'pull':
      return fillArgv(GIT_ARGV['G-43'], { name: name ?? 'origin', branch: 'HEAD' });
    case 'add':
      return ['remote', 'add', name as string];
    case 'set-url':
      return ['remote', 'set-url', name as string];
    default:
      throw new Error(`unknown remote action '${action}'`);
  }
}

/** The argv for adding a worktree. */
export function buildWorktreeAdd(path: string, branch: string): string[] {
  return fillArgv(GIT_ARGV['G-46'], { path, branch });
}

/** The argv for listing worktrees. */
export function buildWorktreeList(): string[] {
  return [...GIT_ARGV['G-47']];
}

/** The argv for removing a worktree. */
export function buildWorktreeRemove(path: string): string[] {
  return fillArgv(GIT_ARGV['G-48'], { path });
}

/** The argv for pruning worktrees. */
export function buildWorktreePrune(): string[] {
  return [...GIT_ARGV['G-49']];
}

/**
 * The argv for combining two branches.
 *
 * `merge-tree --write-tree` performs the merge without touching the
 * index or the working tree. It writes a dangling tree object into the
 * object database and nothing else -- no branch moves, no file in the
 * working tree changes.
 */
export function buildMergeTree(branch: string, other: string): string[] {
  return fillArgv(GIT_ARGV['G-50'], { branch, other });
}

/** The argv for a cherry-pick. */
export function buildCherryPick(commit: string): string[] {
  return fillArgv(GIT_ARGV['G-51'], { commit });
}

/** The argv for showing one revision. */
export function buildShow(commit: string): string[] {
  return fillArgv(GIT_ARGV['G-52'], { commit });
}

/** The argv for the repository root. */
export function buildRepoRoot(): string[] {
  return [...GIT_ARGV['G-11']];
}

/** The argv for the current branch name. */
export function buildCurrentBranch(): string[] {
  return [...GIT_ARGV['G-12']];
}

/** The argv for the remote's HEAD, which names the default branch. */
export function buildRemoteHead(remote: string): string[] {
  return fillArgv(GIT_ARGV['G-13'], { remote });
}

/** The argv for staging paths. */
export function buildAdd(paths: string[]): string[] {
  return fillArgv(GIT_ARGV['G-16'], { path: paths });
}

/** The argv for the oneline log of a range. */
export function buildRangeLog(base: string, branch: string): string[] {
  return fillArgv(GIT_ARGV['G-44'], { range: `${base}..${branch}` });
}

/** The argv for the range log that `plan_from_commits` reads. */
export function buildPlanningRangeLog(limit: number, base: string, branch: string): string[] {
  const argv = fillArgv(GIT_ARGV['G-56'], { limit: String(limit), range: `${base}..${branch}` });
  return argv;
}

/** The argv for counting the commits on each side of a divergence. */
export function buildLeftRightCount(upstream: string, branch: string): string[] {
  return fillArgv(GIT_ARGV['G-45'], { divergence: `${upstream}...${branch}` });
}

/** The argv for the names of the staged files. */
export function buildStagedNames(): string[] {
  return [...GIT_ARGV['G-53']];
}

/** The argv for the short hash of HEAD. */
export function buildHeadShort(): string[] {
  return [...GIT_ARGV['G-54']];
}

/** The argv for the branches merged into a base. */
export function buildMergedBranches(base: string): string[] {
  return fillArgv(GIT_ARGV['G-55'], { base });
}

/**
 * The argv for turning a merged tree into a commit.
 *
 * `merge-tree --write-tree` hands back a tree, and git refuses to merge a
 * tree where a commit is expected. Combining a third branch therefore
 * needs the tree wrapped in a commit first. The commit has the base and
 * the merged branch as its parents, so it is a real merge commit -- it
 * just has no branch pointing at it.
 */
export function buildCommitTree(tree: string, parents: string[], message: string): string[] {
  const argv = fillArgv(GIT_ARGV['G-57'], { tree, parent: parents[0], message });
  // `commit-tree` takes `-p` once per parent, so the extra ones are
  // inserted after the first.
  const firstParent = argv.indexOf('-p');
  if (firstParent >= 0) {
    const extra = parents.slice(1).flatMap((p) => ['-p', p]);
    argv.splice(firstParent + 2, 0, ...extra);
  }
  return argv;
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

export interface RepoStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  raw: string;
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * The v2 format is line-oriented and stable: `# <key> <value>` header
 * lines, then one line per changed path. The v1 porcelain format is
 * easier to read but encodes the path in a fixed-width prefix, and the
 * widths have changed between git versions.
 */
export function parseStatus(raw: string): RepoStatus {
  const status: RepoStatus = {
    branch: '',
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: true,
    staged: [],
    unstaged: [],
    untracked: [],
    raw,
  };

  for (const line of raw.split('\n')) {
    if (line === '') continue;

    if (line.startsWith('# ')) {
      const header = line.slice(2);
      const space = header.indexOf(' ');
      const key = space === -1 ? header : header.slice(0, space);
      const value = space === -1 ? '' : header.slice(space + 1);
      switch (key) {
        case 'branch.oid':
          if (value === '(initial)') status.branch = '(initial)';
          break;
        case 'branch.head':
          status.branch = value;
          break;
        case 'branch.upstream':
          status.upstream = value;
          break;
        case 'branch.ab':
          // Porcelain v2 writes "+<ahead> -<behind>". The minus sign is
          // part of the format, not a separator.
          const m = /^\+(\d+)\s+-(\d+)$/.exec(value);
          if (m) {
            status.ahead = Number.parseInt(m[1], 10);
            status.behind = Number.parseInt(m[2], 10);
          }
          break;
        default:
          break;
      }
      continue;
    }

    // A changed-path line. Porcelain v2 has two record shapes:
    //
    //   "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
    //   "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<orig>"
    //
    // Both put the path in the ninth field. Counting from the record
    // type is what makes a path with spaces work.
    if (line.startsWith('? ')) {
      status.untracked.push(line.slice(2));
      status.clean = false;
      continue;
    }

    const parts = line.split(' ');
    if (parts.length >= 9 && (parts[0] === '1' || parts[0] === '2')) {
      const xy = parts[1];
      const path = parts.slice(8).join(' ');
      const x = xy[0];
      const y = xy[1];
      if (x !== '.') {
        status.staged.push(path);
        status.clean = false;
      }
      if (y !== '.') {
        status.unstaged.push(path);
        status.clean = false;
      }
    }
  }

  return status;
}

export interface CommitInfo {
  hash: string;
  short_hash: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * Parse the log output.
 *
 * The fields are separated by US (`\x1f`) rather than a printable
 * character, so a commit subject containing the separator cannot corrupt
 * the parse.
 */
export function parseLog(raw: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\x1f');
    if (parts.length < 5) continue;
    commits.push({
      hash: parts[0],
      short_hash: parts[1],
      subject: parts[2],
      author: parts[3],
      date: parts[4],
    });
  }
  return commits;
}

/** The repository root, or null if the path is not in a repository. */
export function repoRoot(cwd: string): string | null {
  const result = runGit(buildRepoRoot(), cwd);
  if (result.status !== 'ok') return null;
  const root = result.stdout.trim();
  return root === '' ? null : root;
}

/** The current branch name. */
export function currentBranch(cwd: string): string {
  const result = runGit(buildCurrentBranch(), cwd);
  if (result.status !== 'ok') return '';
  return result.stdout.trim();
}

/** The repository's default branch, by way of the remote's HEAD. */
export function defaultBranch(cwd: string, remote = 'origin'): string | null {
  const result = runGit(buildRemoteHead(remote), cwd);
  if (result.status !== 'ok') return null;
  const ref = result.stdout.trim();
  if (ref === '') return null;
  const short = ref.replace(`refs/remotes/${remote}/`, '');
  return short === '' ? null : short;
}

/** Does the branch have commits that the base branch does not? */
export function hasCommitsAhead(base: string, branch: string, cwd: string): boolean {
  const result = runGit(buildRangeLog(base, branch), cwd);
  if (result.status !== 'ok') return false;
  return result.stdout.trim() !== '';
}

/** Is the working tree clean? */
export function treeClean(cwd: string): boolean {
  const result = runGit(buildStatusPorcelain(), cwd);
  if (result.status !== 'ok') return false;
  return result.stdout.trim() === '';
}

/**
 * Is a branch protected?
 *
 * A branch is protected if it matches the policy's protected list. The
 * default list is `main`, `master` and `release/*`.
 */
export function isProtectedBranch(branch: string, patterns: string[]): boolean {
  if (branch === '') return false;
  for (const pattern of patterns) {
    if (pattern === branch) return true;
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (branch.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Is the path inside the repository? Used by the `PR-8` check. */
export function insideRepo(root: string | null, path: string): boolean {
  if (!root) return false;
  const abs = resolve(path);
  return abs === resolve(root) || abs.startsWith(resolve(root) + sep);
}

// --------------------------------------------------------------------------
// Parsing the worktree and merge-tree output
// --------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * The porcelain format is a sequence of records separated by blank
 * lines. Each record begins with a `key value` line -- `worktree`,
 * `HEAD`, `branch`, `bare` or `detached` -- and the records are
 * separated by an empty line.
 */
export function parseWorktreeList(raw: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  const flush = (): void => {
    if (current) worktrees.push(current);
    current = null;
  };

  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    switch (key) {
      case 'worktree':
        flush();
        current = { path: value, head: null, branch: null, bare: false, detached: false };
        break;
      case 'HEAD':
        if (current) current.head = value;
        break;
      case 'branch':
        if (current) current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'bare':
        if (current) current.bare = true;
        break;
      case 'detached':
        if (current) current.detached = true;
        break;
      default:
        break;
    }
  }
  flush();
  return worktrees;
}

export interface MergeTreeResult {
  /** The tree object the merge produced. */
  tree: string | null;
  /** The paths that conflicted. */
  conflicts: string[];
  /** Whether the merge was clean. */
  clean: boolean;
}

/**
 * Parse the output of `git merge-tree --write-tree`.
 *
 * The output has two shapes, and the difference matters:
 *
 *  - **clean**: the tree OID alone, exit code 0.
 *  - **conflicted**: the tree OID on the first line, then the conflicted
 *    stages, then a blank line, then `Auto-merging <path>` and
 *    `CONFLICT (content): Merge conflict in <path>` lines, exit code 1.
 *
 * The conflicts are read from the `CONFLICT` lines rather than inferred
 * from the exit code, because a non-zero exit is not specific: the
 * same code covers a conflict and a git-level failure. The paths are
 * what the caller needs -- "which files conflicted" is the repair lead.
 */
export function parseMergeTree(stdout: string): MergeTreeResult {
  const lines = stdout.split('\n');
  const tree = lines[0]?.trim() ?? '';
  const conflicts: string[] = [];

  for (const line of lines) {
    const m = /^CONFLICT \([^)]*\): Merge conflict in (.+)$/.exec(line.trim());
    if (m) {
      const path = m[1].trim();
      if (!conflicts.includes(path)) conflicts.push(path);
      continue;
    }
    // The stage lines look like `100644 <oid> 1\t<path>`. They name the
    // same paths, but the CONFLICT line is the one that says so
    // explicitly.
    const stage = /^\d{6} [0-9a-f]{40} [123]\t(.+)$/.exec(line);
    if (stage) {
      const path = stage[1].trim();
      if (!conflicts.includes(path)) conflicts.push(path);
    }
  }

  return {
    tree: tree === '' ? null : tree,
    conflicts,
    clean: conflicts.length === 0 && tree !== '',
  };
}
