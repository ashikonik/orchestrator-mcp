/**
 * Reading, validating and writing the board.
 *
 * The board is the project's shared state, so the write path is the
 * careful part of this file. Three properties matter:
 *
 *  1. **Atomic.** A write goes to a `.tmp` file and is renamed over the
 *     real path. A crash mid-write leaves the old board intact; a reader
 *     never sees half a board.
 *  2. **Validated.** A board that breaks an invariant is never written.
 *     The error names the invariant id, so the caller can say which rule
 *     it broke.
 *  3. **Conflict-aware.** The file's hash is re-read immediately before the
 *     write. If it changed since the board was loaded, the write is refused
 *     -- the server never silently overwrites another agent's work.
 *
 * The conflict check alone is not enough. Re-reading the hash and then
 * renaming is two steps, and two writers can both pass the check before
 * either renames. So the write also takes an exclusive lock, and each
 * writer uses its own temporary file: two agents writing the board at
 * the same moment is the normal case, not the edge case.
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { BOARD_SCHEMA_VERSION, parseBoard } from './board-schema.js';
import type { Board, HistoryEntry, Task, TaskState } from './types.js';

/** One broken invariant. */
export interface Violation {
  invariant: string;
  detail: string;
}

/** The outcome of a read. */
export type ReadResult =
  | { ok: true; board: Board; path: string; hash: string; exists: boolean }
  | { ok: false; error: string; path: string };

/** The outcome of a write. */
export type WriteResult =
  | { ok: true; path: string; hash: string; written: number }
  | { ok: false; error: string; path: string; violations?: Violation[] };

/** The hash of a board's bytes, used for the conflict check. */
export function hashBoard(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Read a board from disk.
 *
 * A missing file is not an error: it means the project has no board yet,
 * and the caller gets an empty board with `exists: false`. A file that is
 * *present but corrupt* is an error -- that is data loss, and silently
 * replacing it with an empty board would destroy the user's work.
 */
export function readBoard(path: string, project: string, now: string): ReadResult {
  if (!existsSync(path)) {
    return {
      ok: true,
      board: {
        schema_version: BOARD_SCHEMA_VERSION,
        project,
        updated_at: now,
        tasks: [],
      },
      path,
      hash: '',
      exists: false,
    };
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    return {
      ok: false,
      error: `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
      path,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: `cannot parse ${path} as JSON: ${e instanceof Error ? e.message : String(e)}. The file is left untouched; fix or move it by hand.`,
      path,
    };
  }

  const parsed = parseBoard(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, path };
  }

  const violations = validateBoard(parsed.board);
  if (violations.length > 0) {
    return {
      ok: false,
      error: `${path} breaks ${violations.length} board invariant(s): ${violations.map((v) => `${v.invariant} (${v.detail})`).join('; ')}`,
      path,
    };
  }

  return { ok: true, board: parsed.board, path, hash: hashBoard(text), exists: true };
}

/**
 * Check a board against the seven invariants.
 *
 * The invariant ids are stable: they appear in error messages and in the
 * tests, so they are part of the interface rather than an implementation
 * detail.
 */
export function validateBoard(board: Board): Violation[] {
  const violations: Violation[] = [];

  if (board.schema_version !== BOARD_SCHEMA_VERSION) {
    violations.push({
      invariant: 'INV-1',
      detail: `schema_version is ${board.schema_version}, expected ${BOARD_SCHEMA_VERSION}`,
    });
  }

  const seen = new Set<string>();
  const idPattern = /^T-\d{3,}$/;
  for (const task of board.tasks) {
    if (!idPattern.test(task.id)) {
      violations.push({
        invariant: 'INV-2',
        detail: `task id '${task.id}' does not match ${idPattern.source}`,
      });
    }
    if (seen.has(task.id)) {
      violations.push({ invariant: 'INV-3', detail: `task id '${task.id}' appears more than once` });
    }
    seen.add(task.id);
  }

  for (const task of board.tasks) {
    for (const dep of task.blocked_by) {
      if (!seen.has(dep)) {
        violations.push({
          invariant: 'INV-4',
          detail: `task '${task.id}' is blocked_by '${dep}', which is not a task on this board`,
        });
      }
      if (dep === task.id) {
        violations.push({ invariant: 'INV-5', detail: `task '${task.id}' blocks itself` });
      }
    }
  }

  for (const cycle of findCycles(board)) {
    violations.push({ invariant: 'INV-6', detail: `dependency cycle: ${cycle.join(' -> ')}` });
  }

  const states = new Set([
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
  ]);
  for (const task of board.tasks) {
    if (!states.has(task.state)) {
      violations.push({
        invariant: 'INV-7',
        detail: `task '${task.id}' has unknown state '${task.state}'`,
      });
    }
  }

  // --- the hierarchy ------------------------------------------------------
  //
  // `parent` is a one-parent tree: a task may name one parent, the
  // parent must exist, a task may not be its own parent, and the
  // parent chain must not come back around.

  for (const task of board.tasks) {
    const parent = task.parent;
    if (parent === undefined || parent === null) continue;

    if (!seen.has(parent)) {
      violations.push({
        invariant: 'INV-8',
        detail: `task '${task.id}' has parent '${parent}', which is not a task on this board`,
      });
      continue;
    }
    if (parent === task.id) {
      violations.push({
        invariant: 'INV-9',
        detail: `task '${task.id}' is its own parent`,
      });
    }
  }

  for (const cycle of findParentCycles(board)) {
    violations.push({
      invariant: 'INV-10',
      detail: `parent cycle: ${cycle.join(' -> ')}`,
    });
  }

  // --- the locks ----------------------------------------------------------
  //
  // Two tasks holding overlapping locks are working on the same file.
  // The overlap check is on the *path*, so `src/a.ts` and
  // `src/a.ts.bak` are different files, while `src` and `src/a.ts` are
  // not -- a directory lock covers everything under it.

  for (let i = 0; i < board.tasks.length; i++) {
    for (let j = i + 1; j < board.tasks.length; j++) {
      const a = board.tasks[i];
      const b = board.tasks[j];
      const overlap = firstOverlap(a.locks ?? [], b.locks ?? []);
      if (overlap !== null) {
        violations.push({
          invariant: 'INV-11',
          detail: `tasks '${a.id}' and '${b.id}' both hold a lock on '${overlap}'`,
        });
      }
    }
  }

  return violations;
}

/**
 * Do two sets of locked paths overlap?
 *
 * A path covers itself and everything under it. `src` and
 * `src/a.ts` overlap; `src/a.ts` and `src/a.ts.bak` do not.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (p: string): string => p.replace(/\/+$/, '');
  const x = norm(a);
  const y = norm(b);
  if (x === '') return true;
  if (y === '') return true;
  return x.startsWith(y + '/') || y.startsWith(x + '/');
}

/** The first path that the two lock sets share, or null. */
export function firstOverlap(a: string[], b: string[]): string | null {
  for (const left of a) {
    for (const right of b) {
      if (pathsOverlap(left, right)) return left;
    }
  }
  return null;
}

/**
 * Find every parent cycle in the board.
 *
 * The same shape as `findCycles`, but over the `parent` edges rather
 * than the `blocked_by` edges. A task may have one parent, so the
 * graph is a forest if it is sound -- a cycle would make the tree
 * infinite.
 */
export function findParentCycles(board: Board): string[][] {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    const task = byId.get(id);
    const parent = task?.parent;
    if (parent && byId.has(parent)) visit(parent);
    stack.pop();
    state.set(id, 'done');
  };

  for (const task of board.tasks) visit(task.id);
  return cycles;
}

/**
 * Find every dependency cycle in the board.
 *
 * A DFS over the `blocked_by` edges, colouring nodes as they are visited.
 * A node reached again while it is still on the stack is on a cycle, and
 * the stack from that node onward is the cycle itself.
 */
export function findCycles(board: Board): string[][] {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    const task = byId.get(id);
    if (task) {
      for (const dep of task.blocked_by) {
        if (byId.has(dep)) visit(dep);
      }
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const task of board.tasks) visit(task.id);
  return cycles;
}

/**
 * Take the board's write lock.
 *
 * The lock is a file created with `O_EXCL`, which is atomic: exactly one
 * writer creates it, and every other writer is told it exists. That is
 * what closes the window between the conflict check and the rename --
 * without it, two writers can both pass the check and then both rename,
 * and the second one silently discards the first one's work.
 *
 * The lock is held for the length of one write, which is short. If a
 * writer dies holding it, the lock is stale -- so a lock older than
 * `LOCK_STALE_MS` is broken and taken over.
 */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 10;

function lockPath(path: string): string {
  return `${path}.lock`;
}

function sleep(ms: number): void {
  // A busy wait would burn a core; the server is a long-lived process
  // and may have many boards to write.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquireLock(path: string): boolean {
  try {
    const fd = openSync(lockPath(path), 'wx');
    try {
      writeSync(fd, `${process.pid} ${Date.now()}`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  }
}

/** Is the existing lock old enough to be considered abandoned? */
function lockIsStale(path: string): boolean {
  try {
    const stat = statSync(lockPath(path));
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch {
    // The lock vanished between the failed create and this check, so
    // whoever held it is done. Treat it as free.
    return true;
  }
}

/**
 * Acquire the board's write lock, waiting briefly for a contended one.
 *
 * Returns a release function, or null if the lock could not be taken.
 */
function acquireLock(path: string): (() => void) | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (tryAcquireLock(path)) {
      return () => {
        try {
          rmSync(lockPath(path), { force: true });
        } catch {
          /* the lock is best-effort to release */
        }
      };
    }
    if (lockIsStale(path)) {
      // The holder died. Take the lock over.
      try {
        rmSync(lockPath(path), { force: true });
      } catch {
        /* another writer got it first; the loop will try again */
      }
      continue;
    }
    if (Date.now() >= deadline) return null;
    sleep(LOCK_POLL_MS);
  }
}

/**
 * Write a board to disk, atomically.
 *
 * `expectedHash` is the hash the board was read at. Pass it and the write
 * is refused if the file changed underneath; pass `null` to write
 * unconditionally (used when the caller is replacing the board wholesale
 * and has just read it).
 */
export function writeBoard(
  path: string,
  board: Board,
  expectedHash: string | null,
): WriteResult {
  const violations = validateBoard(board);
  if (violations.length > 0) {
    return {
      ok: false,
      error: `refusing to write: the board breaks ${violations.length} invariant(s): ${violations.map((v) => `${v.invariant} (${v.detail})`).join('; ')}`,
      path,
      violations,
    };
  }

  // The directory has to exist before the lock file can be created in
  // it, and the lock has to exist before the board can be written.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // The write below reports the failure with a better message.
  }

  const release = acquireLock(path);
  if (!release) {
    return {
      ok: false,
      error:
        `refusing to write: another writer holds the lock on ${path}. ` +
        'Wait for it to finish and try again.',
      path,
    };
  }

  try {
    // The conflict check. Re-read the file immediately before writing and
    // compare it with what the caller loaded. If it moved, another agent
    // wrote in between, and a blind write would silently discard their
    // work. The lock makes this check-and-write a single step: no other
    // writer can be between its own check and its own rename.
    if (expectedHash !== null && existsSync(path)) {
      let current: string;
      try {
        current = readFileSync(path, 'utf-8');
      } catch (e) {
        return {
          ok: false,
          error: `cannot read ${path} before writing: ${e instanceof Error ? e.message : String(e)}`,
          path,
        };
      }
      const currentHash = hashBoard(current);
      if (currentHash !== expectedHash) {
        return {
          ok: false,
          error:
            `refusing to write: ${path} changed on disk since it was read ` +
            `(expected ${expectedHash.slice(0, 12)}, found ${currentHash.slice(0, 12)}). ` +
            'Another writer got there first -- re-read the board and apply the change again.',
          path,
        };
      }
    }

    const text = JSON.stringify(board, null, 2) + '\n';
    // A unique temp name: two writers must never share one, or they
    // will interleave their writes into the same file.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, text, 'utf-8');
      renameSync(tmp, path);
    } catch (e) {
      // The temp file is ours and it is incomplete -- remove it rather than
      // leave it to be mistaken for a board.
      try {
        if (existsSync(tmp)) rmSync(tmp, { force: true });
      } catch {
        /* the write failed; the cleanup is best-effort */
      }
      return {
        ok: false,
        error: `cannot write ${path}: ${e instanceof Error ? e.message : String(e)}`,
        path,
      };
    }

    return { ok: true, path, hash: hashBoard(text), written: board.tasks.length };
  } finally {
    release();
  }
}

/**
 * The lowest id a keyed task may take.
 *
 * A keyed id is a hash, so it is a large number. The floor keeps the
 * two ranges apart: a sequential id is below it, a keyed id is at or
 * above it.
 */
export const KEYED_ID_FLOOR = 1_000_000_000;

/**
 * The task id an idempotency key names.
 *
 * The key is hashed, so the id is the same on every machine and every
 * run -- which is what makes a retry land on the same task rather than
 * a second copy of it.
 *
 * The number is large on purpose. The ordinary allocator hands out
 * `T-001`, `T-002` and so on, and those are small; a keyed task takes
 * a high number so it never collides with one that was allocated in
 * sequence, and so the two kinds are easy to tell apart on the board.
 */
export function taskIdForKey(key: string): string {
  const digest = createHash('sha256').update(key, 'utf-8').digest('hex');
  // 48 bits of the hash, as a number. A collision between two
  // different keys is astronomically unlikely, and the board's
  // duplicate-id check would catch it anyway.
  const n = Number.parseInt(digest.slice(0, 12), 16);
  return `T-${String((n % 1_000_000_000) + KEYED_ID_FLOOR).padStart(10, '0')}`;
}

/**
 * Allocate the next task id.
 *
 * Ids are never reused. A deleted task leaves no trace in `tasks`, so the
 * board also records the ids it has retired in `retired_ids`; the
 * allocator skips past both. A reused id would make the history of the
 * old task and the new one ambiguous, and would make a stale reference
 * to the deleted task resolve to the wrong one.
 */
export function nextTaskId(board: Board): string {
  let highest = 0;
  const consider = (id: string): void => {
    const m = /^T-(\d+)$/.exec(id);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      // A keyed task's id is a large hash-derived number. It must not
      // push the sequential allocator up to it, or one keyed task
      // would leave a gap of a billion ids in the numbering.
      if (n < KEYED_ID_FLOOR && n > highest) highest = n;
    }
  };
  for (const task of board.tasks) consider(task.id);
  for (const id of board.retired_ids ?? []) consider(id);
  return `T-${String(highest + 1).padStart(3, '0')}`;
}

/**
 * Retire a task's id.
 *
 * Called when a task is deleted, so the id is not handed out again.
 */
export function retireId(board: Board, id: string): Board {
  const retired = board.retired_ids ?? [];
  if (retired.includes(id)) return board;
  return { ...board, retired_ids: [...retired, id].sort() };
}

/**
 * Append a history entry.
 *
 * History is append-only. An existing entry is never modified or
 * removed, so the board records what happened rather than what is true.
 */
export function appendHistory(task: Task, entry: HistoryEntry): Task {
  return { ...task, history: [...task.history, entry] };
}

/** Find a task by id. */
export function findTask(board: Board, id: string): Task | undefined {
  return board.tasks.find((t) => t.id === id);
}

/** Replace a task in the board, matching by id. */
export function replaceTask(board: Board, task: Task): Board {
  return {
    ...board,
    tasks: board.tasks.map((t) => (t.id === task.id ? task : t)),
    updated_at: task.updated_at,
  };
}

/** The states a task is blocked by, given the board. */
export function blockersOf(board: Board, task: Task): Task[] {
  return task.blocked_by
    .map((id) => findTask(board, id))
    .filter((t): t is Task => t !== undefined && t.state !== 'done');
}

/**
 * Is the task's claim still live?
 *
 * A claim holds until its lease expires. Once the lease has lapsed the
 * task is free again, so an agent that died mid-task does not block
 * the work forever.
 *
 * The clock is passed in rather than read, so the answer is the same
 * everywhere it is asked within one call.
 */
export function claimIsLive(task: Task, now: string): boolean {
  const claim = task.claim;
  if (!claim) return false;
  const expiry = Date.parse(claim.lease_expires_at);
  const current = Date.parse(now);
  if (Number.isNaN(expiry) || Number.isNaN(current)) {
    // An unparseable timestamp is treated as live: the safe answer is
    // the one that does not let somebody else's work be taken.
    return true;
  }
  return expiry > current;
}

/** A short human summary of a task, for list-shaped responses. */
export function summarize(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    labels: task.labels,
    assignee: task.assignee,
    blocked_by: task.blocked_by,
    branch: task.branch,
    parent: task.parent ?? null,
    priority: task.priority ?? null,
    claim: task.claim ?? null,
    locks: task.locks ?? [],
    updated_at: task.updated_at,
  };
}

/** Every state, in board order -- used by the `task_list` filter. */
export function isTaskState(value: string): value is TaskState {
  return (
    value === 'backlog' ||
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'in_review' ||
    value === 'blocked' ||
    value === 'done' ||
    value === 'cancelled'
  );
}
