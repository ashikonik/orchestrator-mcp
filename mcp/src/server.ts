/**
 * The tool surface — 17 tools, transport-independent.
 *
 * Every handler follows the same four steps:
 *
 *   1. resolve where it is working (the project root, the board, the repo)
 *   2. ask the policy whether the operation may proceed
 *   3. do the thing
 *   4. return the shared result shape
 *
 * Descriptions are scope statements, never behavioural directives. "Not
 * covered by X" tells the model what a tool does not do; "Use X instead"
 * tells it what to do, which is the model's job rather than the schema's.
 *
 * Write tools **execute** by default. The gate is the policy layer, not
 * a confirmation prompt -- but every write tool takes `dry_run` so the
 * caller can preview what would happen.
 *
 * The read-only tools take no `dry_run`: there is nothing to preview.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  appendHistory,
  blockersOf,
  claimIsLive,
  findTask,
  nextTaskId,
  readBoard,
  replaceTask,
  retireId,
  summarize,
  taskIdForKey,
  validateBoard,
  writeBoard,
} from './board.js';
import { emptyBoard, newTask, parseBoard } from './board-schema.js';
import { canTransition, dependencyBlockers } from './states.js';
import { defaultPolicy, evaluate, loadPolicy, maySetVerdict } from './policy.js';
import { RULES } from './policy-rules.js';
import {
  buildAdd,
  buildBranch,
  buildCherryPick,
  buildCommit,
  buildCommitTree,
  buildDiff,
  buildDiffStat,
  buildLog,
  buildMerge,
  buildMergeTree,
  buildMergedBranches,
  buildHeadShort,
  buildPlanningRangeLog,
  buildPush,
  buildRemote,
  buildReset,
  buildRevert,
  buildStash,
  buildStagedNames,
  buildStatus,
  buildStatusPorcelain,
  buildTag,
  buildWorktreeAdd,
  buildWorktreeList,
  buildWorktreePrune,
  buildWorktreeRemove,
  currentBranch,
  defaultBranch,
  hasCommitsAhead,
  insideRepo,
  isProtectedBranch,
  parseLog,
  parseMergeTree,
  parseStatus,
  parseWorktreeList,
  resolveRef,
  runGit,
  treeClean,
  validName,
  validPath,
  validRevision,
} from './git.js';
import { buildPrCreate, buildPrList, parsePrList, parsePrUrl, runGh } from './gh.js';
import { fallbackDefaultBranch, projectName, resolveCall } from './root.js';
import { verifyCommit } from './verify.js';
import type { VerificationStatus } from './verify.js';
import type { Board, PolicyContext, Task, TaskState, ToolResult } from './types.js';
import { TASK_STATES } from './types.js';

export const SERVER_NAME = 'orchestrator';
export const SERVER_VERSION = '1.0.0';

export interface Deps {
  /** Overrides the process clock. The tests use it to make timestamps fixed. */
  now?: () => string;
}

// --------------------------------------------------------------------------
// Result helpers
// --------------------------------------------------------------------------

function asError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asText(payload: unknown): ToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    result.structuredContent = payload as Record<string, unknown>;
  }
  return result;
}

/** A refusal, in the shape every policy denial uses. */
function denial(decision: {
  rule: string;
  operation: string;
  reason: string;
  hint?: string;
}): ToolResult {
  return asText({
    applied: false,
    denied: true,
    rule: decision.rule,
    operation: decision.operation,
    reason: decision.reason,
    hint: decision.hint,
  });
}

/** A held conditional -- the caller must supply the evidence and retry. */
function hold(decision: {
  rule: string;
  operation: string;
  reason: string;
  hint?: string;
}): ToolResult {
  return asText({
    applied: false,
    gated: true,
    gate: decision.rule,
    operation: decision.operation,
    reason: decision.reason,
    hint: decision.hint,
  });
}

/**
 * Ask the policy whether an operation may proceed.
 *
 * Every tool goes through this, including the read-only ones. A rule
 * that says "reading the board is allowed" is only worth having if a
 * repository can tighten it -- and a tightened rule that the read tools
 * ignore is a rule that is not really enforced.
 *
 * Returns the refusal, or null when the operation may proceed.
 */
function permit(
  operation: string,
  ctx: PolicyContext,
  policy: ReturnType<typeof defaultPolicy>,
): ToolResult | null {
  const decision = evaluate(operation, ctx, policy);
  if (decision.verdict === 'deny') {
    return denial({ rule: decision.rule, operation, reason: decision.reason, hint: decision.hint });
  }
  if (decision.verdict === 'conditional' && !decision.satisfied) {
    return hold({ rule: decision.rule, operation, reason: decision.reason, hint: decision.hint });
  }
  return null;
}

// --------------------------------------------------------------------------
// The server
// --------------------------------------------------------------------------

/**
 * The keys each `git_operate` operation accepts.
 *
 * The `args` record is free-form, so a typo would otherwise be
 * silently ignored -- and a typo is dangerous where the argument
 * chooses a *path*: `git worktree add` with no path creates the
 * worktree inside the current directory. Declaring the keys means an
 * unrecognised one is refused by name instead of dropped.
 */
const OPERATE_ARGS: Record<string, readonly string[]> = {
  branch: ['action', 'name', 'from'],
  push: ['branch', 'remote', 'set_upstream', 'force'],
  merge: ['source', 'strategy'],
  stash: ['action', 'message'],
  reset: ['mode', 'target'],
  revert: ['commit', 'no_commit'],
  tag: ['action', 'name', 'message'],
  remote: ['action', 'name'],
  'cherry-pick': ['commit'],
};

export function createServer(deps: Deps = {}): McpServer {
  const clock = deps.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Orchestrates development against a git repository and a local task board. ' +
        'Start with task_list to see the work, git_status to see the repository, and ' +
        'board_get for the whole board. Write tools run on their own -- the policy ' +
        'layer decides what may happen, and a refusal names the rule that stopped it.',
    },
  );

  /** Resolve the locations and the policy for one call. */
  function context(project?: string) {
    const res = resolveCall(project);
    let policy = defaultPolicy();
    let policyError: string | undefined;
    try {
      policy = loadPolicy(res.policyPath);
    } catch (e) {
      // A broken policy file is reported by `policy_get`, but it must not
      // stop the read-only tools from working.
      policyError = e instanceof Error ? e.message : String(e);
    }
    return { res, policy, policyError };
  }

  /** The protected branch patterns, from the policy file or the defaults. */
  function protectedBranches(policy: ReturnType<typeof defaultPolicy>): string[] {
    return policy.file?.protected_branches ?? ['main', 'master', 'release/*'];
  }

  /** The commit-message pattern, from the policy file or the default. */
  function commitPattern(policy: ReturnType<typeof defaultPolicy>): string {
    return (
      policy.file?.commit_message_pattern ??
      '^(feat|fix|docs|refactor|test|chore|build|ci)(\\(.+\\))?: .+'
    );
  }

  /** Read the board, or return the error. */
  function loadBoardFor(path: string | null, root: string): { board: Board; hash: string; exists: boolean } | { error: ToolResult } {
    if (!path) {
      return {
        error: asError(
          `No board path could be resolved for '${root}'. Set ORCHESTRATOR_BOARD or ` +
            'pass a project path.',
        ),
      };
    }
    const read = readBoard(path, projectName(root), clock());
    if (!read.ok) return { error: asError(read.error) };
    return { board: read.board, hash: read.hash, exists: read.exists };
  }

  // =========================================================== 1. board_get
  server.registerTool(
    'board_get',
    {
      title: 'Get board',
      description:
        "Reads the project's task board: every task, its state, its dependencies and its " +
        'history. Returns the whole board, not a slice of it. ' +
        'Not covered by task_list, which filters and paginates.',
      inputSchema: {
        project: z.string().optional().describe('Project directory, relative to the working directory'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project }) => {
      const { res, policy, policyError } = context(project);
      const refused = permit('board.read', { project: res.root }, policy);
      if (refused) return refused;
      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;
      return asText({
        project: loaded.board.project,
        board_path: res.boardPath,
        board_exists: loaded.exists,
        schema_version: loaded.board.schema_version,
        updated_at: loaded.board.updated_at,
        task_count: loaded.board.tasks.length,
        tasks: loaded.board.tasks,
        policy_error: policyError,
      });
    },
  );

  // =========================================================== 2. board_set
  server.registerTool(
    'board_set',
    {
      title: 'Set board',
      description:
        "Replaces the project's task board wholesale. Every task in the supplied board " +
        'must satisfy the board schema and the board invariants. ' +
        'Not covered by task_create, task_update and task_move, which change one task at a time.',
      inputSchema: {
        board: z
          .object({
            schema_version: z.number(),
            project: z.string(),
            updated_at: z.string(),
            tasks: z.array(z.record(z.string(), z.unknown())),
          })
          .describe('The complete board'),
        project: z.string().optional().describe('Project directory, relative to the working directory'),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ board, project, dry_run }) => {
      const { res, policy } = context(project);
      const decision = evaluate('board.write', {}, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) return hold(decision);

      if (!res.boardPath) {
        return asError('No board path could be resolved. Set ORCHESTRATOR_BOARD or pass a project path.');
      }

      // Rebuild the incoming board through the same schema the reader
      // uses, so a board written here is indistinguishable from one that
      // was read from disk.
      //
      // The parse is not optional. A board that does not match the
      // schema is *refused* rather than written with its unknown fields
      // silently dropped -- otherwise the next read would return a
      // different board than the one that was written, and the caller
      // would never learn what happened to their fields.
      const parsed = parseBoard({ ...board, updated_at: clock() });
      if (!parsed.ok) {
        return asText({
          applied: false,
          written: 0,
          board_path: res.boardPath,
          error: parsed.error,
          note:
            'The board was refused because it does not match the board schema. ' +
            'Unknown fields are rejected rather than silently dropped.',
        });
      }
      const candidate = parsed.board;

      if (dry_run) {
        const violations = validateBoard(candidate);
        return asText({
          applied: false,
          dry_run: true,
          board_path: res.boardPath,
          tasks_written: candidate.tasks.length,
          written: 0,
          violations,
          note: `Dry run — nothing was written. ${candidate.tasks.length} task(s) planned.`,
        });
      }

      const result = writeBoard(res.boardPath, candidate, null);
      if (!result.ok) {
        return asText({
          applied: false,
          dry_run: false,
          board_path: res.boardPath,
          written: 0,
          violations: result.violations ?? [],
          error: result.error,
        });
      }
      return asText({
        applied: true,
        dry_run: false,
        board_path: res.boardPath,
        tasks_written: candidate.tasks.length,
        written: 1,
        violations: [],
        note: `${candidate.tasks.length} task(s) written.`,
      });
    },
  );

  // ========================================================== 3. task_list
  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description:
        'Lists tasks matching a filter: by state, label, assignee or free-text query. ' +
        'Returns task summaries with ids, titles and states. ' +
        'Not covered by board_get, which returns the whole board including history.',
      inputSchema: {
        project: z.string().optional(),
        state: z.string().optional().describe('Comma-separated states to include'),
        label: z.string().optional(),
        assignee: z.string().optional(),
        query: z.string().optional().describe('Free-text match against title and body'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, state, label, assignee, query, limit, offset }) => {
      const { res, policy } = context(project);
      const refused = permit('task.list', { project: res.root }, policy);
      if (refused) return refused;
      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;

      const states = state
        ? state
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '')
        : null;

      const q = query?.toLowerCase();
      const matches = loaded.board.tasks.filter((task) => {
        if (states && !states.includes(task.state)) return false;
        if (label && !task.labels.includes(label)) return false;
        if (assignee && task.assignee !== assignee) return false;
        if (q) {
          const haystack = `${task.title}\n${task.body}\n${task.id}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      });

      const page = matches.slice(offset, offset + limit);
      return asText({
        project: loaded.board.project,
        board_path: res.boardPath,
        total_matched: matches.length,
        returned: page.length,
        offset,
        truncated: offset + page.length < matches.length,
        note:
          offset + page.length < matches.length
            ? `Showing ${page.length} of ${matches.length} matches.`
            : `${page.length} match(es).`,
        tasks: page.map(summarize),
      });
    },
  );

  // =========================================================== 4. task_get
  server.registerTool(
    'task_get',
    {
      title: 'Get task',
      description:
        "Returns one task in full: its fields, its dependencies and its complete history. " +
        'Not covered by task_list, which returns summaries.',
      inputSchema: {
        id: z.string().min(1),
        project: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, project }) => {
      const { res, policy } = context(project);
      const refused = permit('task.get', { project: res.root }, policy);
      if (refused) return refused;
      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;

      const task = findTask(loaded.board, id);
      if (!task) {
        return asError(`Task '${id}' not found. Use task_list to find valid ids.`);
      }
      const blockers = blockersOf(loaded.board, task);
      return asText({
        ...task,
        project: loaded.board.project,
        board_path: res.boardPath,
        blocking_tasks: blockers.map((b) => ({ id: b.id, title: b.title, state: b.state })),
      });
    },
  );

  // ======================================================== 5. task_create
  server.registerTool(
    'task_create',
    {
      title: 'Create task',
      description:
        "Creates one task on the board in the given state. The new task's id is allocated " +
        'by the server. ' +
        'Not covered by board_set, which replaces the whole board.',
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().default(''),
        state: z.enum(TASK_STATES as [TaskState, ...TaskState[]]).default('todo'),
        labels: z.array(z.string()).default([]),
        assignee: z.string().nullable().default(null),
        blocked_by: z.array(z.string()).default([]),
        branch: z.string().nullable().default(null),
        parent: z.string().nullable().default(null).describe('The task this one is a piece of'),
        priority: z.number().int().optional().describe('Rank among its siblings; higher is more urgent'),
        locks: z.array(z.string()).default([]).describe('Paths this task holds locks on'),
        id: z.string().optional().describe('Explicit id; the server allocates one otherwise'),
        idempotency_key: z.string().optional().describe('A key that makes a retry create the task once'),
        project: z.string().optional(),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      const decision = evaluate('task.create', {}, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) return hold(decision);

      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;
      if (!res.boardPath) return asError('No board path could be resolved.');

      // An idempotency key makes the *id* deterministic: the same key
      // always names the same task, so a retry creates nothing new. The
      // key is turned into an id rather than stored separately, because
      // the board already has a unique-id field to hang it on.
      let id = args.id;
      let duplicate = false;
      if (!id && args.idempotency_key) {
        id = taskIdForKey(args.idempotency_key);
        const existing = findTask(loaded.board, id);
        if (existing) {
          return asText({
            applied: true,
            dry_run: false,
            id,
            created: false,
            duplicate: true,
            task: existing,
            board_path: res.boardPath,
            note: 'The idempotency key has already been used; the task was not created again.',
          });
        }
      }

      id = id ?? nextTaskId(loaded.board);
      if (findTask(loaded.board, id)) {
        return asError(`Task '${id}' already exists.`);
      }

      const now = clock();
      const task = newTask({
        id,
        title: args.title,
        body: args.body,
        state: args.state,
        labels: args.labels,
        assignee: args.assignee,
        blocked_by: args.blocked_by,
        branch: args.branch,
        parent: args.parent,
        priority: args.priority,
        locks: args.locks,
        now,
      });
      task.history = [
        { at: now, from: null, to: task.state, actor: 'orchestrator', note: 'created' },
      ];

      if (args.dry_run) {
        return asText({
          applied: false,
          dry_run: true,
          id,
          created: false,
          task,
          board_path: res.boardPath,
          note: 'Dry run — nothing was written.',
        });
      }

      const board: Board = { ...loaded.board, tasks: [...loaded.board.tasks, task], updated_at: now };
      const result = writeBoard(res.boardPath, board, loaded.exists ? loaded.hash : null);
      if (!result.ok) {
        return asText({ applied: false, created: false, error: result.error, violations: result.violations ?? [] });
      }
      return asText({
        applied: true,
        dry_run: false,
        id,
        created: true,
        task,
        board_path: res.boardPath,
      });
    },
  );

  // ======================================================== 6. task_update
  server.registerTool(
    'task_update',
    {
      title: 'Update task',
      description:
        "Updates the editable fields of one task: title, body, labels, assignee, branch, " +
        'dependencies, parent, priority or locks. Does not change the task\'s state, and ' +
        'does not append a note. ' +
        'Not covered by task_move, which changes the state, and task_note, which appends.',
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        assignee: z.string().nullable().optional(),
        blocked_by: z.array(z.string()).optional(),
        branch: z.string().nullable().optional(),
        parent: z.string().nullable().optional().describe('The task this one is a piece of'),
        priority: z.number().int().optional(),
        locks: z.array(z.string()).optional().describe('Paths this task holds locks on'),
        project: z.string().optional(),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      const decision = evaluate('task.update', {}, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) return hold(decision);

      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;
      if (!res.boardPath) return asError('No board path could be resolved.');

      const existing = findTask(loaded.board, args.id);
      if (!existing) return asError(`Task '${args.id}' not found. Use task_list to find valid ids.`);

      const changed: string[] = [];
      const now = clock();
      let updated: Task = { ...existing };

      const apply = <K extends keyof Task>(key: K, value: Task[K] | undefined): void => {
        if (value === undefined) return;
        if (JSON.stringify(updated[key]) === JSON.stringify(value)) return;
        updated = { ...updated, [key]: value };
        changed.push(String(key));
      };

      apply('title', args.title);
      apply('body', args.body);
      apply('labels', args.labels);
      apply('assignee', args.assignee);
      apply('blocked_by', args.blocked_by);
      apply('branch', args.branch);
      apply('parent', args.parent);
      apply('priority', args.priority);
      apply('locks', args.locks);

      if (changed.length === 0) {
        return asText({ applied: false, id: args.id, updated: [], task: existing, note: 'Nothing to update.' });
      }

      updated.updated_at = now;
      updated = appendHistory(updated, {
        at: now,
        from: existing.state,
        to: existing.state,
        actor: 'orchestrator',
        note: `updated ${changed.join(', ')}`,
      });

      const board = replaceTask(loaded.board, updated);
      if (args.dry_run) {
        return asText({
          applied: false,
          dry_run: true,
          id: args.id,
          updated: changed,
          task: updated,
          board_path: res.boardPath,
          note: 'Dry run — nothing was written.',
        });
      }
      const result = writeBoard(res.boardPath, board, loaded.exists ? loaded.hash : null);
      if (!result.ok) {
        return asText({ applied: false, id: args.id, updated: [], error: result.error });
      }
      return asText({
        applied: true,
        dry_run: false,
        id: args.id,
        updated: changed,
        task: updated,
        board_path: res.boardPath,
      });
    },
  );

  // ========================================================== 7. task_move
  server.registerTool(
    'task_move',
    {
      title: 'Move task',
      description:
        'Moves one task to a new state. The transition must be permitted by the task state ' +
        'machine; a gated transition holds and reports the missing condition. ' +
        'Not covered by task_update, which does not change state.',
      inputSchema: {
        id: z.string().min(1),
        to: z.enum(TASK_STATES as [TaskState, ...TaskState[]]),
        reason: z.string().default(''),
        note: z.string().default(''),
        actor: z.string().default('orchestrator'),
        project: z.string().optional(),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);

      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;
      if (!res.boardPath) return asError('No board path could be resolved.');

      const existing = findTask(loaded.board, args.id);
      if (!existing) return asError(`Task '${args.id}' not found. Use task_list to find valid ids.`);

      // 1. The state machine decides whether the transition exists at all.
      const transition = canTransition(existing.state, args.to);
      if (transition.kind === 'refused') {
        return asText({
          applied: false,
          refused: true,
          rule: transition.rule,
          id: args.id,
          from: existing.state,
          to: args.to,
          reason: transition.reason,
        });
      }

      // 2. A dependency that is not done blocks entry into in_progress.
      if (args.to === 'in_progress') {
        const blockers = dependencyBlockers(loaded.board, existing);
        if (blockers.length > 0) {
          return asText({
            applied: false,
            refused: true,
            rule: 'ST-DEP',
            id: args.id,
            from: existing.state,
            to: args.to,
            reason:
              `Task '${args.id}' is blocked by ${blockers.length} unfinished task(s) and ` +
              'may not enter in_progress.',
            blocking_tasks: blockers.map((b) => ({ id: b.id, title: b.title, state: b.state })),
          });
        }
      }

      // 3. The policy gates the transition. A cancellation needs a reason;
      //    a completion needs a commit on the task's branch.
      const isCancellation = args.to === 'cancelled';
      const isCompletion = args.to === 'done';
      const operation = isCancellation ? 'task.cancel' : isCompletion ? 'task.complete' : 'task.move';

      const ctx: PolicyContext = {
        project: res.root,
        reason: args.reason,
        note: args.note,
        branch: existing.branch ?? undefined,
        args: {},
      };

      if (isCompletion) {
        // PR-3: the task's branch must have a commit the base does not.
        const repo = res.repoRoot;
        let commitPresent = false;
        let branchForCheck = existing.branch;
        if (repo && branchForCheck) {
          const base = defaultBranch(repo) ?? fallbackDefaultBranch();
          commitPresent = hasCommitsAhead(base, branchForCheck, repo);
        }

        // PR-54: the task's branch tip must have a verifier run record.
        //
        // The branch tip is resolved directly with `rev-parse`, not
        // from a `base..branch` range. The range form compares the
        // branch against the base, which is empty when the task's
        // branch *is* the base -- and a task on the default branch
        // would never be verifiable. Resolving the tip avoids that
        // trap entirely.
        //
        // The record's digest is re-checked by `verifyCommit`, so a
        // record that was edited after the fact does not open the gate.
        let verifyPresent = false;
        let verification: VerificationStatus | null = null;
        if (repo && branchForCheck) {
          const tip = resolveRef(branchForCheck, repo);
          verification = verifyCommit(repo, tip);
          verifyPresent = verification.verified;
        }

        ctx.args = {
          commit_present: commitPresent,
          verify_present: verifyPresent,
        };

        // The reason the gate held is worth carrying into the
        // refusal: "there is no run record" and "the check failed" are
        // different problems, and the caller has to do different things
        // about them.
        if (!verifyPresent && verification) {
          ctx.args['verify_reason'] = verification.reason;
        }
      }

      const decision = evaluate(operation, ctx, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        return asText({
          applied: false,
          gated: true,
          gate: decision.rule,
          id: args.id,
          from: existing.state,
          to: args.to,
          reason: decision.reason,
          hint: decision.hint,
          // The specific reason the verification gate held --
          // "no run record" versus "the check failed" are different
          // problems, and the caller has to do different things
          // about them. Carried only for the gate that produced it.
          verify_reason: ctx.args?.['verify_reason'],
          task: existing,
        });
      }

      // 4. Apply.
      const now = clock();
      let updated: Task = { ...existing, state: args.to, updated_at: now };
      updated = appendHistory(updated, {
        at: now,
        from: existing.state,
        to: args.to,
        actor: args.actor,
        note: args.note || args.reason,
      });

      const board = replaceTask(loaded.board, updated);
      if (args.dry_run) {
        return asText({
          applied: false,
          dry_run: true,
          id: args.id,
          from: existing.state,
          to: args.to,
          task: updated,
          board_path: res.boardPath,
          note: 'Dry run — nothing was written.',
        });
      }
      const result = writeBoard(res.boardPath, board, loaded.exists ? loaded.hash : null);
      if (!result.ok) {
        return asText({ applied: false, id: args.id, error: result.error });
      }
      return asText({
        applied: true,
        dry_run: false,
        id: args.id,
        from: existing.state,
        to: args.to,
        task: updated,
        board_path: res.boardPath,
      });
    },
  );

  // ======================================================== 8. task_delete
  server.registerTool(
    'task_delete',
    {
      title: 'Delete task',
      description:
        "Deletes one task from the board. A task in the 'done' state cannot be deleted. " +
        'Not covered by task_move, which changes a task\'s state.',
      inputSchema: {
        id: z.string().min(1),
        confirm: z.boolean().default(false),
        project: z.string().optional(),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);

      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;
      if (!res.boardPath) return asError('No board path could be resolved.');

      const existing = findTask(loaded.board, args.id);
      if (!existing) return asError(`Task '${args.id}' not found. Use task_list to find valid ids.`);

      if (existing.state === 'done') {
        return asText({
          applied: false,
          refused: true,
          rule: 'PR-37',
          id: args.id,
          reason: `Task '${args.id}' is done and cannot be deleted. Its history is the record that it was finished.`,
        });
      }

      const decision = evaluate('task.delete', { confirm: args.confirm }, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        return asText({
          applied: false,
          gated: true,
          gate: decision.rule,
          id: args.id,
          reason: decision.reason,
          hint: decision.hint,
          status: 'planned',
        });
      }

      const now = clock();
      const board: Board = {
        ...retireId(loaded.board, args.id),
        tasks: loaded.board.tasks.filter((t) => t.id !== args.id),
        updated_at: now,
      };
      if (args.dry_run) {
        return asText({
          applied: false,
          dry_run: true,
          id: args.id,
          deleted: 0,
          status: 'planned',
          board_path: res.boardPath,
          note: 'Dry run — nothing was deleted.',
        });
      }
      const result = writeBoard(res.boardPath, board, loaded.exists ? loaded.hash : null);
      if (!result.ok) {
        return asText({ applied: false, id: args.id, deleted: 0, status: 'error', reason: result.error });
      }
      return asText({
        applied: true,
        dry_run: false,
        id: args.id,
        deleted: 1,
        status: 'deleted',
        board_path: res.boardPath,
      });
    },
  );

  // ========================================================== 9. task_next
  server.registerTool(
    'task_next',
    {
      title: 'Next task',
      description:
        'Chooses the next task to work on and explains why it was chosen. The ranking is ' +
        'deterministic: the same board always produces the same answer. ' +
        'Not covered by task_list, which lists everything and does not choose.',
      inputSchema: {
        project: z.string().optional(),
        assignee: z.string().optional().describe('Only consider tasks with this assignee'),
        label: z.string().optional(),
        state: z.string().optional().describe('Comma-separated states to consider'),
        limit: z.number().int().min(1).max(50).default(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      const refused = permit('task.next', { project: res.root }, policy);
      if (refused) return refused;
      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;

      const states = args.state
        ? args.state
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '')
        : null;

      const now = clock();
      const candidates = loaded.board.tasks.filter((task) => {
        // Only work that can be started.
        if (task.state === 'done' || task.state === 'cancelled') return false;
        if (task.state === 'blocked') return false;
        if (states && !states.includes(task.state)) return false;
        if (args.assignee && task.assignee !== args.assignee) return false;
        if (args.label && !task.labels.includes(args.label)) return false;
        // A task with an unfinished dependency cannot be started.
        if (blockersOf(loaded.board, task).length > 0) return false;
        // A task somebody else holds a live claim on is not available.
        if (claimIsLive(task, now)) return false;
        return true;
      });

      // The ranking, in order:
      //
      //   1. higher priority first -- the number is the urgency;
      //   2. then the most recently updated, so a task somebody has
      //      just touched comes before one nobody has;
      //   3. then the task id, so the order is total and the answer
      //      does not depend on the order the tasks happen to be in.
      //
      // The last step is what makes it deterministic. Two agents
      // asking at the same moment get the same task.
      const ranked = [...candidates].sort((a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pa !== pb) return pb - pa;
        if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      const page = ranked.slice(0, args.limit);
      return asText({
        project: loaded.board.project,
        board_path: res.boardPath,
        considered: loaded.board.tasks.length,
        eligible: ranked.length,
        returned: page.length,
        next: page[0] ?? null,
        tasks: page.map(summarize),
        note:
          page.length === 0
            ? 'No task is available: everything is blocked, claimed, done or filtered out.'
            : `${page.length} task(s) returned, ranked by priority, then by most recently updated.`,
      });
    },
  );

  // ======================================================== 10. task_claim
  server.registerTool(
    'task_claim',
    {
      title: 'Claim task',
      description:
        'Claims a task for an agent, or releases a claim, or renews a lease. A claim ' +
        'carries a lease: once the lease lapses the task is available again. ' +
        'Not covered by task_update, which changes a task\'s fields but not its claim.',
      inputSchema: {
        id: z.string().min(1),
        action: z.enum(['claim', 'release', 'heartbeat']).default('claim'),
        agent: z.string().min(1).default('orchestrator').describe('The claiming agent\'s label'),
        idempotency_key: z.string().optional().describe('A key that makes a retry claim once'),
        lease_seconds: z.number().int().min(30).max(86_400).default(900),
        project: z.string().optional(),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);

      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;
      if (!res.boardPath) return asError('No board path could be resolved.');

      const existing = findTask(loaded.board, args.id);
      if (!existing) return asError(`Task '${args.id}' not found. Use task_list to find valid ids.`);

      const now = clock();
      const nowMs = Date.parse(now);
      const claim = existing.claim ?? null;

      if (args.action === 'release') {
        // Releasing a claim is always allowed -- it gives the task
        // back, and it cannot make anything worse.
        if (!claim) {
          return asText({
            applied: false,
            id: args.id,
            released: 0,
            reason: `Task '${args.id}' is not claimed.`,
          });
        }
        const updated: Task = { ...existing, claim: null, updated_at: now };
        const board = replaceTask(loaded.board, updated);
        if (args.dry_run) {
          return asText({
            applied: false,
            dry_run: true,
            id: args.id,
            released: 0,
            board_path: res.boardPath,
            note: 'Dry run — nothing was written.',
          });
        }
        const result = writeBoard(res.boardPath, board, loaded.exists ? loaded.hash : null);
        if (!result.ok) return asText({ applied: false, id: args.id, error: result.error });
        return asText({
          applied: true,
          dry_run: false,
          id: args.id,
          released: 1,
          task: updated,
          board_path: res.boardPath,
        });
      }

      // PR-48: a task must be claimable -- unblocked, and not held by
      // somebody else's live claim.
      const blockers = blockersOf(loaded.board, existing);
      const claimable = blockers.length === 0 && !claimIsLive(existing, now);
      const ctx: PolicyContext = {
        project: res.root,
        args: { claimable },
      };

      // A retry with the same key returns the claim that is already
      // there, rather than a refusal or a fresh lease. Without this a
      // network retry would look like a second agent competing for the
      // task, and the caller would be told to back off from a claim it
      // already holds.
      if (args.idempotency_key && claim && claim.idempotency_key === args.idempotency_key) {
        return asText({
          applied: true,
          dry_run: false,
          id: args.id,
          claimed: true,
          duplicate: true,
          claim,
          task: existing,
          board_path: res.boardPath,
          note: 'The idempotency key has already been used; the existing claim was returned unchanged.',
        });
      }
      const decision = evaluate('task.claim', ctx, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        // The refusal names what is in the way, rather than only
        // saying "not claimable".
        const reason = blockers.length
          ? `Task '${args.id}' is blocked by ${blockers.length} unfinished task(s) and cannot be claimed.`
          : `Task '${args.id}' is claimed by '${claim?.agent}' until ${claim?.lease_expires_at}.`;
        return asText({
          applied: false,
          gated: true,
          gate: decision.rule,
          operation: 'task.claim',
          id: args.id,
          reason,
          hint: decision.hint,
          blocking_tasks: blockers.map((b) => ({ id: b.id, title: b.title, state: b.state })),
          current_claim: claim,
        });
      }

      // A heartbeat renews an existing claim by the same agent; a claim
      // takes one that is free. An expired lease is free.
      const expiresAt = new Date(nowMs + args.lease_seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const updated: Task = {
        ...existing,
        claim: {
          agent: args.agent,
          at: now,
          lease_expires_at: expiresAt,
          ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}),
        },
        updated_at: now,
      };
      updated.history = appendHistory(updated, {
        at: now,
        from: existing.state,
        to: existing.state,
        actor: args.agent,
        note: args.action === 'heartbeat' ? `claim renewed until ${expiresAt}` : `claimed until ${expiresAt}`,
      }).history;

      const board = replaceTask(loaded.board, updated);
      if (args.dry_run) {
        return asText({
          applied: false,
          dry_run: true,
          id: args.id,
          claimed: false,
          claim: updated.claim,
          board_path: res.boardPath,
          note: 'Dry run — nothing was written.',
        });
      }
      const result = writeBoard(res.boardPath, board, loaded.exists ? loaded.hash : null);
      if (!result.ok) return asText({ applied: false, id: args.id, error: result.error });
      return asText({
        applied: true,
        dry_run: false,
        id: args.id,
        claimed: true,
        action: args.action,
        claim: updated.claim,
        task: updated,
        board_path: res.boardPath,
      });
    },
  );

  // ========================================================= 11. task_note
  server.registerTool(
    'task_note',
    {
      title: 'Add note',
      description:
        'Appends a note to a task. Notes are append-only and each carries its own author ' +
        'and timestamp. A note does not change the task\'s state. ' +
        'Not covered by task_update, which changes a task\'s fields rather than appending to it.',
      inputSchema: {
        id: z.string().min(1),
        text: z.string().min(1).max(4000),
        actor: z.string().min(1).default('orchestrator'),
        idempotency_key: z.string().optional().describe('A key that makes a retry append the note once'),
        project: z.string().optional(),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      const decision = evaluate('task.note', { project: res.root }, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) return hold(decision);

      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;
      if (!res.boardPath) return asError('No board path could be resolved.');

      const existing = findTask(loaded.board, args.id);
      if (!existing) return asError(`Task '${args.id}' not found. Use task_list to find valid ids.`);

      const now = clock();
      // An idempotency key makes a retry safe: the same key on the same
      // task appends the note once, not twice. Without the key the
      // note is appended every time, which is what a caller that did
      // not ask for the guarantee expects.
      if (args.idempotency_key) {
        const already = (existing.notes ?? []).find((n) => n.idempotency_key === args.idempotency_key);
        if (already) {
          return asText({
            applied: true,
            dry_run: false,
            id: args.id,
            notes_added: 0,
            duplicate: true,
            appended_note: already,
            notes: existing.notes ?? [],
            task: existing,
            board_path: res.boardPath,
            note: 'The idempotency key has already been used on this task; nothing was appended.',
          });
        }
      }

      const note = {
        at: now,
        actor: args.actor,
        text: args.text,
        ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}),
      };
      const updated: Task = {
        ...existing,
        notes: [...(existing.notes ?? []), note],
        updated_at: now,
      };

      const board = replaceTask(loaded.board, updated);
      if (args.dry_run) {
        return asText({
          applied: false,
          dry_run: true,
          id: args.id,
          notes_added: 0,
          pending_note: note,
          board_path: res.boardPath,
          note: 'Dry run — nothing was written.',
        });
      }
      const result = writeBoard(res.boardPath, board, loaded.exists ? loaded.hash : null);
      if (!result.ok) return asText({ applied: false, id: args.id, error: result.error });
      return asText({
        applied: true,
        dry_run: false,
        id: args.id,
        notes_added: 1,
        note,
        notes: updated.notes,
        task: updated,
        board_path: res.boardPath,
      });
    },
  );

  // ========================================================= 9. git_status
  server.registerTool(
    'git_status',
    {
      title: 'Git status',
      description:
        'Reports the working tree status of the repository: staged, unstaged and untracked ' +
        'paths, the current branch, and the upstream. ' +
        'Not covered by git_diff, which reports content differences.',
      inputSchema: {
        project: z.string().optional(),
        porcelain: z.boolean().default(false).describe('Return the raw porcelain output instead of the parsed form'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, porcelain }) => {
      const { res, policy } = context(project);

      // PR-8: the path is not inside a repository. The rule is in the
      // table, so the table decides -- but the context has to carry the
      // fact, because only the caller knows whether there is a repo.
      const refused = permit(
        'git.status',
        { project: res.root, args: { not_in_repository: !res.repoRoot } },
        policy,
      );
      if (refused) return refused;

      if (!res.repoRoot) {
        return asText({
          applied: false,
          denied: true,
          rule: 'PR-8',
          operation: 'git.status',
          reason: 'The project is not inside a git repository, so there is no status to report.',
          hint: 'Pass a project path that is a repository, or run the server from one.',
        });
      }

      const result = runGit(porcelain ? buildStatusPorcelain() : buildStatus(), res.repoRoot);
      if (result.status !== 'ok') {
        return asText({ project: res.root, error: result.stderr || 'git status failed' });
      }

      if (porcelain) {
        return asText({ project: res.root, repo_root: res.repoRoot, porcelain: true, raw: result.stdout });
      }

      const status = parseStatus(result.stdout);
      return asText({
        project: res.root,
        repo_root: res.repoRoot,
        branch: status.branch,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        clean: status.clean,
        staged: status.staged,
        unstaged: status.unstaged,
        untracked: status.untracked,
        raw: status.raw,
      });
    },
  );

  // ========================================================== 10. git_diff
  server.registerTool(
    'git_diff',
    {
      title: 'Git diff',
      description:
        'Reports content differences in the repository: between the working tree and the ' +
        'index, between two commits, or for one path. ' +
        'Not covered by git_status, which reports which paths changed but not how.',
      inputSchema: {
        project: z.string().optional(),
        staged: z.boolean().default(false),
        base: z.string().optional().describe('The base of a range comparison'),
        head: z.string().optional().describe('The head of a range comparison'),
        path: z.string().optional(),
        stat: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      const refused = permit(
        'git.diff',
        { project: res.root, args: { not_in_repository: !res.repoRoot } },
        policy,
      );
      if (refused) return refused;
      if (!res.repoRoot) {
        return asError('The project is not inside a git repository, so there is no diff to report.');
      }

      if (args.base && !args.head) {
        return asError('A base needs a head: pass both, or neither.');
      }
      if (args.base && args.head) {
        for (const rev of [args.base, args.head]) {
          const check = validRevision(rev);
          if (!check.ok) return asError(`Invalid revision: ${check.reason}`);
        }
      }
      if (args.path) {
        const check = validPath(res.repoRoot, args.path);
        if (!check.ok) return asError(`Invalid path: ${check.reason}`);
      }

      const argv = buildDiff(args);
      const result = runGit(argv, res.repoRoot);
      if (result.status !== 'ok') {
        return asText({ project: res.root, error: result.stderr || 'git diff failed', argv: result.argv });
      }

      const cap = Number.parseInt(process.env['ORCHESTRATOR_MAX_DIFF_BYTES'] ?? '200000', 10);
      const truncated = result.stdout.length > cap;

      let stat = '';
      if (args.stat) {
        // The stat has to describe the same changes as the diff above
        // it. A hardcoded working-tree stat beside a staged diff
        // describes a different set of files entirely.
        const statResult = runGit(buildDiffStat(args), res.repoRoot);
        stat = statResult.stdout;
      }

      return asText({
        project: res.root,
        repo_root: res.repoRoot,
        mode: args.base && args.head ? 'range' : args.path ? 'path' : args.staged ? 'staged' : 'worktree',
        argv: result.argv,
        files_changed: result.stdout ? result.stdout.split('\n').filter((l) => l.startsWith('diff --git')).length : 0,
        diff: truncated ? result.stdout.slice(0, cap) : result.stdout,
        truncated,
        stat,
      });
    },
  );

  // =========================================================== 11. git_log
  server.registerTool(
    'git_log',
    {
      title: 'Git log',
      description:
        'Reports the commit history of the repository, optionally scoped to one path or one ' +
        'branch. Returns commit ids, subjects, authors and dates. ' +
        'Not covered by git_diff, which reports differences between two points.',
      inputSchema: {
        project: z.string().optional(),
        branch: z.string().optional(),
        path: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(20),
        since: z.string().optional(),
        until: z.string().optional(),
        grep: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      const refused = permit(
        'git.log',
        { project: res.root, args: { not_in_repository: !res.repoRoot } },
        policy,
      );
      if (refused) return refused;
      if (!res.repoRoot) {
        return asError('The project is not inside a git repository, so there is no history to report.');
      }

      if (args.branch) {
        const check = validName(args.branch);
        if (!check.ok) return asError(`Invalid branch: ${check.reason}`);
      }
      if (args.path) {
        const check = validPath(res.repoRoot, args.path);
        if (!check.ok) return asError(`Invalid path: ${check.reason}`);
      }

      const argv = buildLog({
        limit: args.limit,
        path: args.path,
        grep: args.grep,
        since: args.since,
        until: args.until,
        branch: args.branch,
      });

      const result = runGit(argv, res.repoRoot);
      if (result.status !== 'ok') {
        return asText({ project: res.root, error: result.stderr || 'git log failed', argv: result.argv });
      }
      const commits = parseLog(result.stdout);
      return asText({
        project: res.root,
        repo_root: res.repoRoot,
        branch: args.branch ?? currentBranch(res.repoRoot),
        total: commits.length,
        commits,
      });
    },
  );

  // ======================================================== 12. git_commit
  server.registerTool(
    'git_commit',
    {
      title: 'Git commit',
      description:
        "Commits the staged changes, or the given paths, in the repository. The message " +
        "must match the repository's commit convention. " +
        'Not covered by git_diff, which reports what changed but records nothing.',
      inputSchema: {
        project: z.string().optional(),
        message: z.string().min(1).max(500),
        paths: z.array(z.string()).default([]).describe('Paths to commit; empty commits everything staged'),
        include_untracked: z.boolean().default(false).describe('Add untracked files to the commit'),
        dry_run: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      if (!res.repoRoot) {
        return asError('The project is not inside a git repository, so there is nothing to commit.');
      }

      // PR-11: a path that escapes the repository is refused. The check
      // is here rather than in the policy because the policy needs the
      // path resolved against the repository root, which only the caller
      // knows.
      for (const p of args.paths) {
        const check = validPath(res.repoRoot, p);
        if (!check.ok) {
          return denial({
            rule: 'PR-11',
            operation: 'git.commit',
            reason: `Refusing to commit '${p}': ${check.reason}.`,
            hint: 'Use paths inside the repository.',
          });
        }
      }

      // PR-9: the message must match the repository's convention.
      //
      // The check lives in the policy layer, on its own operation scope,
      // so a repository can tighten the pattern in its policy file. The
      // pattern travels in the context and the rule's evidence case
      // tests it -- the same shape as every other conditional rule.
      const pattern = commitPattern(policy);
      const messageDecision = evaluate(
        'git.commit.message',
        { project: res.root, message: args.message, args: { message_pattern: pattern } },
        policy,
      );
      if (messageDecision.verdict === 'deny') {
        return denial({ ...messageDecision, operation: 'git.commit.message' });
      }
      if (messageDecision.verdict === 'conditional' && !messageDecision.satisfied) {
        return asText({
          applied: false,
          denied: true,
          rule: messageDecision.rule,
          operation: 'git.commit.message',
          reason: `The commit message does not match the repository's convention: ${pattern}`,
          hint: "Use a message like 'feat: add the parser'.",
        });
      }

      // PR-10: adding untracked files must be asked for explicitly.
      //
      // This is evaluated only when untracked files were asked for,
      // because PR-10's evidence *is* `include_untracked`. Evaluating
      // it unconditionally would hold every ordinary commit.
      if (args.include_untracked) {
        const decision = evaluate('git.commit', { include_untracked: true, message: args.message }, policy);
        if (decision.verdict === 'deny') return denial(decision);
        if (decision.verdict === 'conditional' && !decision.satisfied) return hold(decision);
      }

      const staged = runGit(buildStagedNames(), res.repoRoot);
      const stagedFiles = staged.stdout.split('\n').filter((l) => l.trim() !== '');

      const argv = buildCommit(args.message, args.paths);
      if (args.dry_run) {
        return asText({
          dry_run: true,
          project: res.root,
          argv: ['git', ...argv],
          staged_files: stagedFiles,
          status: 'planned',
          commit_hash: null,
          stdout: '',
          stderr: '',
          note: 'Dry run — nothing was committed.',
        });
      }

      // Adding untracked files is a separate git invocation, and it is
      // the one that can pick up a file nobody meant to commit. So it
      // happens only when it was asked for, and it happens for the named
      // paths when there are any -- otherwise for everything untracked.
      if (args.include_untracked) {
        const addArgv =
          args.paths.length > 0
            ? buildAdd(args.paths)
            : ['add', '--all', '--', '.'];
        const add = runGit(addArgv, res.repoRoot);
        if (add.status !== 'ok') {
          return asText({ applied: false, project: res.root, error: add.stderr || 'git add failed', argv: add.argv });
        }
      }

      const result = runGit(argv, res.repoRoot);
      if (result.status !== 'ok') {
        return asText({
          applied: false,
          project: res.root,
          argv: result.argv,
          status: 'error',
          exit_code: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }

      const hash = runGit(buildHeadShort(), res.repoRoot).stdout.trim();
      return asText({
        applied: true,
        dry_run: false,
        project: res.root,
        argv: result.argv,
        staged_files: stagedFiles,
        status: 'committed',
        commit_hash: hash,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
  );

  // ======================================================= 13. git_operate
  server.registerTool(
    'git_operate',
    {
      title: 'Git operate',
      description:
        'Runs one git operation from the fixed command surface: branch, push, merge, stash, ' +
        'reset, revert, tag or remote. The operation is named explicitly and each one maps to ' +
        'exactly one argv array. ' +
        'Not covered by git_status, git_diff, git_log or git_commit, which cover the read ' +
        'operations and committing.',
      inputSchema: {
        project: z.string().optional(),
        operation: z.enum(['branch', 'push', 'merge', 'stash', 'reset', 'revert', 'tag', 'remote', 'cherry-pick']),
        args: z.record(z.string(), z.unknown()).default({}),
        confirm: z.boolean().default(false),
        discard: z.boolean().default(false),
        force: z.boolean().default(false),
        dry_run: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      if (!res.repoRoot) {
        return asError('The project is not inside a git repository, so there is nothing to operate on.');
      }

      const repo = res.repoRoot;
      const opArgs = args.args;

      // An unrecognised argument is refused by name rather than
      // dropped. A typo in an argument that chooses a path is not a
      // harmless mistake.
      const allowed = OPERATE_ARGS[args.operation];
      const unknown = Object.keys(opArgs).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) {
        return asError(
          `git_operate ${args.operation} does not accept ${unknown.map((k) => `'${k}'`).join(', ')}. ` +
            `It accepts ${allowed.map((k) => `'${k}'`).join(', ')}.`,
        );
      }

      const asString = (key: string): string | undefined => {
        const value = opArgs[key];
        return typeof value === 'string' && value !== '' ? value : undefined;
      };
      const asBool = (key: string): boolean => opArgs[key] === true;

      // Build the argv, and evaluate the policy that governs it, before
      // anything runs. The order matters: a refusal must happen before
      // the spawn, not after.
      let argv: string[];
      let operation: string;
      const ctx: PolicyContext = {
        project: repo,
        confirm: args.confirm,
        discard: args.discard,
        force: args.force,
        args: { ...opArgs },
      };

      switch (args.operation) {
        case 'branch': {
          const action = asString('action');
          const name = asString('name');
          const from = asString('from');
          if (!action) return asError("git_operate branch needs an 'action'.");
          if (action !== 'list' && !name) {
            return asError(`git_operate branch ${action} needs a 'name'.`);
          }
          if (name) {
            const check = validName(name);
            if (!check.ok) return asError(`Invalid branch name: ${check.reason}`);
          }
          if (from) {
            const check = validRevision(from);
            if (!check.ok) return asError(`Invalid 'from': ${check.reason}`);
          }

          if (action === 'create') {
            operation = 'git.branch.create';
            argv = buildBranch('create', name, from);
          } else if (action === 'delete') {
            operation = 'git.branch.delete';
            // PR-13: an unmerged branch needs an explicit force.
            //
            // "Merged" is measured against the *base* branch, not
            // against HEAD. `git branch --merged` lists the branches
            // reachable from HEAD, and a branch is always reachable
            // from itself -- so checking against HEAD would report
            // every branch as merged, and the guard would never fire.
            const base = defaultBranch(repo) ?? fallbackDefaultBranch();
            const mergedIntoBase = runGit(buildMergedBranches(base), repo).stdout;
            const isMerged = mergedIntoBase
              .split('\n')
              .some((l) => l.trim().replace(/^\* /, '') === name);
            ctx.args = { ...ctx.args, force: args.force || isMerged, tree_clean: true };
            argv = buildBranch(args.force ? 'delete-force' : 'delete', name);
          } else if (action === 'list') {
            operation = 'git.branch.list';
            argv = buildBranch('list');
          } else if (action === 'checkout') {
            operation = 'git.checkout';
            ctx.args = { ...ctx.args, tree_clean: treeClean(repo) };
            argv = buildBranch('checkout', name);
          } else {
            return asError(`Unknown branch action '${action}'. Use create, delete, list or checkout.`);
          }
          break;
        }

        case 'push': {
          const branch = asString('branch') ?? currentBranch(repo);
          const remote = asString('remote') ?? 'origin';
          const setUpstream = opArgs['set_upstream'] !== false;
          const nameCheck = validName(branch);
          if (!nameCheck.ok) return asError(`Invalid branch name: ${nameCheck.reason}`);
          const remoteCheck = validName(remote);
          if (!remoteCheck.ok) return asError(`Invalid remote name: ${remoteCheck.reason}`);

          operation = 'git.push';
          ctx.branch = branch;
          ctx.args = {
            ...ctx.args,
            branch,
            remote,
            branch_protected: isProtectedBranch(branch, protectedBranches(policy)),
            force_push: args.force === true || opArgs['force'] === true,
          };
          argv = buildPush(branch, remote, setUpstream);
          break;
        }

        case 'merge': {
          const source = asString('source');
          const strategy = asString('strategy') ?? 'merge';
          if (!source) return asError("git_operate merge needs a 'source'.");
          const check = validRevision(source);
          if (!check.ok) return asError(`Invalid source: ${check.reason}`);

          if (strategy === 'squash') {
            return denial({
              rule: 'PR-19',
              operation: 'git.merge',
              reason: 'Squash merges are refused: they discard the individual commits.',
              hint: 'Use merge or rebase.',
            });
          }
          if (strategy !== 'merge' && strategy !== 'rebase') {
            return asError(`Unknown merge strategy '${strategy}'. Use merge or rebase.`);
          }
          operation = 'git.merge';
          ctx.strategy = strategy;
          ctx.source = source;
          ctx.args = { ...ctx.args, source, strategy };
          argv = buildMerge(source, strategy);
          break;
        }

        case 'stash': {
          const action = asString('action');
          const message = asString('message') ?? '';
          if (!action) return asError("git_operate stash needs an 'action'.");
          // One operation, two rules: PR-23 allows stashing, and PR-24
          // holds a *drop* until it is confirmed. The action travels in
          // the context, so the policy can tell a push from a drop.
          operation = 'git.stash';
          ctx.args = { ...ctx.args, action };
          argv = buildStash(action, message);
          break;
        }

        case 'reset': {
          const mode = asString('mode') ?? 'mixed';
          const target = asString('target') ?? 'HEAD';
          const targetCheck = validRevision(target);
          if (!targetCheck.ok) return asError(`Invalid target: ${targetCheck.reason}`);

          operation = 'git.reset';
          ctx.mode = mode;
          ctx.args = { ...ctx.args, mode, target };
          argv = buildReset(mode, target);
          break;
        }

        case 'revert': {
          const commit = asString('commit');
          if (!commit) return asError("git_operate revert needs a 'commit'.");
          const check = validRevision(commit);
          if (!check.ok) return asError(`Invalid commit: ${check.reason}`);
          operation = 'git.revert';
          argv = buildRevert(commit, asBool('no_commit'));
          break;
        }

        case 'tag': {
          const action = asString('action');
          const name = asString('name');
          const message = asString('message');
          if (!action) return asError("git_operate tag needs an 'action'.");
          if (action !== 'list' && !name) return asError(`git_operate tag ${action} needs a 'name'.`);
          if (name) {
            const check = validName(name);
            if (!check.ok) return asError(`Invalid tag name: ${check.reason}`);
          }
          operation = action === 'delete' ? 'git.tag.delete' : 'git.tag.create';
          ctx.args = { ...ctx.args, action, name };
          argv = buildTag(action, name, message);
          break;
        }

        case 'remote': {
          const action = asString('action');
          const name = asString('name') ?? 'origin';
          if (!action) return asError("git_operate remote needs an 'action'.");
          const nameCheck = validName(name);
          if (!nameCheck.ok) return asError(`Invalid remote name: ${nameCheck.reason}`);

          // Each action maps to its own operation, so the policy governs
          // them separately. Listing remotes is not adding one.
          if (action === 'add') {
            operation = 'git.remote.add';
          } else if (action === 'set-url') {
            operation = 'git.remote.set-url';
          } else if (action === 'fetch') {
            operation = 'git.fetch';
          } else if (action === 'pull') {
            operation = 'git.pull';
          } else if (action === 'list' || action === 'show') {
            operation = 'git.remote.list';
          } else {
            return asError(`Unknown remote action '${action}'. Use list, show, fetch or pull.`);
          }
          ctx.args = { ...ctx.args, action, name };
          argv = buildRemote(action, name);
          break;
        }

        case 'cherry-pick': {
          const commit = asString('commit');
          if (!commit) return asError("git_operate cherry-pick needs a 'commit'.");
          const check = validRevision(commit);
          if (!check.ok) return asError(`Invalid commit: ${check.reason}`);

          // PR-49: a cherry-pick must name a commit, and the tree must
          // be clean. A cherry-pick onto a dirty tree can leave the
          // changes half-applied and the index in a state nobody
          // planned for.
          operation = 'git.cherry-pick';
          ctx.args = { ...ctx.args, commit, tree_clean: treeClean(repo) };
          argv = buildCherryPick(commit);
          break;
        }
      }

      // The policy decides. A refusal happens before the spawn.
      const decision = evaluate(operation, ctx, policy);
      if (decision.verdict === 'deny') {
        return denial({
          rule: decision.rule,
          operation,
          reason: decision.reason,
          hint: decision.hint,
        });
      }
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        return hold({ rule: decision.rule, operation, reason: decision.reason, hint: decision.hint });
      }

      if (args.dry_run) {
        return asText({
          dry_run: true,
          applied: false,
          project: res.root,
          operation,
          argv: ['git', ...argv],
          status: 'planned',
          stdout: '',
          stderr: '',
          note: 'Dry run — nothing was run.',
        });
      }

      const result = runGit(argv, repo);
      return asText({
        dry_run: false,
        applied: result.status === 'ok',
        project: res.root,
        operation,
        argv: result.argv,
        status: result.status === 'ok' ? 'ok' : 'error',
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
  );

  // ======================================================== 14. git_combine
  server.registerTool(
    'git_combine',
    {
      title: 'Combine branches',
      description:
        'Checks whether two or more branches can be merged together, without merging them ' +
        'and without touching the working tree. Reports the conflicting paths when they ' +
        'cannot. ' +
        'Not covered by git_operate, which merges one branch into another and changes the ' +
        'repository.',
      inputSchema: {
        project: z.string().optional(),
        branches: z.array(z.string()).min(1).describe('Two or more branches to combine'),
        base: z.string().optional().describe('The branch the others are merged into; the current one when omitted'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      if (!res.repoRoot) {
        return asError('The project is not inside a git repository, so there are no branches to combine.');
      }
      const repo = res.repoRoot;

      // PR-52: combining needs at least two branches.
      const branches = args.branches.map((b) => b.trim()).filter((b) => b !== '');
      const ctx: PolicyContext = {
        project: repo,
        args: { branches },
      };
      const decision = evaluate('git.combine', ctx, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        return hold({ rule: decision.rule, operation: 'git.combine', reason: decision.reason, hint: decision.hint });
      }

      for (const branch of branches) {
        const check = validName(branch);
        if (!check.ok) return asError(`Invalid branch name '${branch}': ${check.reason}`);
      }

      const base = args.base ?? currentBranch(repo) ?? defaultBranch(repo) ?? fallbackDefaultBranch();
      const baseCheck = validName(base);
      if (!baseCheck.ok) return asError(`Invalid base branch: ${baseCheck.reason}`);

      // The branches are combined in the order they were given: the
      // first is merged into the base, the second into the result, and
      // so on. The order matters, so it is reported.
      const others = branches.filter((b) => b !== base);
      if (others.length === 0) {
        return asError(`'${base}' is the base; name at least one other branch to combine with it.`);
      }

      // Each step is checked against the previous result. `merge-tree`
      // writes a dangling tree object and nothing else, so the result
      // of a step can be used as the "branch" of the next -- but only
      // after the tree has been wrapped in a commit, because git
      // refuses to merge a tree where a commit is expected.
      let head = base;
      const steps: Array<{
        branch: string;
        clean: boolean;
        tree: string | null;
        conflicts: string[];
        argv: string[];
        exit_code: number;
      }> = [];

      for (const branch of others) {
        const argv = buildMergeTree(head, branch);
        const result = runGit(argv, repo);
        const parsed = parseMergeTree(result.stdout);
        steps.push({
          branch,
          clean: parsed.clean,
          tree: parsed.tree,
          conflicts: parsed.conflicts,
          argv,
          exit_code: result.exit_code,
        });
        if (!parsed.clean) break;
        if (!parsed.tree) break;

        // Wrap the merged tree in a commit so the next branch can be
        // merged with it. The commit is unreferenced: no branch points
        // at it, and nothing in the working tree changes.
        const commit = runGit(
          buildCommitTree(parsed.tree, [head, branch], `orchestrator: combine ${head} and ${branch}`),
          repo,
        );
        const commitId = commit.stdout.trim();
        if (!/^[0-9a-f]{40}$/.test(commitId)) break;
        head = commitId;
      }

      const conflicted = steps.filter((s) => !s.clean);
      return asText({
        project: res.root,
        repo_root: repo,
        base,
        branches: others,
        combined: conflicted.length === 0,
        conflicts: conflicted.flatMap((s) => s.conflicts),
        steps,
        note:
          conflicted.length === 0
            ? `The ${others.length} branch(es) combine cleanly. Nothing was merged.`
            : `The branches do not combine cleanly. ${conflicted.flatMap((s) => s.conflicts).length} conflicting path(s). Nothing was merged.`,
      });
    },
  );

  // ======================================================= 15. git_worktree
  server.registerTool(
    'git_worktree',
    {
      title: 'Git worktree',
      description:
        'Manages the repository\'s worktrees: adding one for a branch, listing them, ' +
        'removing one, or pruning the ones whose directories are gone. ' +
        'Not covered by git_operate branch, which creates branches without a second ' +
        'working directory.',
      inputSchema: {
        project: z.string().optional(),
        action: z.enum(['add', 'list', 'remove', 'prune']).default('list'),
        path: z.string().optional().describe('Where the worktree lives, for add and remove'),
        branch: z.string().optional().describe('The branch to check out, for add'),
        confirm: z.boolean().default(false),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      if (!res.repoRoot) {
        return asError('The project is not inside a git repository, so it has no worktrees.');
      }
      const repo = res.repoRoot;

      const ctx: PolicyContext = {
        project: repo,
        confirm: args.confirm,
        args: { action: args.action },
      };
      const decision = evaluate('git.worktree', ctx, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        return hold({ rule: decision.rule, operation: 'git.worktree', reason: decision.reason, hint: decision.hint });
      }

      if (args.action === 'list') {
        const result = runGit(buildWorktreeList(), repo);
        if (result.status !== 'ok') {
          return asText({ project: res.root, error: result.stderr || 'git worktree list failed' });
        }
        const worktrees = parseWorktreeList(result.stdout);
        return asText({
          project: res.root,
          repo_root: repo,
          count: worktrees.length,
          worktrees,
          raw: result.stdout,
        });
      }

      if (args.action === 'prune') {
        const argv = buildWorktreePrune();
        if (args.dry_run) {
          return asText({
            dry_run: true,
            applied: false,
            project: res.root,
            argv: ['git', ...argv],
            status: 'planned',
            note: 'Dry run — nothing was pruned.',
          });
        }
        const result = runGit(argv, repo);
        return asText({
          dry_run: false,
          applied: result.status === 'ok',
          project: res.root,
          argv: result.argv,
          status: result.status === 'ok' ? 'pruned' : 'error',
          exit_code: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }

      if (args.action === 'add') {
        if (!args.path) return asError("git_worktree add needs a 'path'.");
        if (!args.branch) return asError("git_worktree add needs a 'branch'.");

        const pathCheck = validName(args.path);
        if (!pathCheck.ok) return asError(`Invalid worktree path: ${pathCheck.reason}`);
        const branchCheck = validName(args.branch);
        if (!branchCheck.ok) return asError(`Invalid branch name: ${branchCheck.reason}`);

        // A worktree inside the repository would be seen by the
        // repository as an untracked directory -- and `git add --all`
        // would stage the worktree's own contents. The check is
        // containment, not path validity: a sibling worktree lives
        // outside the checkout and is perfectly fine.
        const target = resolve(repo, args.path);
        if (insideRepo(repo, target)) {
          return asError(
            `Refusing to create a worktree at '${args.path}': it is inside the repository. ` +
              'A worktree in the checkout would be staged as untracked files by `git add --all`.',
          );
        }

        const argv = buildWorktreeAdd(target, args.branch);
        if (args.dry_run) {
          return asText({
            dry_run: true,
            applied: false,
            project: res.root,
            path: target,
            branch: args.branch,
            argv: ['git', ...argv],
            status: 'planned',
            note: 'Dry run — no worktree was created.',
          });
        }
        const result = runGit(argv, repo);
        return asText({
          dry_run: false,
          applied: result.status === 'ok',
          project: res.root,
          path: target,
          branch: args.branch,
          argv: result.argv,
          status: result.status === 'ok' ? 'created' : 'error',
          exit_code: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }

      // remove
      if (!args.path) return asError("git_worktree remove needs a 'path'.");
      const target = resolve(repo, args.path);
      const argv = buildWorktreeRemove(target);
      if (args.dry_run) {
        return asText({
          dry_run: true,
          applied: false,
          project: res.root,
          path: target,
          argv: ['git', ...argv],
          status: 'planned',
          note: 'Dry run — no worktree was removed.',
        });
      }
      const result = runGit(argv, repo);
      return asText({
        dry_run: false,
        applied: result.status === 'ok',
        project: res.root,
        path: target,
        argv: result.argv,
        status: result.status === 'ok' ? 'removed' : 'error',
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
  );

  // =========================================================== 16. open_pr
  server.registerTool(
    'open_pr',
    {
      title: 'Open pull request',
      description:
        'Opens a pull request for the current branch using the gh CLI. The branch must not ' +
        'be a protected branch, and a pull request must not already exist for it. ' +
        'Not covered by git_operate, which covers the git command surface and does not reach ' +
        'the forge.',
      inputSchema: {
        project: z.string().optional(),
        title: z.string().min(1).max(200),
        body: z.string().default(''),
        base: z.string().optional().describe('The base branch; the repository default when omitted'),
        draft: z.boolean().default(false),
        dry_run: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      if (!res.repoRoot) {
        return asError('The project is not inside a git repository, so there is no branch to open a pull request from.');
      }

      const repo = res.repoRoot;
      const branch = currentBranch(repo);
      const base = args.base ?? defaultBranch(repo) ?? fallbackDefaultBranch();

      const baseCheck = validName(base);
      if (!baseCheck.ok) return asError(`Invalid base branch: ${baseCheck.reason}`);

      // PR-42: the branch must not be protected.
      const protectedNow = isProtectedBranch(branch, protectedBranches(policy));
      const ctx: PolicyContext = {
        project: repo,
        branch,
        base,
        args: { branch_protected: protectedNow },
      };
      const decision = evaluate('gh.pr.create', ctx, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        return hold({ rule: decision.rule, operation: 'gh.pr.create', reason: decision.reason, hint: decision.hint });
      }

      // PR-43: a pull request must not already exist for this branch.
      const listResult = runGh(buildPrList(branch), repo);
      if (listResult.status === 'ok') {
        const existing = parsePrList(listResult.stdout).filter((p) => p.state === 'OPEN');
        if (existing.length > 0) {
          return denial({
            rule: 'PR-43',
            operation: 'gh.pr.create',
            reason: `A pull request already exists for '${branch}' (#${existing[0].number}).`,
            hint: 'Update the existing pull request instead of opening another.',
          });
        }
      }

      const argv = buildPrCreate({
        title: args.title,
        body: args.body,
        base,
        branch,
        draft: args.draft,
      });

      if (args.dry_run) {
        return asText({
          dry_run: true,
          applied: false,
          project: res.root,
          branch,
          base,
          argv: ['gh', ...argv],
          status: 'planned',
          url: null,
          stdout: '',
          stderr: '',
          note: 'Dry run — no pull request was opened.',
        });
      }

      const result = runGh(argv, repo);
      if (result.status !== 'ok') {
        return asText({
          applied: false,
          project: res.root,
          branch,
          base,
          argv: result.argv,
          status: 'error',
          exit_code: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }

      return asText({
        applied: true,
        dry_run: false,
        project: res.root,
        branch,
        base,
        argv: result.argv,
        status: 'created',
        url: parsePrUrl(result.stdout),
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
  );

  // =================================================== 15. plan_from_commits
  server.registerTool(
    'plan_from_commits',
    {
      title: 'Plan from commits',
      description:
        'Reads recent commits on a branch and proposes board tasks derived from them. ' +
        'Proposes by default; writes tasks only when create_tasks is true. ' +
        'Not covered by git_log, which reports commits without turning them into tasks.',
      inputSchema: {
        project: z.string().optional(),
        branch: z.string().optional(),
        base: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        create_tasks: z.boolean().default(false),
        labels: z.array(z.string()).default([]),
        dry_run: z.boolean().default(false).describe('Preview without writing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);
      if (!res.repoRoot) {
        return asError('The project is not inside a git repository, so there are no commits to plan from.');
      }

      const repo = res.repoRoot;
      const branch = args.branch ?? currentBranch(repo);
      const base = args.base ?? defaultBranch(repo) ?? fallbackDefaultBranch();

      const branchCheck = validName(branch);
      if (!branchCheck.ok) return asError(`Invalid branch: ${branchCheck.reason}`);

      const ctx: PolicyContext = { project: repo, branch, base, create_tasks: args.create_tasks };
      // Two operations, because they are two different acts. Proposing
      // tasks reads commits and writes nothing; creating tasks writes to
      // the board, and the policy holds that unless it was asked for.
      const operation = args.create_tasks ? 'plan.create_tasks' : 'plan.from_commits';
      const decision = evaluate(operation, ctx, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        return hold({ rule: decision.rule, operation, reason: decision.reason, hint: decision.hint });
      }

      const logResult = runGit(buildLog({ limit: args.limit }), repo);
      if (logResult.status !== 'ok') {
        return asText({ project: res.root, error: logResult.stderr || 'git log failed' });
      }
      const commits = parseLog(logResult.stdout);

      // Only the commits the branch has and the base does not.
      const rangeResult = runGit(buildPlanningRangeLog(args.limit, base, branch), repo);
      const ahead = rangeResult.status === 'ok'
        ? rangeResult.stdout
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map((l) => {
              const [hash, subject] = l.split('\x1f');
              return { hash: hash ?? '', subject: subject ?? '' };
            })
        : commits.map((c) => ({ hash: c.hash, subject: c.subject }));

      const proposed = ahead.map((c) => ({
        title: c.subject,
        body: `From commit ${c.hash.slice(0, 7)}: ${c.subject}`,
        labels: args.labels,
        source_commit: c.hash.slice(0, 7),
      }));

      if (!args.create_tasks) {
        return asText({
          project: res.root,
          branch,
          base,
          commits_read: ahead.length,
          proposed,
          created: [],
          board_path: res.boardPath,
          note: `${proposed.length} proposal(s). Nothing was written; pass create_tasks=true to create them.`,
        });
      }

      const loaded = loadBoardFor(res.boardPath, res.root);
      if ('error' in loaded) return loaded.error;
      if (!res.boardPath) return asError('No board path could be resolved.');

      const now = clock();
      const created: Task[] = [];
      let board = loaded.board;
      for (const proposal of proposed) {
        const id = nextTaskId(board);
        const task = newTask({
          id,
          title: proposal.title,
          body: proposal.body,
          labels: proposal.labels,
          branch,
          now,
        });
        task.history = [{ at: now, from: null, to: task.state, actor: 'orchestrator', note: `from commit ${proposal.source_commit}` }];
        created.push(task);
        board = { ...board, tasks: [...board.tasks, task] };
      }
      board.updated_at = now;

      if (args.dry_run) {
        return asText({
          applied: false,
          dry_run: true,
          project: res.root,
          branch,
          base,
          commits_read: ahead.length,
          proposed,
          created: [],
          board_path: res.boardPath,
          note: `Dry run — ${proposed.length} task(s) planned; nothing was written.`,
        });
      }

      const result = writeBoard(res.boardPath, board, loaded.exists ? loaded.hash : null);
      if (!result.ok) {
        return asText({ applied: false, project: res.root, error: result.error });
      }
      return asText({
        applied: true,
        project: res.root,
        branch,
        base,
        commits_read: ahead.length,
        proposed,
        created: created.map((t) => ({ id: t.id, title: t.title })),
        board_path: res.boardPath,
        note: `${created.length} task(s) created.`,
      });
    },
  );

  // ========================================================= 16. policy_get
  server.registerTool(
    'policy_get',
    {
      title: 'Get policy',
      description:
        'Returns the effective policy: every rule id with its verdict, the reason, and ' +
        'whether the repository\'s policy file overrides it. ' +
        'Not covered by policy_set, which changes a rule.',
      inputSchema: {
        project: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project }) => {
      const { res, policy, policyError } = context(project);
      // PR-40 governs reading the policy. The rule is honoured, but
      // the effective policy is reported alongside the refusal -- a
      // caller that cannot read the policy cannot reason about why it
      // was refused, and that is the one moment the report matters
      // most.
      const refused = permit('policy.get', { project: res.root }, policy);
      if (refused) {
        const payload = refused.content?.[0]?.text;
        const refusal = typeof payload === 'string' ? (JSON.parse(payload) as Record<string, unknown>) : {};
        return asText({
          ...refusal,
          policy_path: res.policyPath,
          source: policy.source,
          error: policyError,
          overrides: policy.overrides,
          rules: RULES.map((rule) => ({
            id: rule.id,
            operation: rule.operation,
            verdict: policy.rules.get(rule.id)?.verdict ?? rule.verdict,
            reason: policy.rules.get(rule.id)?.reason ?? rule.reason,
            evidence: rule.evidence,
            hint: rule.hint,
            overridden: policy.overrides.includes(rule.id),
          })),
        });
      }
      return asText({
        policy_path: res.policyPath,
        source: policy.source,
        error: policyError,
        overrides: policy.overrides,
        rules: RULES.map((rule) => ({
          id: rule.id,
          operation: rule.operation,
          verdict: policy.rules.get(rule.id)?.verdict ?? rule.verdict,
          reason: policy.rules.get(rule.id)?.reason ?? rule.reason,
          evidence: rule.evidence,
          hint: rule.hint,
          overridden: policy.overrides.includes(rule.id),
        })),
      });
    },
  );

  // ========================================================= 17. policy_set
  server.registerTool(
    'policy_set',
    {
      title: 'Set policy',
      description:
        "Writes the repository's policy file. A rule may only be tightened -- a built-in " +
        'deny or conditional cannot be relaxed to allow. ' +
        'Not covered by policy_get, which reads the policy.',
      inputSchema: {
        project: z.string().optional(),
        policy: z.object({
          schema_version: z.number(),
          default_branch: z.string(),
          protected_branches: z.array(z.string()),
          allowed_merge_strategies: z.array(z.string()),
          commit_message_pattern: z.string(),
          deny: z.array(z.string()),
        }),
        confirm: z.boolean().default(false),
        dry_run: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { res, policy } = context(args.project);

      // A policy may only tighten. Check every id before writing any of it.
      const deniedRules: string[] = [];
      for (const id of args.policy.deny) {
        const check = maySetVerdict(id, 'deny');
        if (!check.ok) deniedRules.push(`${id}: ${check.reason}`);
      }

      const decision = evaluate('policy.set', { confirm: args.confirm }, policy);
      if (decision.verdict === 'deny') return denial(decision);
      if (decision.verdict === 'conditional' && !decision.satisfied) {
        return hold({ rule: decision.rule, operation: 'policy.set', reason: decision.reason, hint: decision.hint });
      }

      if (deniedRules.length > 0) {
        return asText({
          applied: false,
          refused: true,
          rule: 'PR-41',
          operation: 'policy.set',
          reason: 'A repository may tighten the policy, never loosen it.',
          denied_rules: deniedRules,
        });
      }

      if (args.dry_run) {
        return asText({
          dry_run: true,
          applied: false,
          policy_path: res.policyPath,
          written: false,
          denied_rules: [],
          note: 'Dry run — nothing was written.',
        });
      }

      try {
        mkdirSync(dirname(res.policyPath), { recursive: true });
        writeFileSync(res.policyPath, JSON.stringify(args.policy, null, 2) + '\n', 'utf-8');
      } catch (e) {
        return asText({
          applied: false,
          policy_path: res.policyPath,
          written: false,
          error: `cannot write ${res.policyPath}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }

      return asText({
        applied: true,
        dry_run: false,
        policy_path: res.policyPath,
        written: true,
        denied_rules: [],
        note: 'Policy written.',
      });
    },
  );

  return server;
}

export { readFileSync, existsSync, resolve };
