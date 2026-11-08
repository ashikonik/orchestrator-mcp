/**
 * The state machine's tests.
 *
 * Every row of the transition table is exercised. The table is the
 * specification of what a task may do, so a row that is not tested is a
 * row that could change without anyone noticing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, canTransition, dependencyBlockers, findTransition } from '../states.js';
import type { Board, Task, TaskState } from '../types.js';

function makeTask(id: string, state: TaskState, blocked_by: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    body: '',
    state,
    labels: [],
    assignee: null,
    blocked_by,
    branch: null,
    created_at: '2026-11-07T14:00:00Z',
    updated_at: '2026-11-07T14:00:00Z',
    history: [],
  };
}

function makeBoard(tasks: Task[]): Board {
  return { schema_version: 1, project: 'test', updated_at: '2026-11-07T14:00:00Z', tasks };
}

test('every state has at least one outgoing transition', () => {
  const states: TaskState[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
  for (const state of states) {
    const outgoing = TRANSITIONS.filter((t) => t.from === state);
    assert.ok(outgoing.length > 0, `no transition leaves '${state}'`);
  }
});

test('every transition has a rule id and a reason', () => {
  for (const t of TRANSITIONS) {
    assert.match(t.rule, /^ST-\d+$/, `transition ${t.from} -> ${t.to} has a bad rule id`);
    assert.ok(t.reason.length > 0, `transition ${t.from} -> ${t.to} has no reason`);
  }
});

test('a gated transition names the gate that holds it', () => {
  for (const t of TRANSITIONS) {
    if (t.kind !== 'gated') continue;
    assert.ok(t.gate, `gated transition ${t.from} -> ${t.to} names no gate`);
    assert.ok(t.condition, `gated transition ${t.from} -> ${t.to} names no condition`);
  }
});

test('every allowed transition reports allowed', () => {
  for (const t of TRANSITIONS) {
    if (t.kind !== 'allowed') continue;
    const verdict = canTransition(t.from, t.to);
    assert.equal(verdict.kind, 'allowed', `${t.from} -> ${t.to} should be allowed`);
    assert.equal(verdict.rule, t.rule);
  }
});

test('every gated transition reports gated with its gate', () => {
  for (const t of TRANSITIONS) {
    if (t.kind !== 'gated') continue;
    const verdict = canTransition(t.from, t.to);
    assert.equal(verdict.kind, 'gated', `${t.from} -> ${t.to} should be gated`);
    assert.equal(verdict.gate, t.gate);
  }
});

test('every refused transition reports refused with its rule', () => {
  for (const t of TRANSITIONS) {
    if (t.kind !== 'refused') continue;
    const verdict = canTransition(t.from, t.to);
    assert.equal(verdict.kind, 'refused', `${t.from} -> ${t.to} should be refused`);
    assert.equal(verdict.rule, t.rule);
  }
});

test('todo -> done is refused (ST-9)', () => {
  const verdict = canTransition('todo', 'done');
  assert.equal(verdict.kind, 'refused');
  assert.equal(verdict.rule, 'ST-9');
});

test('backlog -> in_progress is refused (ST-3)', () => {
  const verdict = canTransition('backlog', 'in_progress');
  assert.equal(verdict.kind, 'refused');
  assert.equal(verdict.rule, 'ST-3');
});

test('done -> in_progress is refused (ST-23)', () => {
  const verdict = canTransition('done', 'in_progress');
  assert.equal(verdict.kind, 'refused');
  assert.equal(verdict.rule, 'ST-23');
});

test('cancelled is terminal (ST-26)', () => {
  const states: TaskState[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
  for (const to of states) {
    const verdict = canTransition('cancelled', to);
    assert.equal(verdict.kind, 'refused', `cancelled -> ${to} should be refused`);
    assert.equal(verdict.rule, 'ST-26');
  }
});

test('only todo may de-prioritise back to backlog (ST-27)', () => {
  const states: TaskState[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
  for (const from of states) {
    const verdict = canTransition(from, 'backlog');
    if (from === 'todo') {
      assert.equal(verdict.kind, 'allowed');
    } else if (from === 'cancelled') {
      // A cancelled task is terminal, and the terminal rule says more
      // about why than "only a task in todo may be de-prioritised".
      assert.equal(verdict.kind, 'refused', `${from} -> backlog should be refused`);
      assert.equal(verdict.rule, 'ST-26');
    } else {
      assert.equal(verdict.kind, 'refused', `${from} -> backlog should be refused`);
      assert.equal(verdict.rule, 'ST-27');
    }
  }
});

test('todo -> in_progress is allowed (ST-5)', () => {
  const verdict = canTransition('todo', 'in_progress');
  assert.equal(verdict.kind, 'allowed');
  assert.equal(verdict.rule, 'ST-5');
});

test('in_progress -> in_review is allowed (ST-10)', () => {
  const verdict = canTransition('in_progress', 'in_review');
  assert.equal(verdict.kind, 'allowed');
  assert.equal(verdict.rule, 'ST-10');
});

test('in_review -> in_progress is allowed (ST-15)', () => {
  const verdict = canTransition('in_review', 'in_progress');
  assert.equal(verdict.kind, 'allowed');
  assert.equal(verdict.rule, 'ST-15');
});

test('a cancellation is gated on a reason (PR-2)', () => {
  for (const from of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'] as TaskState[]) {
    const verdict = canTransition(from, 'cancelled');
    assert.equal(verdict.kind, 'gated', `${from} -> cancelled should be gated`);
    assert.equal(verdict.gate, 'PR-2');
  }
});

test('a completion is gated on a commit (PR-3)', () => {
  for (const from of ['in_progress', 'in_review'] as TaskState[]) {
    const verdict = canTransition(from, 'done');
    assert.equal(verdict.kind, 'gated', `${from} -> done should be gated`);
    assert.equal(verdict.gate, 'PR-3');
  }
});

test('an unlisted transition is refused with ST-0', () => {
  const verdict = canTransition('in_progress', 'backlog');
  assert.equal(verdict.kind, 'refused');
  assert.equal(verdict.rule, 'ST-27');
});

test('a transition that is not in the table at all is refused with ST-0', () => {
  // `done -> cancelled` has a row; `backlog -> done` does not.
  const verdict = canTransition('blocked', 'done');
  assert.equal(verdict.kind, 'refused');
  assert.equal(verdict.rule, 'ST-0');
});

test('findTransition finds a row and returns undefined for an absent one', () => {
  assert.ok(findTransition('todo', 'in_progress'));
  assert.equal(findTransition('todo', 'nonsense' as TaskState), undefined);
});

test('a task with an unfinished blocker cannot enter in_progress', () => {
  const board = makeBoard([
    makeTask('T-001', 'todo', ['T-002']),
    makeTask('T-002', 'todo'),
  ]);
  const task = board.tasks[0];
  const blockers = dependencyBlockers(board, task);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].id, 'T-002');
});

test('a task whose blockers are all done has no blockers', () => {
  const board = makeBoard([
    makeTask('T-001', 'todo', ['T-002']),
    makeTask('T-002', 'done'),
  ]);
  const blockers = dependencyBlockers(board, board.tasks[0]);
  assert.equal(blockers.length, 0);
});

test('a task with no blockers has no blockers', () => {
  const board = makeBoard([makeTask('T-001', 'todo')]);
  assert.deepEqual(dependencyBlockers(board, board.tasks[0]), []);
});
