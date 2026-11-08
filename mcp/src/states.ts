/**
 * The task state machine.
 *
 * Every transition a task can make is a row in one table. A transition is
 * one of three kinds:
 *
 *  - **allowed** -- the agent may make it freely.
 *  - **gated** -- it may be made once a stated condition is supplied. The
 *    task does not move until then, and the response says what is missing.
 *  - **refused** -- it may not be made at all.
 *
 * The rule ids (`ST-1` ... `ST-27`) are stable and appear in responses and
 * in the tests. They are part of the interface: an agent can report
 * "ST-9 refuses todo -> done" and a human can look up what that means.
 */
import { blockersOf } from './board.js';
import type { Board, Task, TaskState } from './types.js';

export type TransitionKind = 'allowed' | 'gated' | 'refused';

export interface Transition {
  from: TaskState;
  to: TaskState;
  kind: TransitionKind;
  rule: string;
  reason: string;
  /** For a gated transition: the policy gate that holds it. */
  gate?: string;
  /** For a gated transition: what the caller must supply. */
  condition?: string;
}

/**
 * The transition table.
 *
 * Written out in full rather than derived from rules, because the shape of
 * the allowed set is itself the specification. A derived rule ("anything
 * except from a terminal state") would be shorter and would hide exactly
 * the thing a reader wants to check.
 */
export const TRANSITIONS: readonly Transition[] = [
  // --- from backlog ------------------------------------------------------
  { from: 'backlog', to: 'todo', kind: 'allowed', rule: 'ST-1', reason: "backlog -> todo is a refinement: the task has been pulled into the queue." },
  { from: 'backlog', to: 'cancelled', kind: 'gated', rule: 'ST-2', reason: 'Cancelling a task requires a reason.', gate: 'PR-2', condition: 'a non-empty reason' },
  { from: 'backlog', to: 'in_progress', kind: 'refused', rule: 'ST-3', reason: "backlog -> in_progress is refused: a task must pass through 'todo' first." },
  { from: 'backlog', to: 'done', kind: 'refused', rule: 'ST-4', reason: "backlog -> done is refused: a task must pass through 'todo' and 'in_progress' first." },

  // --- from todo ---------------------------------------------------------
  { from: 'todo', to: 'in_progress', kind: 'allowed', rule: 'ST-5', reason: "todo -> in_progress is the normal starting move." },
  { from: 'todo', to: 'blocked', kind: 'allowed', rule: 'ST-6', reason: 'todo -> blocked records that the task cannot proceed.' },
  { from: 'todo', to: 'backlog', kind: 'allowed', rule: 'ST-7', reason: 'todo -> backlog de-prioritises the task.' },
  { from: 'todo', to: 'cancelled', kind: 'gated', rule: 'ST-8', reason: 'Cancelling a task requires a reason.', gate: 'PR-2', condition: 'a non-empty reason' },
  { from: 'todo', to: 'done', kind: 'refused', rule: 'ST-9', reason: "todo -> done is refused: a task must pass through 'in_progress' first." },

  // --- from in_progress --------------------------------------------------
  { from: 'in_progress', to: 'in_review', kind: 'allowed', rule: 'ST-10', reason: 'in_progress -> in_review hands the work over for review.' },
  { from: 'in_progress', to: 'blocked', kind: 'allowed', rule: 'ST-11', reason: 'in_progress -> blocked records that the work is stuck.' },
  { from: 'in_progress', to: 'todo', kind: 'allowed', rule: 'ST-12', reason: 'in_progress -> todo hands the task back to the queue.' },
  { from: 'in_progress', to: 'done', kind: 'gated', rule: 'ST-13', reason: 'Completing a task requires a commit on its branch.', gate: 'PR-3', condition: 'a commit on the task branch' },
  { from: 'in_progress', to: 'cancelled', kind: 'gated', rule: 'ST-14', reason: 'Cancelling a task requires a reason.', gate: 'PR-2', condition: 'a non-empty reason' },

  // --- from in_review ----------------------------------------------------
  { from: 'in_review', to: 'in_progress', kind: 'allowed', rule: 'ST-15', reason: 'in_review -> in_progress sends the work back for changes.' },
  { from: 'in_review', to: 'done', kind: 'gated', rule: 'ST-16', reason: 'Completing a task requires a commit on its branch.', gate: 'PR-3', condition: 'a commit on the task branch' },
  { from: 'in_review', to: 'blocked', kind: 'allowed', rule: 'ST-17', reason: 'in_review -> blocked records that the review found a blocker.' },
  { from: 'in_review', to: 'cancelled', kind: 'gated', rule: 'ST-18', reason: 'Cancelling a task requires a reason.', gate: 'PR-2', condition: 'a non-empty reason' },

  // --- from blocked ------------------------------------------------------
  { from: 'blocked', to: 'todo', kind: 'allowed', rule: 'ST-19', reason: 'blocked -> todo unblocks the task back into the queue.' },
  { from: 'blocked', to: 'in_progress', kind: 'allowed', rule: 'ST-20', reason: 'blocked -> in_progress resumes the work directly.' },
  { from: 'blocked', to: 'cancelled', kind: 'gated', rule: 'ST-21', reason: 'Cancelling a task requires a reason.', gate: 'PR-2', condition: 'a non-empty reason' },

  // --- from done ---------------------------------------------------------
  { from: 'done', to: 'in_review', kind: 'refused', rule: 'ST-22', reason: 'done -> in_review is refused: reopening a finished task is not automatic.' },
  { from: 'done', to: 'in_progress', kind: 'refused', rule: 'ST-23', reason: 'done -> in_progress is refused: reopening a finished task is not automatic.' },
  { from: 'done', to: 'todo', kind: 'refused', rule: 'ST-24', reason: 'done -> todo is refused: reopening a finished task is not automatic.' },
  { from: 'done', to: 'cancelled', kind: 'refused', rule: 'ST-25', reason: 'done -> cancelled is refused: a finished task is not cancelled.' },

  // --- from cancelled ----------------------------------------------------
  { from: 'cancelled', to: 'todo', kind: 'refused', rule: 'ST-26', reason: 'cancelled is a terminal state: a cancelled task cannot be reopened.' },
  { from: 'cancelled', to: 'in_progress', kind: 'refused', rule: 'ST-26', reason: 'cancelled is a terminal state: a cancelled task cannot be reopened.' },
  { from: 'cancelled', to: 'in_review', kind: 'refused', rule: 'ST-26', reason: 'cancelled is a terminal state: a cancelled task cannot be reopened.' },
  { from: 'cancelled', to: 'blocked', kind: 'refused', rule: 'ST-26', reason: 'cancelled is a terminal state: a cancelled task cannot be reopened.' },
  { from: 'cancelled', to: 'done', kind: 'refused', rule: 'ST-26', reason: 'cancelled is a terminal state: a cancelled task cannot be reopened.' },
  { from: 'cancelled', to: 'backlog', kind: 'refused', rule: 'ST-26', reason: 'cancelled is a terminal state: a cancelled task cannot be reopened.' },
  { from: 'cancelled', to: 'cancelled', kind: 'refused', rule: 'ST-26', reason: 'cancelled is a terminal state: a cancelled task cannot be reopened.' },

  // --- anything -> backlog ----------------------------------------------
  // `cancelled -> backlog` is not here: it is covered above by ST-26,
  // because a cancelled task is terminal and the terminal rule says more
  // about why than "only a task in todo may be de-prioritised".
  { from: 'backlog', to: 'backlog', kind: 'refused', rule: 'ST-27', reason: 'only a task in todo may be de-prioritised back to backlog.' },
  { from: 'in_progress', to: 'backlog', kind: 'refused', rule: 'ST-27', reason: 'only a task in todo may be de-prioritised back to backlog.' },
  { from: 'in_review', to: 'backlog', kind: 'refused', rule: 'ST-27', reason: 'only a task in todo may be de-prioritised back to backlog.' },
  { from: 'blocked', to: 'backlog', kind: 'refused', rule: 'ST-27', reason: 'only a task in todo may be de-prioritised back to backlog.' },
  { from: 'done', to: 'backlog', kind: 'refused', rule: 'ST-27', reason: 'only a task in todo may be de-prioritised back to backlog.' },

  // --- staying put -------------------------------------------------------
  { from: 'todo', to: 'todo', kind: 'allowed', rule: 'ST-28', reason: 'A task may stay where it is.' },
  { from: 'in_progress', to: 'in_progress', kind: 'allowed', rule: 'ST-28', reason: 'A task may stay where it is.' },
  { from: 'in_review', to: 'in_review', kind: 'allowed', rule: 'ST-28', reason: 'A task may stay where it is.' },
  { from: 'blocked', to: 'blocked', kind: 'allowed', rule: 'ST-28', reason: 'A task may stay where it is.' },
  { from: 'backlog', to: 'blocked', kind: 'refused', rule: 'ST-29', reason: "backlog -> blocked is refused: a task must be pulled into 'todo' before it can be blocked." },
  { from: 'done', to: 'done', kind: 'allowed', rule: 'ST-28', reason: 'A task may stay where it is.' },
];

/**
 * Look up a transition.
 *
 * A missing row is itself a refusal: an unlisted pair is not permitted.
 * That way the table need not enumerate "every state to every other
 * state" -- the absent pairs are refused by construction, and the reason
 * says so.
 */
export function findTransition(from: TaskState, to: TaskState): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** The verdict for a transition, with a default for the unlisted pairs. */
export function canTransition(
  from: TaskState,
  to: TaskState,
): { kind: TransitionKind; rule: string; reason: string; gate?: string; condition?: string } {
  const t = findTransition(from, to);
  if (!t) {
    return {
      kind: 'refused',
      rule: 'ST-0',
      reason: `${from} -> ${to} is refused: the transition is not in the task state machine.`,
    };
  }
  return { kind: t.kind, rule: t.rule, reason: t.reason, gate: t.gate, condition: t.condition };
}

/**
 * The tasks that block this one.
 *
 * A task whose blockers are not all `done` may not enter `in_progress`.
 * This is checked after the transition is validated, so an invalid
 * transition is reported as a state-machine refusal and a valid one is
 * reported as blocked.
 */
export function dependencyBlockers(board: Board, task: Task): Task[] {
  return blockersOf(board, task);
}
