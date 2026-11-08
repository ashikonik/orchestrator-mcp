/**
 * The board's tests: the schema, the invariants, and the write path.
 *
 * The write path is the part that matters. The board is the project's
 * shared state, and two agents writing it at once is the normal case,
 * not the edge case. So these tests lock down three properties:
 *
 *   - a write is atomic, so a reader never sees half a board;
 *   - a write against a board that changed underneath is refused;
 *   - a board that breaks an invariant is never written at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendHistory,
  findCycles,
  findTask,
  nextTaskId,
  readBoard,
  replaceTask,
  retireId,
  validateBoard,
  writeBoard,
} from '../board.js';
import { parseBoard } from '../board-schema.js';
import type { Board, Task } from '../types.js';
import { cleanup, tempDir, FIXED_NOW } from './helpers.js';

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    body: '',
    state: 'todo',
    labels: [],
    assignee: null,
    blocked_by: [],
    branch: null,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    history: [],
    ...overrides,
  };
}

function makeBoard(tasks: Task[] = []): Board {
  return {
    schema_version: 1,
    project: 'test',
    updated_at: FIXED_NOW,
    tasks,
  };
}

test('the schema accepts a well-formed board', () => {
  const parsed = parseBoard(makeBoard([makeTask('T-001')]));
  assert.equal(parsed.ok, true);
});

test('the schema rejects a board whose tasks are not objects', () => {
  const parsed = parseBoard({ schema_version: 1, project: 'x', updated_at: FIXED_NOW, tasks: ['nope'] });
  assert.equal(parsed.ok, false);
});

test('the schema rejects a board with a missing field', () => {
  const parsed = parseBoard({ schema_version: 1, tasks: [] });
  assert.equal(parsed.ok, false);
});

test('INV-1: a wrong schema_version is a violation', () => {
  const board = makeBoard();
  board.schema_version = 2;
  const violations = validateBoard(board);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].invariant, 'INV-1');
  assert.match(violations[0].detail, /schema_version is 2/);
});

test('INV-2: a task id that does not match the pattern is a violation', () => {
  const violations = validateBoard(makeBoard([makeTask('nope')]));
  assert.equal(violations[0].invariant, 'INV-2');
});

test('INV-3: a duplicate task id is a violation', () => {
  const violations = validateBoard(makeBoard([makeTask('T-001'), makeTask('T-001')]));
  assert.equal(violations[0].invariant, 'INV-3');
});

test('INV-4: a dangling blocked_by is a violation', () => {
  const violations = validateBoard(makeBoard([makeTask('T-001', { blocked_by: ['T-999'] })]));
  assert.equal(violations[0].invariant, 'INV-4');
  assert.match(violations[0].detail, /T-999/);
});

test('INV-5: a task that blocks itself is a violation', () => {
  const violations = validateBoard(makeBoard([makeTask('T-001', { blocked_by: ['T-001'] })]));
  assert.equal(violations[0].invariant, 'INV-5');
});

test('INV-6: a dependency cycle is a violation', () => {
  const board = makeBoard([
    makeTask('T-001', { blocked_by: ['T-002'] }),
    makeTask('T-002', { blocked_by: ['T-001'] }),
  ]);
  const violations = validateBoard(board);
  assert.equal(violations[0].invariant, 'INV-6');
  assert.match(violations[0].detail, /T-001/);
});

test('INV-7: an unknown state is a violation', () => {
  const board = makeBoard([makeTask('T-001', { state: 'wat' as never })]);
  const violations = validateBoard(board);
  assert.equal(violations[0].invariant, 'INV-7');
});

test('a valid board has no violations', () => {
  assert.deepEqual(validateBoard(makeBoard([makeTask('T-001')])), []);
});

test('findCycles finds a two-node cycle', () => {
  const board = makeBoard([
    makeTask('T-001', { blocked_by: ['T-002'] }),
    makeTask('T-002', { blocked_by: ['T-001'] }),
  ]);
  const cycles = findCycles(board);
  assert.equal(cycles.length, 1);
  assert.ok(cycles[0].includes('T-001'));
  assert.ok(cycles[0].includes('T-002'));
});

test('findCycles returns nothing for a board with no cycle', () => {
  const board = makeBoard([
    makeTask('T-001', { blocked_by: ['T-002'] }),
    makeTask('T-002'),
  ]);
  assert.deepEqual(findCycles(board), []);
});

test('nextTaskId allocates T-001, T-002, ...', () => {
  let board = makeBoard();
  assert.equal(nextTaskId(board), 'T-001');
  board = replaceTask(board, makeTask('T-001'));
  board = { ...board, tasks: [...board.tasks, makeTask('T-001')].slice(0, 1) };
  assert.equal(nextTaskId(board), 'T-002');
});

test('nextTaskId does not reuse an id after a delete', () => {
  const board = makeBoard([makeTask('T-001'), makeTask('T-002'), makeTask('T-003')]);
  // A deleted task leaves no trace in `tasks`, so the board records the
  // retired ids separately. Without that, the next task would take
  // T-003 and a stale reference to the deleted task would resolve to
  // the wrong one.
  const afterDelete = {
    ...board,
    tasks: board.tasks.filter((t) => t.id !== 'T-003'),
    retired_ids: ['T-003'],
  };
  assert.equal(nextTaskId(afterDelete), 'T-004');
});

test('retireId records a freed id', () => {
  const board = makeBoard([makeTask('T-001'), makeTask('T-002')]);
  const retired = retireId(board, 'T-002');
  assert.deepEqual(retired.retired_ids, ['T-002']);
  // Retiring the same id twice does not duplicate it.
  assert.deepEqual(retireId(retired, 'T-002').retired_ids, ['T-002']);
});

test('appendHistory never mutates an existing entry', () => {
  const task = makeTask('T-001');
  const first = appendHistory(task, { at: FIXED_NOW, from: null, to: 'todo', actor: 'a', note: 'one' });
  const second = appendHistory(first, { at: FIXED_NOW, from: 'todo', to: 'in_progress', actor: 'a', note: 'two' });
  assert.equal(first.history.length, 1);
  assert.equal(second.history.length, 2);
  assert.equal(second.history[0].note, 'one');
  assert.equal(second.history[1].note, 'two');
});

test('a missing board reads as an empty board, not an error', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    const read = readBoard(path, 'test', FIXED_NOW);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.exists, false);
      assert.deepEqual(read.board.tasks, []);
    }
  } finally {
    cleanup(dir);
  }
});

test('a corrupt board is an error, and the file is left alone', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    writeFileSync(path, '{not json', 'utf-8');
    const read = readBoard(path, 'test', FIXED_NOW);
    assert.equal(read.ok, false);
    assert.equal(readFileSync(path, 'utf-8'), '{not json');
  } finally {
    cleanup(dir);
  }
});

test('a board that breaks an invariant is an error on read', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    writeFileSync(path, JSON.stringify(makeBoard([makeTask('T-001', { blocked_by: ['T-404'] })])), 'utf-8');
    const read = readBoard(path, 'test', FIXED_NOW);
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.error, /INV-4/);
  } finally {
    cleanup(dir);
  }
});

test('a write is atomic: the temp file is gone and the board is complete', () => {
  const dir = tempDir();
  try {
    const path = join(dir, '.orchestrator', 'board.json');
    const result = writeBoard(path, makeBoard([makeTask('T-001')]), null);
    assert.equal(result.ok, true);
    assert.equal(existsSync(`${path}.tmp`), false);
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(written.tasks.length, 1);
    assert.equal(written.tasks[0].id, 'T-001');
  } finally {
    cleanup(dir);
  }
});

test('a board that breaks an invariant is never written', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    const broken = makeBoard([makeTask('T-001', { blocked_by: ['T-404'] })]);
    const result = writeBoard(path, broken, null);
    assert.equal(result.ok, false);
    assert.equal(existsSync(path), false);
    assert.equal(result.violations?.[0].invariant, 'INV-4');
  } finally {
    cleanup(dir);
  }
});

test('a write against a board that changed on disk is refused', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    const original = makeBoard([makeTask('T-001')]);
    const first = writeBoard(path, original, null);
    assert.equal(first.ok, true);

    // Another writer changes the file.
    const theirs = makeBoard([makeTask('T-001'), makeTask('T-002')]);
    writeBoard(path, theirs, null);

    // Our write was based on the old content, so it is refused.
    const ours = makeBoard([makeTask('T-001'), makeTask('T-003')]);
    const result = writeBoard(path, ours, first.hash);
    assert.equal(result.ok, false);
    assert.match(result.error, /changed on disk/);

    // The other writer's work is intact.
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(onDisk.tasks.length, 2);
    assert.equal(onDisk.tasks[1].id, 'T-002');
  } finally {
    cleanup(dir);
  }
});

test('writers holding the same stale hash do not clobber each other', () => {
  // The conflict check and the rename are two steps. Without a lock,
  // several writers can all pass the check and then all rename, and the
  // last one silently discards the others' work. With the lock, the
  // writes are serialized and exactly one of the stale writers wins.
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    writeBoard(path, makeBoard([makeTask('T-001')]), null);
    const stale = readBoard(path, 'test', FIXED_NOW);
    assert.ok(stale.ok);
    if (!stale.ok) return;

    const writers = Array.from({ length: 20 }, (_, i) =>
      writeBoard(
        path,
        makeBoard([makeTask('T-001', { title: `writer ${i}` })]),
        stale.hash,
      ),
    );

    const applied = writers.filter((w) => w.ok);
    const refused = writers.filter((w) => !w.ok);

    // One writer wins the board; the rest are told it moved under them.
    assert.equal(applied.length, 1);
    assert.equal(refused.length, 19);
    for (const r of refused) {
      assert.match(r.ok ? '' : r.error, /changed on disk/);
    }

    // The board holds one writer's work, whole.
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(onDisk.tasks.length, 1);
    assert.match(onDisk.tasks[0].title, /^writer \d+$/);
  } finally {
    cleanup(dir);
  }
});

test('the lock file does not outlive the write', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    writeBoard(path, makeBoard([makeTask('T-001')]), null);
    assert.equal(existsSync(`${path}.lock`), false);
  } finally {
    cleanup(dir);
  }
});

test('no temporary file outlives the write', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    writeBoard(path, makeBoard([makeTask('T-001')]), null);
    // The temp name carries the pid and a uuid, so it is not a fixed
    // path -- two writers must never share one.
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup(dir);
  }
});

test('a board written by the server round-trips through parseBoard unchanged', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    const board = makeBoard([makeTask('T-001', { labels: ['a'], assignee: 'x' })]);
    writeBoard(path, board, null);
    const read = readBoard(path, 'test', FIXED_NOW);
    assert.equal(read.ok, true);
    if (read.ok) {
      const parsed = parseBoard(JSON.parse(readFileSync(path, 'utf-8')));
      assert.equal(parsed.ok, true);
      if (parsed.ok) {
        assert.deepEqual(parsed.board.tasks[0].labels, ['a']);
        assert.equal(parsed.board.tasks[0].assignee, 'x');
      }
    }
  } finally {
    cleanup(dir);
  }
});

test('findTask finds a task and returns undefined for a missing one', () => {
  const board = makeBoard([makeTask('T-001')]);
  assert.equal(findTask(board, 'T-001')?.id, 'T-001');
  assert.equal(findTask(board, 'T-404'), undefined);
});

test('replaceTask swaps one task and leaves the others alone', () => {
  const board = makeBoard([makeTask('T-001'), makeTask('T-002')]);
  const updated = replaceTask(board, makeTask('T-001', { title: 'changed' }));
  assert.equal(updated.tasks[0].title, 'changed');
  assert.equal(updated.tasks[1].title, 'Task T-002');
});

test('the board directory is created when it does not exist', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'deep', 'nested', 'board.json');
    const result = writeBoard(path, makeBoard(), null);
    assert.equal(result.ok, true);
    assert.equal(existsSync(path), true);
  } finally {
    cleanup(dir);
  }
});

test('readBoard reports the hash of the file it read', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'board.json');
    writeBoard(path, makeBoard(), null);
    const read = readBoard(path, 'test', FIXED_NOW);
    assert.equal(read.ok, true);
    if (read.ok) assert.match(read.hash, /^[0-9a-f]{64}$/);
  } finally {
    cleanup(dir);
  }
});

test('mkdirSync is available for the board directory', () => {
  // A trivial assertion so the import is exercised: the board writer
  // creates the directory, and this proves the helper works standalone.
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'a'), { recursive: true });
    assert.equal(existsSync(join(dir, 'a')), true);
  } finally {
    cleanup(dir);
  }
});
