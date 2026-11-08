/**
 * The `gh` command surface.
 *
 * `open_pr` is the one tool that reaches the network, so the surface here
 * is deliberately tiny: create a pull request, look one up, list the ones
 * for a branch. There is no `pr merge`, no `pr close`, no `pr delete` --
 * those change shared state in a way that should be a human's decision,
 * and this server is about doing the local work.
 *
 * The invocation discipline is the same as `git.ts`: argv arrays, no
 * shell, a timeout, and the full argv returned so the caller can see
 * exactly what ran.
 */
import { spawnSync } from 'node:child_process';
import type { GitResult } from './types.js';
import { DEFAULT_TIMEOUT_MS } from './git.js';

/**
 * The complete set of gh invocations.
 *
 * `GH-01` and `GH-02` are the create variants (draft and not); `GH-03`
 * and `GH-04` are the reads.
 */
export const GH_ARGV = {
  'GH-01': [
    'pr',
    'create',
    '--title',
    '<title>',
    '--base',
    '<base>',
    '--head',
    '<branch>',
    '--body',
    '<body>',
  ],
  'GH-02': [
    'pr',
    'create',
    '--draft',
    '--title',
    '<title>',
    '--base',
    '<base>',
    '--head',
    '<branch>',
    '--body',
    '<body>',
  ],
  'GH-03': ['pr', 'list', '--head', '<branch>', '--json', 'number,url,state'],
  'GH-04': ['pr', 'view', '--json', 'number,url,state,title'],
} satisfies Record<string, readonly string[]>;

export type GhArgvId = keyof typeof GH_ARGV;

/** The environment every gh call runs with. */
export function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The output is parsed, so it must not be coloured.
    NO_COLOR: '1',
    // gh must never stop and ask for a credential.
    GH_PROMPT_DISABLED: '1',
    // A pager would hang the call.
    GH_PAGER: 'cat',
    PAGER: 'cat',
  };
}

/**
 * Run one gh command.
 *
 * If `gh` is not installed, the error says so plainly. "gh exited with
 * code 127" is a true fact but an unhelpful one.
 */
export function runGh(
  argv: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): GitResult {
  const result = spawnSync('gh', argv, {
    cwd,
    env: ghEnv(),
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    const notFound = err.code === 'ENOENT';
    const timedOut = err.code === 'ETIMEDOUT';
    return {
      argv: ['gh', ...argv],
      status: 'error',
      exit_code: typeof result.status === 'number' ? result.status : -1,
      stdout: result.stdout ?? '',
      stderr: notFound
        ? 'gh is not installed, or is not on PATH. The pull-request tool needs the GitHub CLI.'
        : timedOut
          ? `gh timed out after ${timeoutMs}ms and was killed`
          : err.message,
      timed_out: timedOut,
    };
  }

  return {
    argv: ['gh', ...argv],
    status: result.status === 0 ? 'ok' : 'error',
    exit_code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The argv for creating a pull request. */
export function buildPrCreate(opts: {
  title: string;
  body: string;
  base: string;
  branch: string;
  draft?: boolean;
}): string[] {
  const argv = [
    'pr',
    'create',
    '--title',
    opts.title,
    '--base',
    opts.base,
    '--head',
    opts.branch,
    '--body',
    opts.body,
  ];
  if (opts.draft) argv.splice(1, 0, '--draft');
  return argv;
}

/** The argv for listing the pull requests for a branch. */
export function buildPrList(branch: string): string[] {
  return ['pr', 'list', '--head', branch, '--json', 'number,url,state'];
}

/** The argv for viewing the pull request for a branch. */
export function buildPrView(): string[] {
  return ['pr', 'view', '--json', 'number,url,state,title'];
}

export interface ExistingPr {
  number: number;
  url: string;
  state: string;
}

/**
 * Parse the pull requests gh reported for a branch.
 *
 * A malformed response is an empty list rather than an error: the caller
 * then attempts the create and gh itself refuses it, which is the
 * authoritative answer.
 */
export function parsePrList(stdout: string): ExistingPr[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const prs: ExistingPr[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      prs.push({
        number: typeof rec['number'] === 'number' ? rec['number'] : -1,
        url: typeof rec['url'] === 'string' ? rec['url'] : '',
        state: typeof rec['state'] === 'string' ? rec['state'] : '',
      });
    }
  }
  return prs;
}

/** The URL of a pull request gh just created. */
export function parsePrUrl(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (/^https?:\/\/\S+$/.test(trimmed)) return trimmed;
  }
  return null;
}
