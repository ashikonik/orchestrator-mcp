# Architecture

The orchestrator is a local MCP server that drives development over a git
repository and a task board stored next to it. It is one process, one
stdio stream, and no network except the one call it makes to `gh`.

This document explains how it is put together and, more importantly, why.

---

## The shape

```
    ┌──────────────────────────────────────────────────────────┐
    │  coding agent  (cline, opencode, puku-cli, claude code) │
    └───────────────────────────┬──────────────────────────────┘
                                │ MCP over stdio
    ┌───────────────────────────▼──────────────────────────────┐
    │  index.ts        the transport, and nothing else        │
    ├──────────────────────────────────────────────────────────┤
    │  server.ts       the 22 tools; the four-step handler    │
    ├───────────────┬───────────────┬────────────────────────┤
    │  policy.ts    │  states.ts    │  board.ts              │
    │  the rules    │  the moves    │  the file              │
    ├───────────────┴───────────────┴────────────────────────┤
    │  git.ts          gh.ts          root.ts                 │
    │  the argv        the argv       where am I?             │
    └───────────────┬───────────────┬────────────────────────┘
                    │               │
              ┌─────▼─────┐   ┌─────▼──────┐
              │   git     │   │  .orchestrator/
              │           │   │  board.json │
              └───────────┘   └────────────┘
```

`index.ts` is the only file that knows a transport exists. Everything else
is a plain module that a test can import and call. That is why the unit
tests need no network, no subprocess and no MCP client: they call
`evaluate()`, `canTransition()` and `writeBoard()` directly.

---

## The four-step handler

Every tool handler in `server.ts` does the same four things, in this order:

1. **Resolve.** Where is the project? Where is the board? Where is the
   repository? What is the policy? (`root.ts`)
2. **Ask.** Does the policy permit this operation? (`policy.ts`)
3. **Do.** Perform the work. (`git.ts`, `gh.ts`, `board.ts`)
4. **Answer.** Return the shared result shape.

The order matters. Step 2 comes before step 3 because **a refusal must
happen before the spawn**. A tool that ran the command and then noticed
it should not have run it has already done the damage.

Step 2 applies to the read tools too. A rule that says "reading the
board is allowed" is only worth having if a repository can tighten it,
and a tightened rule that the read tools ignore is a rule that is not
really enforced. Every tool asks the policy, and a refusal names the
rule that stopped it.

There are exactly two places where the order is deliberately broken, and
both are in `server.ts` with a comment saying why:

- **PR-11** (a path that escapes the repository) is checked in
  `git_commit` rather than in the policy, because the policy needs the
  path resolved against the repository root, and only the caller knows
  the root.
- **PR-19** (a squash merge) is refused before the policy is consulted,
  because there is no argv to build for it — the refusal *is* the
  answer.

---

## Three decisions worth explaining

### 1. The gate is a policy layer, not a prompt

The server is fully autonomous: write tools execute when called. The
thing that stands between a call and the outside world is a **declarative
rule table**, not a confirmation dialog.

A prompt gate asks the *user* whether the agent may act, which means the
user has to watch every call and understand what it means. A policy gate
is a table the user can read, edit and test: 53 rows, each naming an
operation, a verdict and a reason.

The distinction shows up in the vocabulary. The policy returns three
verdicts, not two:

| verdict | meaning |
|---|---|
| `allow` | go ahead |
| `deny` | no, and no amount of extra input will change that |
| `conditional` | not yet — here is the specific evidence that is missing |

`conditional` is the interesting one. It is the difference between "no"
and "not yet", and it is what makes the server usable without a human in
the loop: the refusal names the missing evidence, so the caller can
supply it and call again. A cancelled task needs a reason (PR-2). A
completed task needs a commit on its branch (PR-3). A delete needs a
confirmation (PR-37).

Every write tool also takes `dry_run`, so a caller can preview the exact
argv before anything happens. The preview is not a dry-run *mode* — the
tool computes the same argv it would run and returns it.

### 2. The git surface is a table of argv arrays, and there is never a shell

`git.ts` lists every git invocation the server can make, as literal argv
arrays, `G-01` through `G-57`. There is no pass-through `git` tool and
no way to run an arbitrary argv. The surface is fixed and it is visible:
you can read the table and know exactly what this server is capable of
doing to a repository.

The table is the **source of truth**, not a catalogue. Every builder
reads its argv from it, and a test fails if an entry is not reached by
a builder — so the table cannot drift away from what actually runs. A
builder that re-declared its argv as a literal would let the two
diverge, and the table would stop describing the server's real
capability. Placeholders (`<base>..<head>`, `<message>`) are filled in
by `fillArgv`, so a shape is written down once.

Every value is a separate element of the argv array. `spawnSync` is
called with `shell: false`. A branch named `; rm -rf ~` is a branch name
that fails validation — it is never a command.

The environment is pinned too (`gitEnv()`): `GIT_TERMINAL_PROMPT=0` so
git can never stop and ask for a credential and hang the server,
`GIT_EDITOR=true` so it can never open an editor, `GIT_CONFIG_NOSYSTEM=1`
so the server's behaviour does not depend on machine-wide settings, and
`LC_ALL=C` so output parses byte-for-byte regardless of the locale.

The tests assert the *absence* of the dangerous invocations as well as
the presence of the safe ones. A table that only lists what is allowed
does not tell you what a later edit added.

### 3. The board is a file, and it is shared state

The board is one JSON file, `<project>/.orchestrator/board.json`. It is
the project's shared state, and two agents writing it at once is the
normal case rather than the edge case. So the write path has four
properties, and each has a test:

- **A write is atomic.** The board is written to a temporary file and
  then renamed. A reader never sees half a board.
- **Writes are serialized.** A writer takes an exclusive lock on the
  board before it touches it. Without the lock, the conflict check and
  the rename are two steps, and two writers can both pass the check
  before either renames — so the second one silently discards the first
  one's work. The lock is a file created with `O_EXCL`, which is atomic:
  exactly one writer creates it, and the rest are told it is held.
- **A write against a board that changed underneath is refused.** Each
  write passes the SHA-256 of the content it was based on. If the file on
  disk no longer matches, the write is refused and the other writer's
  work is left intact.
- **A board that breaks an invariant is never written at all.** The
  invariants are checked before the write, and a violation is reported
  rather than persisted.

The temporary file's name carries the writer's pid and a uuid, so two
writers never share one and interleave their writes into it.

There is no database. A JSON file next to the repository can be read,
diffed, edited by hand and committed — which is what a project board
usually wants to be.

---

## The policy layer

`policy-rules.ts` holds the table. `policy.ts` holds the evaluation.

Each rule names an **operation** (`git.push`, `task.complete`), a
**verdict**, a **reason**, and optionally an **evidence** field (what
would satisfy a conditional) and an **appliesWhen** (the situation a
deny refuses).

`appliesWhen` is what distinguishes two kinds of refusal:

- **Unconditional** — PR-27 refuses adding a remote, always. There is no
  input that makes adding a remote acceptable.
- **Situational** — PR-16 refuses pushing to a *protected branch*. A push
  to a feature branch is fine.

Without `appliesWhen`, a situational deny would refuse everything, and a
table with 53 rows where 10 refuse everything is a table nobody reads.

### Evaluation is by precedence, not by table order

`evaluate()` runs three passes over the rules that apply to an operation:

1. **Any applicable `deny` wins.** The first one in table order is
   reported.
2. **Any unsatisfied `conditional` holds.** Again, the first in table
   order.
3. **Otherwise `allow`** — or `conditional` with `satisfied: true` if a
   conditional applied and its evidence was present.

This is not incidental. The obvious implementation — stop at the first
rule whose operation matches — is wrong: it lets a satisfied conditional
mask a deny that comes later in the table. PR-15 (a push needs a
branch) is satisfied for a push to `main`; PR-16 (never push to a
protected branch) is a deny. Under first-match, the push is allowed.
Under precedence, it is refused.

An operation with no rule at all is refused with `PR-0`. A surface that
is not in the table is not an implicit yes.

### The policy file can only tighten

A repository may ship a `policy.json` that overrides rules. It may turn
an `allow` into a `deny`. It may **not** loosen a built-in `deny` or
`conditional` into an `allow` (`maySetVerdict` refuses it).

The reasoning: the built-in rules are the server's safety floor, and a
file inside a repository is not a more trustworthy place to relax them
than the server itself. If a project wants a different floor, it
changes the server's table — which is a reviewed change — not a JSON file
that arrives with a clone.

---

## The state machine

`states.ts` holds an explicit row for every `(from, to)` pair of the
seven states: 43 rows, each with a rule id (`ST-1` … `ST-29`) and a
reason. Every row is exercised by a test.

Three kinds of row:

- **allowed** — the transition happens.
- **gated** — the transition needs evidence, named by a policy rule. A
  cancellation needs a reason (PR-2); a completion needs a commit
  (PR-3).
- **refused** — the transition does not exist. `todo -> done` is
  `ST-9`; `backlog -> in_progress` is `ST-3`.

A transition that is not in the table at all is refused with `ST-0`.

Dependencies are enforced separately: a task with an unfinished blocker
may not enter `in_progress`. The state machine says the move is legal;
the dependency check says the board is not ready for it.

---

## The board invariants

Eleven invariants, checked on every read and every write:

| id | invariant |
|---|---|
| INV-1 | `schema_version` is 1 |
| INV-2 | every task id matches `T-\d+` |
| INV-3 | no duplicate task ids |
| INV-4 | no dangling `blocked_by` |
| INV-5 | no task blocks itself |
| INV-6 | no dependency cycles |
| INV-7 | every state is one of the seven |
| INV-8 | every `parent` names a task that exists |
| INV-9 | no task is its own parent |
| INV-10 | no hierarchy cycles |
| INV-11 | no task holds the same lock twice |

A board that breaks one of these is an error on read *and* is never
written. The file on disk is left alone.

INV-8 has a consequence worth stating: **deleting a parent with children
fails**, with an invariant error rather than an orphan. Containment means
exactly that, and the alternative — a child whose parent has vanished —
is a board nobody can reason about.

There is also a rule that is not an invariant but behaves like one: **task
ids are never reused**. A deleted task leaves no trace in `tasks`, so the
board keeps a `retired_ids` list. Without it the allocator would hand the
next task the deleted task's id, and a stale reference to the deleted
task would silently resolve to a different one.

---

## Tool descriptions are scope statements

Every tool description states what the tool covers **and what it does
not**: "Not covered by `task_update`, which does not change state."

They never contain a directive. "Use `X` instead" tells the model what to
do, which competes with the model's own judgement about the task at
hand. "The message must match the convention" is different — it states a
constraint the tool enforces, which is a fact about the tool, not an
instruction to the reader.

There is a test that enforces this. It matches the imperative forms
(`use ... instead`, `you must`, `always call`, `prefer ...ing`) and
leaves constraint statements alone.

---

## The three environments

`root.ts` resolves where the server is working, in this order:

1. an explicit `project` argument on the tool call;
2. `ORCHESTRATOR_ROOT`;
3. the directory containing `ORCHESTRATOR_BOARD`;
4. the git repository root;
5. the current working directory.

From that root it derives the board path (`<root>/.orchestrator/board.json`)
and the policy path (`<root>/.orchestrator/policy.json`). `ORCHESTRATOR_BOARD`
and `ORCHESTRATOR_POLICY` override either.

The repository root is found by walking up at most four levels, so a
server started in a subdirectory still finds the project.

---

## Where the boundaries are

| the server does | the server does not |
|---|---|
| run git and gh from a fixed table | run an arbitrary command |
| write the board atomically | write anywhere else |
| open a pull request | merge, close, review or comment on one |
| report a refusal with a rule id | ask the user for permission |
| verify a caller's claim about itself | verify a caller's *identity* |

That last row is the honest boundary. The server is stdio — one
process, one client connection, one principal — so the `agent` on a
claim and the `actor` on a note are labels the caller supplies and the
server records. It cannot check them, and it does not pretend to. What
the claim mechanism prevents is two agents colliding *by accident*,
which is the case it exists for; it is not authentication.

`open_pr` is the only tool that touches the network, and it is marked
`openWorldHint: true`. Everything else is local — and "local" is the
boundary that matters: the forge is the one place where a mistake
reaches other people.

`git_combine` and `git_worktree` are local too, but they do change the
repository: `git_combine` writes a dangling tree object, and
`git_worktree` creates a directory. They are marked with the write and
destructive hints that say so.

---

## The three gates

Three checks stand between a tool call and the outside world, and they
are independent:

1. **The policy** — may this operation happen at all? (`PR-*`)
2. **The state machine** — is this transition legal? (`ST-*`)
3. **The board invariants** — is the result a valid board? (`INV-*`)

A refusal at any one of them stops the operation, and the refusal names
the rule that stopped it. The caller always learns *which* gate held and
*what was missing*.
