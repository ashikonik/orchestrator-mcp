# Tool reference

Twenty-two tools. Ten read, twelve write. Every write tool executes when
called and takes `dry_run` to preview; no write tool asks for permission.

Every tool accepts an optional `project` — the path to the project
directory. When it is omitted the server resolves the project from its
environment (see `docs/REGISTERING.md`).

---

## The result shape

Every tool returns JSON as text, and the same fields mean the same thing
everywhere:

| field | meaning |
|---|---|
| `applied` | the operation ran and changed something |
| `dry_run` | this was a preview; nothing happened |
| `denied` | the policy refused it; see `rule` and `reason` |
| `gated` | a conditional held; see `gate` and `reason` |
| `refused` | the state machine or an invariant refused it; see `rule` |
| `rule` | the rule id that decided it (`PR-*`, `ST-*`, `INV-*`) |
| `hint` | what would satisfy a held rule |

A refusal is never an exception and never an empty result. It is a
normal response that names the rule that stopped it.

---

## The board

### `board_get`

Reads the whole board: every task, its state, its dependencies and its
history.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |

**Returns** `board_path`, `board_exists`, `schema_version`, `updated_at`,
`task_count`, `tasks`.

Not covered by `task_list`, which filters and paginates.

### `board_set`

Replaces the board wholesale. Every task in the supplied board must
satisfy the invariants, and the board is checked before it is written.

| argument | type | default |
|---|---|---|
| `board` | object | required |
| `dry_run` | boolean | `false` |

**Returns** `board_path`, `tasks_written`, `written`, `violations`.

**Destructive.** This is the one tool that can replace work that is
already there. `task_create`, `task_update` and `task_move` change one
task at a time and are the normal way to work.

### `task_list`

Lists task summaries matching a filter.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `state` | string | — (comma-separated states) |
| `label` | string | — |
| `assignee` | string | — |
| `query` | string | — (matches title, body and id) |
| `limit` | number | `50` |
| `offset` | number | `0` |

**Returns** `tasks`, `total_matched`, `returned`, `offset`, `truncated`.

Not covered by `board_get`, which returns the whole board including
history.

### `task_get`

One task in full, with its history and its blockers.

| argument | type | default |
|---|---|---|
| `id` | string | required |
| `project` | string | resolved |

**Returns** the task's fields plus `blocking_tasks`.

Not covered by `task_list`, which returns summaries.

### `task_create`

Creates one task. The id is allocated by the server unless one is given.

| argument | type | default |
|---|---|---|
| `title` | string | required |
| `body` | string | `""` |
| `state` | enum | `"todo"` |
| `labels` | string[] | `[]` |
| `assignee` | string \| null | `null` |
| `blocked_by` | string[] | `[]` |
| `branch` | string \| null | `null` |
| `parent` | string \| null | `null` |
| `priority` | number | unset |
| `locks` | string[] | `[]` |
| `id` | string | allocated |
| `idempotency_key` | string | — |
| `project` | string | resolved |
| `dry_run` | boolean | `false` |

**Returns** `id`, `created`, `task`, `board_path`.

`idempotency_key` makes a retry safe: the same key always names the same
task, so a retry creates nothing new and returns the task that key
made. See `docs/BOARD_FORMAT.md`.

Not covered by `board_set`, which replaces the whole board.

### `task_update`

Updates the editable fields of one task. It does **not** change the
state.

| argument | type | default |
|---|---|---|
| `id` | string | required |
| `title` | string | — |
| `body` | string | — |
| `labels` | string[] | — |
| `assignee` | string \| null | — |
| `blocked_by` | string[] | — |
| `branch` | string \| null | — |
| `parent` | string \| null | — |
| `priority` | number | — |
| `locks` | string[] | — |
| `project` | string | resolved |
| `dry_run` | boolean | `false` |

**Returns** `id`, `updated` (the field names that changed), `task`.

An update that changes nothing returns `applied: false` with
`updated: []` and a note.

Not covered by `task_move`, which changes the state.

### `task_move`

Moves one task to a new state. The transition must be permitted by the
state machine.

| argument | type | default |
|---|---|---|
| `id` | string | required |
| `to` | enum | required |
| `reason` | string | `""` |
| `note` | string | `""` |
| `actor` | string | `"orchestrator"` |
| `project` | string | resolved |
| `dry_run` | boolean | `false` |

**Returns** `id`, `from`, `to`, `task`, `board_path`.

Three things can stop a move, and each says which:

- the **state machine** — `refused: true` and a `ST-*` rule. `todo ->
  done` is `ST-9`.
- a **dependency** — `refused: true` and `rule: "ST-DEP"`, with
  `blocking_tasks` naming what is unfinished.
- the **policy** — `gated: true` and a `PR-*` rule. A cancellation needs
  a reason (PR-2); a completion needs a commit on the task's branch
  (PR-3).

Not covered by `task_update`, which does not change state.

### `task_delete`

Deletes one task. A task in the `done` state cannot be deleted — its
history is the record that it was finished.

| argument | type | default |
|---|---|---|
| `id` | string | required |
| `confirm` | boolean | `false` |
| `project` | string | resolved |
| `dry_run` | boolean | `false` |

**Returns** `id`, `deleted`, `status`.

**Destructive.** Gated on `confirm` (PR-37).

The id is retired, not reused: the next task will not be given it.

Not covered by `task_move`, which changes a task's state.

### `task_next`

The next task to work on: a ranked, deterministic choice.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |

**Returns** `next` (the chosen task), `tasks` (the ranked list),
`considered`, `eligible`, `returned`.

The ranking is: `priority` descending, then most recently `updated`
first, then id. The order is fixed, so the same board always gives the
same answer.

A task is **not** eligible when it is `done` or `cancelled`, when it is
blocked (its `blocked_by` tasks are not all `done`), or when another
agent holds a live claim on it.

Most-recently-worked first, not oldest-first: a task that has sat in
`todo` for months should not outrank one created this morning. The
clock has second resolution, so tasks updated in the same second tie and
fall through to the id — a deliberate tiebreak, not an accident.

Not covered by `task_list`, which filters and paginates but does not
rank and does not exclude blocked work.

### `task_claim`

Claims a task for an agent, releases a claim, or renews a lease.

| argument | type | default |
|---|---|---|
| `id` | string | required |
| `action` | enum: `claim` \| `release` \| `heartbeat` | `"claim"` |
| `agent` | string | `"orchestrator"` |
| `lease_seconds` | number | `900` |
| `idempotency_key` | string | — |
| `project` | string | resolved |
| `dry_run` | boolean | `false` |

**Returns** `id`, `claimed`, `released`, `claim` (the lease), `task`.

A claim is refused when the task is blocked, when somebody else holds a
live claim, or when another task's `locks` overlap this task's — and the
refusal **names the holder**.

The `agent` is a label the caller supplies. The server records it; it
cannot verify it. See `docs/BOARD_FORMAT.md`.

A claim appends a history entry, so the lease has a trail visible in
`task_get`.

**PR-48** holds the claim unless the task is claimable.

Not covered by `task_update`, which changes a task's fields but not its
claim.

### `task_note`

Appends a note to a task. Notes are append-only: there is no edit and
no delete.

| argument | type | default |
|---|---|---|
| `id` | string | required |
| `text` | string | `""` |
| `actor` | string | `"orchestrator"` |
| `idempotency_key` | string | — |
| `project` | string | resolved |
| `dry_run` | boolean | `false` |

**Returns** `id`, `notes_added`, `note`, `notes`, `task`.

A note records something someone said. It is not a state change, and it
does not move the task: `history` records transitions, `notes` records
discussion.

With an `idempotency_key`, a retry appends no second note — it finds
the one that key made and returns it.

Not covered by `task_update`, which changes fields rather than appending
to a discussion.

---

## The repository

### `git_status`

The working tree status: staged, unstaged and untracked paths, the
current branch, the upstream, and how far ahead or behind it is.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `porcelain` | boolean | `false` (raw porcelain output) |

**Returns** `repo_root`, `branch`, `upstream`, `ahead`, `behind`, `clean`,
`staged`, `unstaged`, `untracked`, `raw`.

Not covered by `git_diff`, which reports content differences.

### `git_diff`

Content differences: the working tree against the index, the index
against HEAD, two commits against each other, or one path.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `staged` | boolean | `false` |
| `base` | string | — |
| `head` | string | — |
| `path` | string | — |
| `stat` | boolean | `false` |

**Returns** `mode`, `argv`, `files_changed`, `diff`, `stat`, `truncated`.

Not covered by `git_status`, which reports which paths changed but not
how.

### `git_log`

The commit history, optionally scoped to a path, a branch, a date range
or a grep.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `branch` | string | — |
| `path` | string | — |
| `limit` | number | `20` |
| `since` | string | — |
| `until` | string | — |
| `grep` | string | — |

**Returns** `branch`, `total`, `commits` (hash, short hash, subject,
author, date).

Not covered by `git_diff`, which reports differences between two points.

### `git_commit`

Commits the staged changes, or the named paths.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `message` | string | required |
| `paths` | string[] | `[]` (commits everything staged) |
| `include_untracked` | boolean | `false` |
| `dry_run` | boolean | `false` |

**Returns** `commit_hash`, `argv`, `staged_files`, `status`.

Two gates apply:

- **PR-9** (`git.commit.message`) — the message must match the
  convention. The default is
  `^(feat|fix|docs|refactor|test|chore|build|ci)(\(.+\))?: .+`.
- **PR-10** (`git.commit`) — `include_untracked` must be explicitly
  `true`. Adding untracked files is a separate `git add`, and it is the
  step that can pick up a file nobody meant to commit.

They are independent, so a good message with `include_untracked: false`
is gated on PR-10 and says so. PR-9 lives on its own operation scope so
that it is checked on every commit, while PR-10 — whose evidence *is*
`include_untracked` — is only checked when the caller asks for it.

**PR-11** refuses a path that escapes the repository root.

Not covered by `git_diff`, which reports what changed but records
nothing.

### `git_operate`

Runs one git operation from the fixed command surface. The operation is
named explicitly, and each one maps to exactly one argv array.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `operation` | enum | required |
| `args` | object | `{}` |
| `confirm` | boolean | `false` |
| `discard` | boolean | `false` |
| `force` | boolean | `false` |
| `dry_run` | boolean | `false` |

**Returns** `argv`, `status`, `stdout`, `stderr`, `exit_code`.

The eight operations and their arguments:

| operation | `args` | notes |
|---|---|---|
| `branch` | `action`: `create` \| `delete` \| `list` \| `checkout`; `name`; `from` | PR-13 holds a delete of an unmerged branch |
| `push` | `branch`; `remote`; `set_upstream` | PR-16 refuses a protected branch; PR-17 refuses a force push |
| `merge` | `source`; `strategy`: `merge` \| `rebase` | PR-19 refuses a squash merge |
| `stash` | `action`: `push` \| `pop` \| `list` \| `drop`; `message` | PR-24 holds a *drop* until confirmed |
| `reset` | `mode`: `soft` \| `mixed` \| `hard`; `target` | PR-21 holds a hard reset until confirmed |
| `revert` | `commit`; `no_commit` | always allowed — revert adds a commit rather than removing one |
| `tag` | `action`: `create` \| `delete` \| `list`; `name`; `message` | PR-26 holds a delete until confirmed |
| `remote` | `action`: `add` \| `set-url` \| `fetch` \| `pull` \| `list` \| `show`; `name` | PR-27 and PR-28 refuse adding a remote or changing its URL |
| `cherry-pick` | `commit` | PR-49 holds it unless a commit is named and the tree is clean |

An `args` key the operation does not accept is refused with a named
error, rather than ignored. That matters where a typo chooses a path:
`git worktree add` with no path would create the worktree inside the
current directory.

**Destructive.** The operation is checked by the policy *before* the
command runs, so a refusal happens before the spawn.

Not covered by `git_status`, `git_diff`, `git_log` or `git_commit`, which
cover the read operations and committing.

### `git_combine`

Checks whether two or more branches can be merged together — without
merging them, and without touching the working tree.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `branches` | string[] | required (at least two) |
| `base` | string | the current branch |

**Returns** `base`, `branches`, `combined`, `conflicts` (the
conflicting paths), `steps` (one per merge, with its argv).

The branches are combined **in the order given**: the first is merged
into the base, the second into the result, and so on. The order is
reported, because it matters — merges are not associative.

Implemented with `git merge-tree --write-tree`, which performs a merge
without touching the index or the working tree. It writes a dangling
tree object and nothing else; `git gc` collects it. Requires git 2.38
or newer.

**PR-52** holds it until at least two branches are named.

Not covered by `git_operate merge`, which merges into the current
branch and changes the repository.

### `git_worktree`

Manages the repository's worktrees: adding one for a branch, listing
them, removing one, or pruning the ones whose directories are gone.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `action` | enum: `add` \| `list` \| `remove` \| `prune` | required |
| `path` | string | — (required for `add` and `remove`) |
| `branch` | string | — (required for `add`) |
| `confirm` | boolean | `false` |
| `dry_run` | boolean | `false` |

**Returns** `action`, `worktrees`, `path`, `branch`.

**A path inside the main checkout is refused.** A worktree created
inside the repository shows up as untracked in the main checkout, and
`git_commit`'s `git add --all` would stage the whole worktree. The
refusal names the hazard.

**PR-53** holds a *removal* until it is confirmed. Adding and listing
are ordinary.

A worktree resolves its own root — `git rev-parse --show-toplevel`
returns the worktree's path — so a worktree inside the repository finds
the main checkout's board, and a worktree *beside* the repository does
not. `ORCHESTRATOR_BOARD` is the way to share one board across
worktrees.

Not covered by `git_operate branch`, which creates branches without a
second working directory.

### `open_pr`

Opens a pull request for the current branch using the `gh` CLI.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `title` | string | required |
| `body` | string | `""` |
| `base` | string | the repository default |
| `draft` | boolean | `false` |
| `dry_run` | boolean | `false` |

**Returns** `url`, `branch`, `base`, `argv`, `status`.

Two rules apply: PR-42 holds a pull request from a protected branch, and
PR-43 refuses one that already exists for the branch.

This is the **only tool that reaches the network**, and it is marked
`openWorldHint: true`. The surface can open a pull request; it cannot
merge, close, review or comment on one.

Not covered by `git_operate`, which covers the git command surface and
does not reach the forge.

### `plan_from_commits`

Reads recent commits on a branch and proposes board tasks derived from
them. It proposes by default and writes only when asked.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `branch` | string | the current branch |
| `base` | string | the repository default |
| `limit` | number | `20` |
| `create_tasks` | boolean | `false` |
| `labels` | string[] | `[]` |
| `dry_run` | boolean | `false` |

**Returns** `commits_read`, `proposed`, `created`, `board_path`.

Proposing is PR-44 and writes nothing. Creating is PR-45 and is gated
on `create_tasks` being explicitly `true`.

Not covered by `git_log`, which reports commits without turning them into
tasks.

---

## The policy

### `policy_get`

The effective policy: every rule with its verdict, the reason, the
evidence field, and whether a file overrode it.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |

**Returns** `rules` (53 of them), `policy_path`, `source`, `overrides`.

Not covered by `policy_set`, which changes a rule.

### `policy_set`

Writes the repository's policy file. A rule may only be **tightened** —
a built-in `deny` or `conditional` cannot be relaxed to `allow`.

| argument | type | default |
|---|---|---|
| `project` | string | resolved |
| `policy` | object | required |
| `confirm` | boolean | `false` |
| `dry_run` | boolean | `false` |

**Returns** `policy_path`, `written`, `denied_rules`.

A policy that would loosen a built-in rule is refused with
`refused: true`, `rule: "PR-41"` and `denied_rules` naming each rule it
tried to loosen.

Gated on `confirm` (PR-41). A refusal to loosen a built-in rule names
the rule that stopped it.

Not covered by `policy_get`, which reads the policy.

---

## The environment

| variable | meaning |
|---|---|
| `ORCHESTRATOR_ROOT` | the project directory |
| `ORCHESTRATOR_BOARD` | the board file, overriding the default path |
| `ORCHESTRATOR_POLICY` | the policy file, overriding the default path |
| `ORCHESTRATOR_DEFAULT_BRANCH` | the base branch, when the repository has no remote HEAD |

The resolution order is: the `project` argument, then
`ORCHESTRATOR_ROOT`, then the directory holding `ORCHESTRATOR_BOARD`,
then the git repository root, then the working directory.

---

## The tool surface has no passthrough

There is no tool that runs an arbitrary command. `git_operate` names one
of nine operations; each maps to exactly one argv array in `git.ts`.
`gh` has four argv arrays in `gh.ts`.

Every argv array in `git.ts` comes from one table — `GIT_ARGV` — and a
test fails if an entry in that table is not reached by a builder. So
the table is the description of what the server can actually run, not a
catalogue that can drift away from the code.

There is never a shell. Every value is a separate element of the argv
array, so a branch named `; rm -rf ~` is a branch name that fails
validation — never a command.
