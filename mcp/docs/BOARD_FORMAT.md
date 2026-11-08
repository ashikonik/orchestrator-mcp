# The board format

The board is one JSON file: `<project>/.orchestrator/board.json`.

It is the project's shared state, and it is designed to be read by a
person as well as by the server. It can be opened in an editor, diffed
in a pull request, and committed.

---

## The file

```json
{
  "schema_version": 1,
  "project": "my-project",
  "updated_at": "2026-11-07T14:22:31Z",
  "retired_ids": ["T-007"],
  "tasks": [
    {
      "id": "T-001",
      "title": "Add the greeting",
      "body": "The first task the board ever sees.",
      "state": "in_progress",
      "labels": ["e2e"],
      "assignee": null,
      "blocked_by": [],
      "branch": "feat/greeting",
      "created_at": "2026-11-07T14:00:00Z",
      "updated_at": "2026-11-07T14:22:31Z",
      "parent": "T-000",
      "priority": 5,
      "locks": ["src/greeting.ts"],
      "claim": {
        "agent": "agent-a",
        "at": "2026-11-07T14:22:31Z",
        "lease_expires_at": "2026-11-07T14:37:31Z"
      },
      "notes": [
        { "at": "2026-11-07T14:22:31Z", "actor": "agent-a", "text": "The parser is half done." }
      ],
      "history": [
        { "at": "2026-11-07T14:00:00Z", "from": null, "to": "todo", "actor": "orchestrator", "note": "created" },
        { "at": "2026-11-07T14:22:31Z", "from": "todo", "to": "in_progress", "actor": "orchestrator", "note": "" }
      ]
    }
  ]
}
```

### The top level

| field | type | meaning |
|---|---|---|
| `schema_version` | number | always `1` |
| `project` | string | the project name, derived from the directory |
| `updated_at` | string | ISO-8601, second precision, UTC |
| `retired_ids` | string[] | ids that were used and freed; optional |
| `tasks` | array | the tasks |

### A task

| field | type | meaning |
|---|---|---|
| `id` | string | `T-` followed by digits |
| `title` | string | one line |
| `body` | string | free text, may be empty |
| `state` | string | one of the seven states |
| `labels` | string[] | free-form |
| `assignee` | string \| null | free-form |
| `blocked_by` | string[] | task ids |
| `branch` | string \| null | the branch the work happens on |
| `created_at` | string | ISO-8601 |
| `updated_at` | string | ISO-8601 |
| `history` | array | append-only |
| `parent` | string \| null | the task this one is a piece of; optional |
| `priority` | number | rank among its siblings; higher is more urgent; optional |
| `notes` | array | append-only discussion; optional |
| `claim` | object \| null | who holds the task, until when; optional |
| `locks` | string[] | paths this task holds locks on; optional |

The five fields below the line are all **optional**, so a board written
before they existed still parses. A board that does not use them simply
does not have them.

### A history entry

| field | type | meaning |
|---|---|---|
| `at` | string | ISO-8601 |
| `from` | string \| null | the state before; `null` on creation |
| `to` | string | the state after |
| `actor` | string | who made the change |
| `note` | string | free text |

History is append-only. An entry is never edited and never removed.

### A note

| field | type | meaning |
|---|---|---|
| `at` | string | ISO-8601 |
| `actor` | string | who said it |
| `text` | string | what they said |
| `idempotency_key` | string | the key that made this note idempotent, when it had one; optional |

Notes are append-only, like history — but they are a different thing.
`history` records *state changes*; a note records something someone said.
A task can have both, and `task_get` returns both.

### A claim

| field | type | meaning |
|---|---|---|
| `agent` | string | the claiming agent's label |
| `at` | string | when the claim was taken |
| `lease_expires_at` | string | when the lease lapses |
| `idempotency_key` | string | the key that made this claim idempotent, when it had one; optional |

The claim says which agent is working on the task, and until when.

**The `agent` field is a label the caller supplies. The server records
it; it does not verify it.** This server is stdio — one process, one
client connection, one principal — so there is nothing to check against.
The claim prevents two agents from working on the same task *by
accident*, which is the case it exists for. It is not access control,
and it does not authenticate anybody.

A future transport that could carry a verified principal would replace
the label with an attribution. The field's shape would not change.

---

## The seven states

```
    backlog ──────► todo ──────► in_progress ──────► in_review
       │              │  ▲            │  ▲                │
       │              │  └────────────┘  │                │
       │              ▼                  │                ▼
       └──────────► blocked              └─────────────► done

    any state ───────────────────────────► cancelled
```

| state | means |
|---|---|
| `backlog` | recorded, not scheduled |
| `todo` | ready to start |
| `in_progress` | being worked on |
| `in_review` | waiting for review |
| `blocked` | waiting on something |
| `done` | finished; its branch has a commit |
| `cancelled` | dropped, with a reason |

The transitions are not free. The full table is 43 rows in `states.ts`,
each with a rule id. The rules that bite:

- `todo -> done` is refused (`ST-9`). A task goes through the work.
- `backlog -> in_progress` is refused (`ST-3`). A task is scheduled first.
- `cancelled` is terminal (`ST-26`). Nothing comes out of it.
- only `todo` may go back to `backlog` (`ST-27`) — de-prioritising.
- every cancellation is gated on a reason (`PR-2`).
- every completion is gated on a commit on the task's branch (`PR-3`).

---

## The invariants

Eleven rules the board must satisfy. They are checked on every read and
every write, and a board that breaks one is never written.

| id | invariant |
|---|---|
| INV-1 | `schema_version` is 1 |
| INV-2 | every task id matches `T-\d+` |
| INV-3 | no two tasks share an id |
| INV-4 | every `blocked_by` names a task that exists |
| INV-5 | no task blocks itself |
| INV-6 | the dependency graph has no cycle |
| INV-7 | every state is one of the seven |
| INV-8 | every `parent` names a task that exists |
| INV-9 | no task is its own parent |
| INV-10 | the hierarchy has no cycle |
| INV-11 | no task holds the same lock twice |

### What the hierarchy invariants mean in practice

INV-8 means **containment implies existence**. A task cannot be a piece
of a task that is not on the board, so a child cannot be created before
its parent exists.

INV-8 also means **deleting a parent with children fails**, with an
invariant error rather than an orphan. That is a consequence of what
containment means, not an accident of the implementation: a child whose
parent has vanished is a child of nothing.

INV-10 means the hierarchy is a **tree**, not a graph. `T-001 → T-002 →
T-001` cannot exist.

`parent` and `blocked_by` are different axes and both are kept. `parent`
is containment — this task is a piece of that one. `blocked_by` is
ordering — this task cannot start until that one is done. A task can be
a piece of an epic *and* be blocked by a bug fix.

### Locks

`locks` is a list of repository-relative paths the task declares it is
working on. INV-11 says the same path is not listed twice within one
task.

Two tasks holding overlapping locks are working on the same file. The
claim path refuses the second claim and names the holder — a task
holding `src/a.ts` and a task holding `src/a.ts` or `src/a/util.ts`
overlap; `src/a.ts` and `src/b.ts` do not.

This is a *declared* claim, not a filesystem lock. It prevents the
accidental collision that parallel agents cause; it does not stop a
process from writing the file anyway.

A violation is reported by id and detail:

```json
{
  "applied": false,
  "error": "refusing to write: the board breaks 1 invariant(s): INV-4 (task 'T-001' is blocked_by 'T-999', which is not a task on this board)",
  "violations": [
    {
      "invariant": "INV-4",
      "detail": "task 'T-001' is blocked_by 'T-999', which is not a task on this board"
    }
  ]
}
```

The file on disk is left exactly as it was.

---

## Ids are never reused

A deleted task leaves no trace in `tasks`, so the board keeps a
`retired_ids` list. The allocator skips them.

Without it, deleting `T-003` and then creating a task would hand out
`T-003` again — and any stale reference to the deleted task (in a
comment, a branch name, a pull request description) would silently
resolve to a different task.

`retired_ids` is optional so that a hand-written board without it still
parses. The server adds it as soon as a task is deleted.

---

## How the board is written

### Atomic

The board is written to a temporary file and then renamed over the
target. A reader never sees half a board, and a crash mid-write leaves
the previous board intact. The temporary file's name carries the
writer's pid and a uuid, so two writers never share one.

### Serialized

A writer takes an exclusive lock on the board before it touches it. The
lock is a file created with `O_EXCL` — exactly one writer creates it,
and the others are told it is held.

The lock is what makes the conflict check below sound. Re-reading the
hash and then renaming are two steps; without a lock, two writers can
both pass the check before either renames, and the second one silently
discards the first one's work.

A lock older than ten seconds is treated as abandoned and taken over,
so a writer that dies holding it does not wedge the board.

### Guarded against concurrent writers

Each write carries the SHA-256 of the content it was based on. If the
file on disk no longer matches, the write is refused:

```json
{
  "applied": false,
  "error": "refusing to write: /repo/.orchestrator/board.json changed on disk since it was read (expected a1b2c3d4e5f6, found 0f9e8d7c6b5a). Another writer got there first -- re-read the board and apply the change again."
}
```

The other writer's work is left intact. Two agents on the same board is
the normal case, not the edge case, so this is a first-class outcome
rather than an error to be logged and ignored.

### Validated first

The invariants are checked **before** the write. A board that breaks one
is never persisted, so the file on disk is always a valid board.

---

## Idempotency keys

Three writes accept an optional `idempotency_key`. A key makes a retry
safe: the same key on the same operation performs the write **once**,
and the retry returns the first result instead of doing it again.

| tool | what the key protects |
|---|---|
| `task_create` | the task's **id** — a retry creates no second task |
| `task_note` | the note — a retry appends no second note |
| `task_claim` | the lease — a retry does not take a fresh lease |

`task_create` turns the key into the task's id directly: the key is
hashed, and the hash becomes the id. So the id is *deterministic* — the
same key always names the same task — and a retry finds the task that
key made and returns it.

The keyed ids are large (`T-1000000000` and up), deliberately above the
sequential numbering. So a keyed task never disturbs the `T-001`,
`T-002`, … sequence, and the ordinary ids stay readable.

A write with no key is not idempotent, and that is the right default: a
note without a key is a new note every time, because "the caller said
this twice" and "the caller retried" are indistinguishable without a
key to tell them apart.

The key is stored on the record it protected — `notes[].idempotency_key`
and `claim.idempotency_key` — so the retry can be recognised later.

---

## Where the board lives

By default: `<project>/.orchestrator/board.json`.

`ORCHESTRATOR_BOARD` overrides the path. The `project` argument on a
tool call overrides the root, and the root determines the default path.

The board does not have to live inside the repository. Point
`ORCHESTRATOR_BOARD` somewhere else and the repository and the board
stay separate — useful when the board is shared across repositories, or
kept out of version control on purpose.

---

## The policy file

Alongside the board, at `<project>/.orchestrator/policy.json`:

```json
{
  "schema_version": 1,
  "default_branch": "main",
  "protected_branches": ["main", "release/*"],
  "allowed_merge_strategies": ["merge", "rebase"],
  "commit_message_pattern": "^(feat|fix|chore): .+",
  "deny": ["PR-1"]
}
```

| field | meaning |
|---|---|
| `default_branch` | the base branch |
| `protected_branches` | patterns; `release/*` matches by prefix |
| `allowed_merge_strategies` | `merge` and `rebase`; `squash` is always refused |
| `commit_message_pattern` | the regular expression a commit message must match |
| `deny` | rule ids to turn into `deny` |

`ORCHESTRATOR_POLICY` overrides the path.

A missing file is normal — the built-in defaults apply. A file that is
present but malformed is an **error**, not a silent fallback: a policy
that quietly fails to load is a policy nobody is enforcing.

`deny` may only tighten. It cannot loosen a built-in `deny` or
`conditional` into an `allow` — see `docs/POLICY.md`.

---

## Reading and writing it by hand

The file is plain JSON and the format is stable, so a board can be
edited by hand or generated by a script:

```bash
# add a task
jq '.tasks += [{
  "id": "T-002",
  "title": "Write the docs",
  "body": "",
  "state": "todo",
  "labels": [],
  "assignee": null,
  "blocked_by": [],
  "branch": null,
  "created_at": "2026-11-07T15:00:00Z",
  "updated_at": "2026-11-07T15:00:00Z",
  "history": []
}]' .orchestrator/board.json > /tmp/b.json && mv /tmp/b.json .orchestrator/board.json
```

Two cautions:

- **Keep `history` append-only.** It is the record of what happened to
  the task. Editing it erases the trail.
- **Bump `updated_at`** when you edit the file by hand. The server uses
  it to report when the board last changed.

If the file is malformed, the server reports the error and refuses to
write over it. It will not "fix" a broken board — the file is left
exactly as it is, for a human to look at.
