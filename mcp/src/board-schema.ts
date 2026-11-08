/**
 * The board's on-disk shape, as a Zod schema.
 *
 * This is the single source of truth for the field names and types of
 * `board.json`. The types in `types.ts` describe the board in TypeScript;
 * this file describes it on disk, and the two are checked against each
 * other by the round-trip test.
 *
 * The schema validates *shape*. The things a schema cannot express --
 * unique ids, dangling dependencies, cycles -- are the board invariants,
 * and they live in `board.ts` as `validateBoard()`.
 */
import { z } from 'zod';
import { TASK_STATES } from './types.js';
import type { Board, Task } from './types.js';

export const BOARD_SCHEMA_VERSION = 1;

/** The task states, as a Zod enum. */
const taskStateSchema = z.enum(TASK_STATES as [string, ...string[]]);

export const historyEntrySchema = z.strictObject({
  at: z.string().min(1),
  from: taskStateSchema.nullable(),
  to: taskStateSchema,
  actor: z.string().min(1),
  note: z.string(),
});

/**
 * One note on a task.
 *
 * `notes` and `history` are separate: history records state changes,
 * a note records something someone said.
 */
export const noteSchema = z.strictObject({
  at: z.string().min(1),
  actor: z.string().min(1),
  text: z.string(),
  idempotency_key: z.string().optional(),
});

/**
 * A claim on a task.
 *
 * The agent is a self-asserted label. The server records it; it does
 * not verify it.
 */
export const claimSchema = z.strictObject({
  agent: z.string().min(1),
  at: z.string().min(1),
  lease_expires_at: z.string().min(1),
  idempotency_key: z.string().optional(),
});

/**
 * One task, as it is written on disk.
 *
 * The object is **strict**: an unknown key is an error, not something
 * to drop. A non-strict schema would silently strip a field the caller
 * wrote -- so a board written with `priority` would read back without
 * it, and the caller would never learn that their field had gone. A
 * strict schema turns that into a refusal at the point of the write.
 *
 * The optional fields are optional because a board written before they
 * existed still has to parse.
 */
export const taskSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  state: taskStateSchema,
  labels: z.array(z.string()),
  assignee: z.string().nullable(),
  blocked_by: z.array(z.string()),
  branch: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  history: z.array(historyEntrySchema),
  parent: z.string().nullable().optional(),
  priority: z.number().int().optional(),
  notes: z.array(noteSchema).optional(),
  claim: claimSchema.nullable().optional(),
  locks: z.array(z.string()).optional(),
});

export const boardSchema = z.strictObject({
  schema_version: z.number(),
  project: z.string().min(1),
  updated_at: z.string().min(1),
  tasks: z.array(taskSchema),
  // Optional: a board written before this field existed still parses.
  retired_ids: z.array(z.string()).optional(),
});

/** The policy file's shape. */
export const policySchema = z.object({
  schema_version: z.number(),
  default_branch: z.string().min(1),
  protected_branches: z.array(z.string().min(1)),
  allowed_merge_strategies: z.array(z.string().min(1)),
  commit_message_pattern: z.string(),
  deny: z.array(z.string().min(1)),
});

export type PolicyFile = z.infer<typeof policySchema>;

/**
 * The result of parsing a board.
 *
 * A failure names the invariant it broke where one applies, so the caller
 * can report "INV-3: duplicate task id" rather than a Zod path.
 */
export type ParseResult =
  | { ok: true; board: Board }
  | { ok: false; error: string; invariant?: string };

/**
 * Parse an unknown value into a board.
 *
 * A shape failure is reported as `ok: false` with the Zod message. The
 * semantic checks live in `validateBoard`, which `parseBoard` does not run
 * -- they need the whole board, and `validateBoard` is called separately so
 * the error can name the invariant id.
 */
export function parseBoard(raw: unknown): ParseResult {
  const result = boardSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: `board.json is malformed: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    };
  }
  return { ok: true, board: result.data as Board };
}

/** Parse an unknown value into a policy file. */
export function parsePolicy(raw: unknown): { ok: true; policy: PolicyFile } | { ok: false; error: string } {
  const result = policySchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: `policy.json is malformed: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    };
  }
  return { ok: true, policy: result.data as PolicyFile };
}

/**
 * An empty board.
 *
 * A new project gets one of these rather than no board at all: the board
 * file's absence is a normal state, and the board surface should work
 * before the first task exists.
 */
export function emptyBoard(project: string, now: string): Board {
  return {
    schema_version: BOARD_SCHEMA_VERSION,
    project,
    updated_at: now,
    tasks: [],
  };
}

/** A new task, with the fields the caller did not supply filled in. */
export function newTask(fields: {
  id: string;
  title: string;
  body?: string;
  state?: Task['state'];
  labels?: string[];
  assignee?: string | null;
  blocked_by?: string[];
  branch?: string | null;
  parent?: string | null;
  priority?: number;
  locks?: string[];
  now: string;
}): Task {
  const task: Task = {
    id: fields.id,
    title: fields.title,
    body: fields.body ?? '',
    state: fields.state ?? 'todo',
    labels: fields.labels ?? [],
    assignee: fields.assignee ?? null,
    blocked_by: fields.blocked_by ?? [],
    branch: fields.branch ?? null,
    created_at: fields.now,
    updated_at: fields.now,
    history: [],
  };
  if (fields.parent !== undefined) task.parent = fields.parent;
  if (fields.priority !== undefined) task.priority = fields.priority;
  if (fields.locks !== undefined) task.locks = fields.locks;
  return task;
}
