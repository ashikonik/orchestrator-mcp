/**
 * Where the server is looking.
 *
 * The server is registered once, globally, and used in many projects. So
 * "which project?" cannot be answered once at startup -- it is answered
 * per call.
 *
 * The resolution order is in the plan and in `docs/BOARD_FORMAT.md`. The
 * important properties are:
 *
 *  - The root is resolved **per call**, so a bad cwd at startup is normal
 *    and not fatal.
 *  - The board path and the git root are **independent**. A board may
 *    live outside the repository, and the git surface always works in the
 *    repository.
 *  - Nothing depends on `process.cwd()` except the explicit `project`
 *    argument, which is documented as relative to it.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { repoRoot } from './git.js';

/** The directory the board lives in, relative to the project root. */
export const BOARD_DIR = '.orchestrator';
export const BOARD_FILE = 'board.json';
export const POLICY_FILE = 'policy.json';

/** How far up the tree the board is looked for. */
export const MAX_UPWARD_LEVELS = 4;

/** The resolved locations for one call. */
export interface Resolution {
  /** The project root. */
  root: string;
  /** The absolute path of the board file, or null if there is no board. */
  boardPath: string | null;
  /** The absolute path of the policy file. */
  policyPath: string;
  /** The repository root, or null if the project is not in a repository. */
  repoRoot: string | null;
  /** How the root was found, for the response. */
  source: 'project' | 'env' | 'board' | 'repo' | 'cwd';
  /** A human-readable note, set when something could not be resolved. */
  note?: string;
}

/**
 * Resolve the project root.
 *
 * The order, most explicit first:
 *
 *  1. the `project` argument on the call, relative to `process.cwd()`
 *  2. `ORCHESTRATOR_ROOT`
 *  3. the parent of `ORCHESTRATOR_BOARD`'s directory
 *  4. the git repository root of `process.cwd()`
 *  5. `process.cwd()` -- the last resort
 */
export function resolveRoot(explicit?: string): { root: string; source: Resolution['source']; note?: string } {
  if (explicit && explicit.trim() !== '') {
    const root = resolve(process.cwd(), explicit);
    return { root, source: 'project' };
  }

  const envRoot = process.env['ORCHESTRATOR_ROOT'];
  if (envRoot && envRoot.trim() !== '') {
    const root = resolve(envRoot);
    if (existsSync(root)) return { root, source: 'env' };
    return {
      root,
      source: 'env',
      note: `ORCHESTRATOR_ROOT points at ${root}, which does not exist.`,
    };
  }

  const envBoard = process.env['ORCHESTRATOR_BOARD'];
  if (envBoard && envBoard.trim() !== '') {
    const board = resolve(envBoard);
    // `<board-dir>/..` -- the board lives in `<root>/.orchestrator/`, so
    // the root is two levels up from the file.
    const root = resolve(dirname(board), '..');
    return { root, source: 'board' };
  }

  const repo = repoRoot(process.cwd());
  if (repo) return { root: repo, source: 'repo' };

  return { root: process.cwd(), source: 'cwd', note: 'No project root could be resolved from the environment; using the current directory.' };
}

/**
 * Find the board file.
 *
 * When the root was found by walking up from a subdirectory, the board
 * may be in a parent. The search walks up at most `MAX_UPWARD_LEVELS`
 * levels, which is enough for the common "the agent started in
 * `src/deep/`" case without wandering off into the user's home
 * directory.
 */
export function findBoardUpwards(
  startDir: string,
  maxLevels: number = MAX_UPWARD_LEVELS,
): string | null {
  let dir = resolve(startDir);
  for (let level = 0; level <= maxLevels; level++) {
    const candidate = resolve(dir, BOARD_DIR, BOARD_FILE);
    if (existsSync(candidate)) return candidate;
    const fallback = resolve(dir, BOARD_FILE);
    if (existsSync(fallback)) return fallback;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve everything one call needs.
 *
 * The board is looked for at the root first, then upwards. A board that
 * is found is used verbatim; when there is no board, the *expected* path
 * is still returned so the board-writing tools can say where the file
 * would go.
 */
export function resolveCall(explicit?: string): Resolution {
  const { root, source, note } = resolveRoot(explicit);

  const envBoard = process.env['ORCHESTRATOR_BOARD'];
  let boardPath: string | null = null;

  if (envBoard && envBoard.trim() !== '') {
    const board = resolve(envBoard);
    boardPath = existsSync(board) ? board : null;
  } else {
    const found = findBoardUpwards(root);
    if (found) {
      boardPath = found;
    } else {
      // No board yet. The expected path is still useful: the write tools
      // need to say where the board would be created.
      boardPath = resolve(root, BOARD_DIR, BOARD_FILE);
    }
  }

  const policyPath = process.env['ORCHESTRATOR_POLICY']
    ? resolve(process.env['ORCHESTRATOR_POLICY'])
    : resolve(root, BOARD_DIR, POLICY_FILE);

  const repo = repoRoot(root);

  return {
    root,
    boardPath,
    policyPath,
    repoRoot: repo,
    source,
    note: note ?? (repo ? undefined : 'The project is not inside a git repository, so the git tools are unavailable.'),
  };
}

/** The name of the project, from the directory name. */
export function projectName(root: string): string {
  const parts = resolve(root).split('/');
  return parts[parts.length - 1] || 'project';
}

/** The default branch, when the repo has no remote HEAD to point at. */
export function fallbackDefaultBranch(): string {
  return process.env['ORCHESTRATOR_DEFAULT_BRANCH'] || 'main';
}
