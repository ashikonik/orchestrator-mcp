# orchestrator

An MCP server that drives development over a git repository and a task
board stored next to it.

It gives a coding agent one place to see the work, the repository and the
rules that govern both — and it holds the line on the operations that
are hard to undo.

```bash
cd mcp
./scripts/rebuild.sh          # build, test, prove the binary starts
./scripts/register.sh --apply puku-cli
```

---

## What it does

**Twenty-two tools**, in four groups:

| group | tools |
|---|---|
| the board | `board_get` `board_set` `task_list` `task_get` `task_create` `task_update` `task_move` `task_delete` `task_next` `task_claim` `task_note` |
| the repository | `git_status` `git_diff` `git_log` `git_commit` `git_operate` `git_combine` `git_worktree` |
| the forge | `open_pr` `plan_from_commits` |
| the policy | `policy_get` `policy_set` |

The board is a JSON file in the project. The repository is the git repo
you are already in. The policy is a table of rules the server enforces.

---

## The three ideas

### The gate is a policy, not a prompt

Write tools **execute** when called. There is no confirmation dialog and
no "are you sure?" — an agent that has to ask permission for every
commit is an agent that cannot work.

What stands between a call and the outside world is a **declarative rule
table**: 53 rules, each naming an operation, a verdict and a reason.

The verdicts are three, not two:

- `allow` — go ahead.
- `deny` — no.
- `conditional` — **not yet**, and here is the specific thing that is
  missing.

`conditional` is what makes this work without a human in the loop. A
cancelled task needs a reason. A completed task needs a commit on its
branch. A delete needs a confirmation. A claim needs an unblocked task
nobody else holds. The refusal names the missing evidence, so the caller
can supply it and call again.

Every write tool also takes `dry_run`, which returns the exact argv it
would run without running it.

Every conditional rule is **satisfiable**, and a test proves it. A rule
whose evidence is never recognised is switched off forever, and a
refusal-path test cannot tell the difference — so the suite also asks
whether each rule can be passed. It has already caught two rules that
held every push and every merge with no way past.

### The git surface is a table, and there is never a shell

Every git invocation the server can make is written out as a literal argv
array in `src/git.ts` — 57 of them. There is no pass-through `git` tool
and no way to run an arbitrary command.

The table is the **source of truth**, not a catalogue: every builder
reads its argv from it, and a test fails if an entry is not reached. So
the table cannot drift away from what actually runs.

Every value is a separate argv element, and `spawnSync` is called with
`shell: false`. A branch named `; rm -rf ~` is a branch name that fails
validation. It is never a command.

The tests assert the *absence* of the dangerous invocations as well as
the presence of the safe ones.

### The board is a file, and it is shared state

`<project>/.orchestrator/board.json` — one JSON file. It can be read,
diffed, edited by hand and committed.

Two agents writing it at once is the normal case, so the write path
guarantees four things:

- a write is **atomic** (temp file, then rename) — a reader never sees
  half a board;
- writes are **serialized** by an exclusive lock — two writers cannot
  both pass the conflict check before either renames;
- a write against a board that **changed underneath is refused** — the
  other writer's work survives;
- a board that **breaks an invariant is never written at all**.

---

## Two git tools worth knowing about

**`git_combine`** checks whether branches can be merged together — without
merging them and without touching the working tree. Two green branches
can still break when combined; this finds out before the merge does.
It names the *conflicting paths*, not merely that something conflicted.

**`git_worktree`** manages worktrees: adding one for a branch, listing
them, removing one, pruning the ones whose directories are gone. A
worktree *inside* the main checkout is refused — it would show up as
untracked there, and `git add --all` would stage the whole thing.

---

## The board

```json
{
  "schema_version": 1,
  "project": "my-project",
  "updated_at": "2026-11-07T14:22:31Z",
  "tasks": [
    {
      "id": "T-001",
      "title": "Add the greeting",
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
        { "at": "2026-11-07T14:00:00Z", "from": null, "to": "todo", "actor": "orchestrator", "note": "created" }
      ]
    }
  ]
}
```

Seven states — `backlog`, `todo`, `in_progress`, `in_review`, `blocked`,
`done`, `cancelled` — and 43 explicit transitions. `todo -> done` is
refused; a cancellation needs a reason; a completion needs a commit.

Eleven invariants — `INV-1` … `INV-11` — cover the schema version, the
id format, duplicate ids, dangling dependencies, self-dependencies,
dependency cycles, unknown states, and the hierarchy: a `parent` must
exist, a task cannot be its own parent, the hierarchy cannot cycle, and
a task cannot hold the same lock twice.

Five optional fields carry the newer parts of the work: `parent` (a task
under an epic), `priority` (rank among siblings), `notes` (append-only
discussion), `claim` (who holds it, until when) and `locks` (the paths
a task declares it touches).

The `agent` on a claim is a **label the caller supplies** — the server
records it and cannot verify it. The claim prevents two agents colliding
by accident; it is not authentication.

Task ids are **never reused**. A deleted task's id is retired, so a
stale reference to it can never resolve to a different task.

### Working in parallel

Three tools exist because more than one agent may be working at once:

- `task_next` picks the next task — highest priority, most recently
  updated, skipping blocked and claimed work. Deterministic: the same
  board always gives the same answer.
- `task_claim` takes a task with a **lease**. Another agent cannot take
  a live claim, and a claim whose locks overlap another task's is
  refused with the holder named.
- `task_note` appends discussion without changing the task's state.

Writes to `task_create`, `task_note` and `task_claim` accept an
`idempotency_key`, so a retried call performs the write once and
returns the first result.

---

## Layout

```
orchestrator/
└── mcp/
    ├── src/
    │   ├── index.ts          the transport, and nothing else
    │   ├── server.ts         the 22 tools
    │   ├── policy.ts         evaluation: deny > conditional > allow
    │   ├── policy-rules.ts   the 53 rules
    │   ├── states.ts         the 43 transitions
    │   ├── board.ts          read, write, validate
    │   ├── board-schema.ts   the on-disk shapes, in Zod
    │   ├── git.ts            the 57 argv arrays
    │   ├── gh.ts             the 4 argv arrays
    │   ├── root.ts           where am I working?
    │   ├── types.ts          the shared shapes
    │   └── tests/            340 tests
    ├── scripts/
    │   ├── rebuild.sh        install, compile, test, smoke
    │   ├── run-tests.sh      the test runner, with a zero-test guard
    │   ├── smoke.mjs         the binary over real stdio
    │   ├── e2e.mjs           the binary against a real repository
    │   └── register.sh       the harness table
    └── docs/
        ├── ARCHITECTURE.md
        ├── POLICY.md
        ├── TOOL_REFERENCE.md
        ├── BOARD_FORMAT.md
        └── REGISTERING.md
```

`src/index.ts` is the only file that knows a transport exists. Every
other module is importable from a test with no network, no subprocess
and no MCP client.

---

## The gates

Three independent checks stand between a call and the outside world, and
each refusal names the rule that stopped it:

| gate | rule ids | doc |
|---|---|---|
| the policy | `PR-*` | [POLICY.md](mcp/docs/POLICY.md) |
| the state machine | `ST-*` | [BOARD_FORMAT.md](mcp/docs/BOARD_FORMAT.md) |
| the board invariants | `INV-*` | [BOARD_FORMAT.md](mcp/docs/BOARD_FORMAT.md) |

---

## Testing

```bash
cd mcp
npm test              # 340 tests, in-process
npm run smoke         # the binary over real stdio
node scripts/e2e.mjs  # the binary against a real repository
./scripts/rebuild.sh  # all of it, from a clean install
```

The unit tests drive the server in-process over an in-memory transport.
The smoke test spawns the real `dist/index.js` and checks the
handshake, the tool list and that stdout carried nothing but protocol
messages. The e2e test runs the real binary against a throwaway git
repository and proves that a task lands on the board, a commit lands in
git, a push to `main` is refused with `PR-16`, `todo -> done` is refused
with `ST-9`, a dry run writes nothing, a policy file tightens a rule and
the tools honour it, a deleted task's id is never reused, and two
concurrent writers lose no update.

It also covers the newer flows: the new board fields survive the round
trip, a claim is taken and released, a keyed note is not duplicated,
`task_next` picks the highest-priority unclaimed task, `git_combine`
names the conflicting path, and a worktree is added outside the
repository.

Three suites are worth calling out, because each answers a question the
others cannot:

- **`policy-satisfiable.test.ts`** asserts that every conditional rule
  *can* be satisfied. A rule whose evidence is never recognised is
  switched off forever, and a refusal-path test cannot tell that from a
  working gate.
- **`bugfixes.test.ts`** is the regression suite for the five bugs the
  survey turned up — a diffstat that described the wrong changes, a
  `git log` that parsed a branch as a path, and a board write that
  silently dropped the fields it was given.
- **`features.test.ts`** covers the new tools, the new gates and the new
  board fields, including the refusals.

---

## Registering

```bash
cd mcp
./scripts/register.sh --list
./scripts/register.sh --apply puku-cli
./scripts/register.sh --apply --project /path/to/repo claude-code
```

`claude-code`, `puku-cli`, `opencode`, `codex` and `codex-agents` are
supported out of the box. `cline` and `agentsmd` have no MCP config
surface on this machine — point their MCP server settings at
`node .../dist/index.js` directly.

Full details, including the exact snippets and the environment
variables, are in [REGISTERING.md](mcp/docs/REGISTERING.md).

---

## Requirements

- Node 20 or newer
- `git` on the `PATH`
- `gh` on the `PATH`, authenticated — only for `open_pr`; every other
  tool works without it

The server starts offline. Nothing is fetched at startup.

---

## Documentation

| document | what is in it |
|---|---|
| [ARCHITECTURE.md](mcp/docs/ARCHITECTURE.md) | how it is put together, and why |
| [POLICY.md](mcp/docs/POLICY.md) | all 53 rules, and how a decision is made |
| [TOOL_REFERENCE.md](mcp/docs/TOOL_REFERENCE.md) | all 22 tools, argument by argument |
| [BOARD_FORMAT.md](mcp/docs/BOARD_FORMAT.md) | the board file, the states, the invariants |
| [REGISTERING.md](mcp/docs/REGISTERING.md) | registering with each harness |
