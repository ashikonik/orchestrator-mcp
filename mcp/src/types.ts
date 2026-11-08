/**
 * The shared shapes — the board, the policy verdict, and the tool result.
 *
 * These types are the contract between the modules. `board-schema.ts`
 * describes the on-disk board in Zod, `states.ts` and `policy.ts` both
 * speak in these terms, and `server.ts` returns them to the client. Keeping
 * them in one place means a change to a shape has one home.
 */

/**
 * The seven states a task can be in.
 *
 * The set is fixed rather than open, because the state machine in
 * `states.ts` has an explicit row for every (from, to) pair. A new state
 * would mean new rows, so adding one is a deliberate act.
 */
export type TaskState =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export const TASK_STATES: readonly TaskState[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];

/** One entry in a task's history. History is append-only. */
export interface HistoryEntry {
  at: string;
  from: TaskState | null;
  to: TaskState;
  actor: string;
  note: string;
}

/**
 * A note appended to a task.
 *
 * Notes are append-only and carry their own actor, so a task's notes
 * record who said what and when. They are separate from `history`,
 * which records *state changes* -- a note is not a transition.
 */
export interface Note {
  at: string;
  actor: string;
  text: string;
  /**
   * The key that made this note idempotent, when it had one.
   *
   * A key makes a write safe to retry: the same key on the same task
   * appends the note once, not twice. It is stored so that the retry
   * can be recognised later.
   */
  idempotency_key?: string;
}

/**
 * A claim on a task.
 *
 * The claim says which agent is working on the task, and until when.
 * The agent is a **label**, not an identity: it is whatever the caller
 * said it was. The server has no way to verify it, and does not try --
 * what the lease buys is a way for two agents to notice each other,
 * not a way to prove who is who.
 */
export interface Claim {
  agent: string;
  at: string;
  /** When the claim lapses, as an ISO timestamp. */
  lease_expires_at: string;
  /**
   * The key that made this claim idempotent, when it had one.
   *
   * A retry with the same key returns the claim that is already there
   * rather than a fresh lease.
   */
  idempotency_key?: string;
}

/** One task on the board. */
export interface Task {
  id: string;
  title: string;
  body: string;
  state: TaskState;
  labels: string[];
  assignee: string | null;
  blocked_by: string[];
  branch: string | null;
  created_at: string;
  updated_at: string;
  history: HistoryEntry[];
  /**
   * The task this one is a piece of.
   *
   * A task may have one parent. The hierarchy is a tree, not a graph:
   * INV-10 refuses a cycle, so `T-001 -> T-002 -> T-001` cannot exist.
   */
  parent?: string | null;
  /**
   * The task's rank among its siblings.
   *
   * A higher number means more urgent. It is a plain integer rather
   * than an enum so that a project can say what it means; the server
   * only uses it to order work.
   */
  priority?: number;
  /** Notes appended to the task. */
  notes?: Note[];
  /** The agent's claim on the task, if it is claimed. */
  claim?: Claim | null;
  /**
   * The paths this task holds locks on.
   *
   * A lock is a path the task is working on. Two tasks holding
   * overlapping locks are working on the same file, and the second
   * claim is refused. The locks are paths relative to the repository
   * root.
   */
  locks?: string[];
}

/** The board — the whole file, one JSON object. */
export interface Board {
  schema_version: number;
  project: string;
  updated_at: string;
  tasks: Task[];
  /**
   * Task ids that were used and have since been freed.
   *
   * A deleted task leaves no trace in `tasks`, so without this the id
   * allocator would hand the same id to the next task -- and a stale
   * reference to the deleted task would then resolve to the wrong one.
   * Ids are never reused, even after a delete.
   */
  retired_ids?: string[];
}

/**
 * The policy's three verdicts.
 *
 * `conditional` is the interesting one: it is the difference between "no"
 * and "not yet". A conditional rule holds with the condition named, so the
 * caller knows exactly what to supply and call again.
 */
export type PolicyVerdict = 'allow' | 'deny' | 'conditional';

/** What `evaluate()` returns for one operation. */
export interface PolicyDecision {
  rule: string;
  operation: string;
  verdict: PolicyVerdict;
  reason: string;
  /** Set on `conditional` when the evidence is present. */
  satisfied?: boolean;
  /** What the caller should do to satisfy a held rule. */
  hint?: string;
}

/** The context one policy evaluation reads. */
export interface PolicyContext {
  project?: string;
  branch?: string;
  base?: string;
  args?: Record<string, unknown>;
  message?: string;
  reason?: string;
  note?: string;
  confirm?: boolean;
  discard?: boolean;
  force?: boolean;
  include_untracked?: boolean;
  create_tasks?: boolean;
  strategy?: string;
  mode?: string;
  source?: string;
}

/** The result of running one git or gh command. */
export interface GitResult {
  argv: string[];
  status: 'ok' | 'error' | 'planned';
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Set when the command timed out or was killed. */
  timed_out?: boolean;
}

/** The shape every tool handler returns. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
