/**
 * The test helpers.
 *
 * Two things every test needs: a temporary directory it can scribble in,
 * and a way to drive the server in-process. Both live here so that the
 * test files stay about the behaviour rather than the setup.
 *
 * Nothing in this file touches the real `$HOME` or the user's real
 * repositories. The git fixture is built from scratch in a temp
 * directory every time.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';

/** A temporary directory that removes itself when the test ends. */
export function tempDir(prefix = 'orchestrator-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a temporary directory. */
export function cleanup(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { force: true, recursive: true });
}

/**
 * A git repository with one commit, built from scratch.
 *
 * The fixture is made in a temp directory rather than committed to the
 * repository, so a test that mutates it cannot corrupt the source tree
 * and there is nothing to keep in sync.
 */
export function makeRepo(dir: string, opts: { remote?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const run = (argv: string[], cwd = dir): string =>
    execFileSync('git', argv, {
      cwd,
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

  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Orchestrator Test']);

  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf-8');
  run(['add', 'README.md']);
  run(['commit', '-q', '-m', 'chore: init']);

  if (opts.remote) {
    const bare = `${dir}.remote.git`;
    execFileSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf-8' });
    run(['remote', 'add', 'origin', bare]);
  }

  return dir;
}

/** A client connected to a fresh server, over an in-memory transport. */
export async function connectClient() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

/**
 * The shape a tool's JSON result takes.
 *
 * Every tool returns the same handful of fields -- an `applied` flag, a
 * `rule` or `gate` when something stopped it, and then whatever the
 * particular tool reports. Declaring the common ones here means the tests
 * can say `result.rule` and have the compiler know it is a string, instead
 * of casting at every assertion.
 */
export interface ToolOutput {
  /** Did the tool do the thing? */
  applied?: boolean;
  /** Was the operation refused by a rule? */
  denied?: boolean;
  /** Was the operation refused by the state machine? */
  refused?: boolean;
  /** Was the operation held pending evidence? */
  gated?: boolean;
  /** The rule that refused or held the operation. */
  rule?: string;
  /** The rule that held the operation, when `gated`. */
  gate?: string;
  /** Why the operation was refused or held. */
  reason?: string;
  /** What to do about it. */
  hint?: string;
  /** The rule ids the operation touched, when several applied. */
  denied_rules?: string[];
  /** Was this a preview rather than an action? */
  dry_run?: boolean;
  /** The operation the tool ran. */
  operation?: string;
  /** A task id. */
  id?: string;
  /** A task, in full. */
  task?: Record<string, unknown>;
  /** A list of tasks. */
  tasks?: Array<Record<string, unknown>>;
  /** A task's history. */
  history?: Array<Record<string, unknown>>;
  /** A list of commits. */
  commits?: Array<Record<string, unknown>>;
  /** A list of blockers. */
  blocking_tasks?: Array<Record<string, unknown>>;
  /** A list of board invariant violations. */
  violations?: Array<Record<string, unknown>>;
  /** A list of proposed or created tasks. */
  created?: Array<Record<string, unknown>>;
  /** The policy's rule table. */
  rules?: Array<Record<string, unknown>>;
  /** The fields a task update changed. */
  updated?: string[];
  /** The fields a stash or merge operation named. */
  args?: Record<string, unknown>;
  /** The argv the tool ran. */
  argv?: string[];
  /** The board's path. */
  board_path?: string | null;
  /** The policy's path. */
  policy_path?: string;
  /** The repository's root. */
  repo_root?: string;
  /** The project's root. */
  project?: string;
  /** The task's title. */
  title?: string;
  /** The task's state. */
  state?: string;
  /** The task's branch. */
  branch?: string;
  /** The branch a pull request would target. */
  base?: string;
  /** The branch that was pushed. */
  remote?: string;
  /** The current branch. */
  upstream?: string;
  /** The pull request's URL. */
  url?: string | null;
  /** The commit's short hash. */
  commit_hash?: string | null;
  /** A note for the caller. */
  note?: string;
  /** An error message. */
  error?: string;
  /** The git status text. */
  raw?: string;
  /** The diff text. */
  diff?: string;
  /** The diffstat. */
  stat?: string;
  /** The command's standard output. */
  stdout?: string;
  /** The command's standard error. */
  stderr?: string;
  /** The command's exit code. */
  exit_code?: number;
  /** The operation's outcome. */
  status?: string;
  /** How many tasks matched. */
  total_matched?: number;
  /** How many tasks were returned. */
  returned?: number;
  /** How many tasks the board holds. */
  task_count?: number;
  /** Whether the board file exists. */
  board_exists?: boolean;
  /** Whether the tree is clean. */
  clean?: boolean;
  /** How many commits are ahead. */
  ahead?: number;
  /** How many commits are behind. */
  behind?: number;
  /** How many commits were read. */
  commits_read?: number;
  /** How many tasks were written. */
  tasks_written?: number;
  /** How many writes happened. */
  written?: number;
  /** How many tasks were deleted. */
  deleted?: number;
  /** The page offset. */
  offset?: number;
  /** Whether the page is short. */
  truncated?: boolean;
  /** Whether the write happened. */
  written_flag?: boolean;
  /** The board's schema version. */
  schema_version?: number;
  /** Where the policy came from. */
  source?: string;
  /** The rule ids the policy file overrode. */
  overrides?: string[];
  /** A policy error. */
  policy_error?: string;
  /** The porcelain output. */
  porcelain?: boolean;
  /** The staged paths. */
  staged?: string[];
  /** The unstaged paths. */
  unstaged?: string[];
  /** The untracked paths. */
  untracked?: string[];
  /** How the diff was computed. */
  mode?: string;
  /** How many files changed. */
  files_changed?: number;
  /** Whether the output was cut short. */
  truncated_diff?: boolean;
  /** Any other field. */
  [key: string]: unknown;
}

/**
 * Call a tool and parse its structured content.
 *
 * The tools return JSON in `content[0].text` and the same object in
 * `structuredContent`. The text is parsed so the test asserts on what a
 * client actually reads.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutput> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Tool ${name} returned no text content`);
  }
  try {
    return JSON.parse(text) as ToolOutput;
  } catch {
    return { raw: text };
  }
}

/** Call a tool and expect it to fail. */
export async function expectError(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  if (!result.isError) {
    throw new Error(`Expected ${name} to error, but it succeeded`);
  }
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.[0]?.text;
  assert(typeof text === 'string', `${name} returned an error with no text`);
  return text;
}

/** A fixed timestamp, so the tests do not depend on the clock. */
export const FIXED_NOW = '2026-11-07T14:22:10Z';

/**
 * Read a field from a tool result as a definite type.
 *
 * The tools return JSON, so the result is `Record<string, unknown>` and
 * every field access would otherwise be an `unknown` that the compiler
 * rightly refuses to compare. These helpers say what the field is.
 */
export function str(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  assert(typeof value === 'string', `${key} is not a string (got ${typeof value})`);
  return value;
}

export function num(result: Record<string, unknown>, key: string): number {
  const value = result[key];
  assert(typeof value === 'number', `${key} is not a number (got ${typeof value})`);
  return value;
}

export function bool(result: Record<string, unknown>, key: string): boolean {
  const value = result[key];
  assert(typeof value === 'boolean', `${key} is not a boolean (got ${typeof value})`);
  return value;
}

export function list(result: Record<string, unknown>, key: string): unknown[] {
  const value = result[key];
  assert(Array.isArray(value), `${key} is not an array (got ${typeof value})`);
  return value;
}

export function obj(result: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = result[key];
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${key} is not an object`);
  return value as Record<string, unknown>;
}

/** Read a field as a string, or `undefined` when it is absent. */
export function optStr(result: Record<string, unknown>, key: string): string | undefined {
  const value = result[key];
  return typeof value === 'string' ? value : undefined;
}

/** The board path inside a project root. */
export function boardPath(root: string): string {
  return resolve(root, '.orchestrator', 'board.json');
}
