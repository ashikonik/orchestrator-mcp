# The policy

The policy is the gate between a tool call and the outside world. It is
a table of 53 rules, each naming an operation, a verdict, and the reason
for that verdict. This document explains how the table works, what every
rule does, and how a repository may change it.

---

## The three verdicts

| verdict | meaning | what the caller gets |
|---|---|---|
| `allow` | go ahead | the result |
| `deny` | no | `denied: true`, the rule id, the reason, a hint |
| `conditional` | not yet | `gated: true`, the rule id, the missing evidence, a hint |

`conditional` is what makes the server usable without a human in the
loop. It is the difference between "no" and "not yet", and it always
names the specific thing that is missing, so the caller can supply it and
call again.

A `conditional` whose evidence is present is still reported as
`conditional` with `satisfied: true` — the operation proceeds, but the
caller can see which gate it satisfied.

---

## How a decision is made

`evaluate(operation, context, policy)` runs three passes over the rules
that apply to the operation:

1. **Any applicable `deny` wins.** The first in table order is reported.
2. **Any unsatisfied `conditional` holds.** The first in table order.
3. **Otherwise `allow`** — or `conditional` with `satisfied: true` if a
   conditional applied and its evidence was present.

### Why precedence, and not table order

The obvious implementation is to stop at the first rule whose operation
matches. That is wrong.

PR-15 says a push needs a branch. PR-16 says never push to a protected
branch. A push to `main` has a branch, so PR-15 is satisfied. Under
first-match, the satisfied PR-15 masks the PR-16 deny and the push is
allowed — which is exactly the thing the rule exists to prevent.

Under precedence, the deny wins, and the refusal names PR-16.

### An operation with no rule is refused

An operation that is not in the table is refused with `PR-0`. A surface
that is not in the table is not an implicit yes.

---

## Two kinds of refusal

Some refusals are unconditional. Some refuse a *situation*.

PR-27 refuses adding a remote, always — no input makes it acceptable.
PR-16 refuses pushing to a **protected branch** — a push to a feature
branch is fine.

The `appliesWhen` column records which kind a rule is. Without it, a
situational deny would refuse everything, and a table where ten rules
refuse everything is a table nobody reads.

---

## The table

| id | operation | verdict | applies when | evidence | reason |
|---|---|---|---|---|---|
| PR-1 | `board.read` | allow | — | — | Reading the board changes nothing. |
| PR-2 | `task.cancel` | conditional | — | reason | Cancelling a task requires a reason, so the board records why it was dropped. |
| PR-3 | `task.complete` | conditional | — | commit_present | Completing a task requires a commit on its branch, so "done" means the work landed. |
| PR-4 | `board.write` | allow | — | — | Writing the board is the server's purpose. |
| PR-5 | `git.status` | allow | — | — | Reading the repository status changes nothing. |
| PR-6 | `git.diff` | allow | — | — | Reading a diff changes nothing. |
| PR-7 | `git.log` | allow | — | — | Reading the commit history changes nothing. |
| PR-8 | `git.status` | deny | not in a repository | — | The path is not inside a git repository. |
| PR-9 | `git.commit.message` | conditional | — | message | A commit message must follow the repository's convention. |
| PR-10 | `git.commit` | conditional | — | include_untracked | Adding untracked files to a commit must be asked for explicitly. |
| PR-11 | `git.commit` | deny | path escapes the repo | — | The path escapes the repository root. |
| PR-12 | `git.branch.create` | allow | — | — | Creating and listing branches is ordinary development work. |
| PR-13 | `git.branch.delete` | conditional | — | force | Deleting a branch discards its commits, so it must be merged or forced. |
| PR-14 | `git.checkout` | conditional | — | discard | Switching branches with a dirty tree can lose work, so the tree must be clean or the discard explicit. |
| PR-15 | `git.push` | conditional | — | branch | A push needs a branch that is not protected, and a configured remote. |
| PR-16 | `git.push` | deny | protected branch | — | Pushing to a protected branch is refused. |
| PR-17 | `git.push` | deny | force push | — | Force-pushing is refused: it can destroy commits that exist nowhere else. |
| PR-18 | `git.merge` | conditional | — | source | A merge needs a source and one of the permitted strategies. |
| PR-19 | `git.merge` | deny | squash merge | — | Squash merges are refused: they discard the individual commits. |
| PR-20 | `git.reset` | conditional | — | mode | A reset must name one of the permitted modes. |
| PR-21 | `git.reset` | conditional | — | confirm | A hard reset discards uncommitted work irreversibly. |
| PR-22 | `git.revert` | allow | — | — | Reverting is the safe way to undo a commit: it adds a new one. |
| PR-23 | `git.stash` | allow | — | — | Stashing preserves work rather than discarding it. |
| PR-24 | `git.stash` | conditional | — | confirm | Dropping a stash discards it irreversibly. |
| PR-25 | `git.tag.create` | allow | — | — | Creating and listing tags is ordinary. |
| PR-26 | `git.tag.delete` | conditional | — | confirm | Deleting a tag discards a named point in history. |
| PR-27 | `git.remote.add` | deny | always | — | Adding a remote is refused: it can point the repository at somewhere unexpected. |
| PR-28 | `git.remote.set-url` | deny | always | — | Changing a remote URL is refused: it can redirect a push. |
| PR-29 | `git.fetch` | allow | — | — | Fetching only reads from the remote. |
| PR-30 | `git.pull` | conditional | — | discard | A pull with a dirty tree can conflict with the working changes. |
| PR-31 | `git.hook.install` | deny | always | — | Installing git hooks is refused: a hook runs arbitrary code on every commit. |
| PR-32 | `git.config.set` | deny | always | — | Writing git config is refused: it can redirect remotes or change hooks globally. |
| PR-33 | `git.gc` | deny | always | — | Destructive maintenance is refused: it removes objects that may be the only copy of a commit. |
| PR-34 | `task.create` | allow | — | — | Creating a task is the ordinary way to record work. |
| PR-35 | `task.update` | allow | — | — | Updating a task's fields is ordinary. |
| PR-36 | `task.move` | allow | — | — | Moving a task is governed by the task state machine, not by the policy. |
| PR-37 | `task.delete` | conditional | — | confirm | Deleting a task is destructive and needs an explicit confirmation. |
| PR-38 | `task.list` | allow | — | — | Listing tasks changes nothing. |
| PR-39 | `task.get` | allow | — | — | Reading one task changes nothing. |
| PR-40 | `policy.get` | allow | — | — | Reading the policy changes nothing. |
| PR-41 | `policy.set` | conditional | — | confirm | Writing the policy needs an explicit confirmation, and a repository may only tighten it. |
| PR-42 | `gh.pr.create` | conditional | — | branch_protected | A pull request must come from a branch that is not protected. |
| PR-43 | `gh.pr.create` | deny | a pull request exists | — | A pull request already exists for this branch. |
| PR-44 | `plan.from_commits` | allow | — | — | Reading commits to propose tasks changes nothing. |
| PR-45 | `plan.create_tasks` | conditional | — | create_tasks | Creating tasks from commits must be asked for explicitly. |
| PR-46 | `git.remote.list` | allow | — | — | Listing and showing remotes only reads the configuration. |
| PR-47 | `git.branch.list` | allow | — | — | Listing the branches changes nothing. |
| PR-48 | `task.claim` | conditional | — | claimable | Claiming a task requires that it is unblocked and not already claimed, so two agents do not work on the same task. |
| PR-49 | `git.cherry-pick` | conditional | — | commit,tree_clean | A cherry-pick must name a commit, and the tree must be clean before it applies. |
| PR-50 | `task.next` | allow | — | — | Choosing the next task reads the board and changes nothing. |
| PR-51 | `task.note` | allow | — | — | A note records what someone said; it does not change the task's state. |
| PR-52 | `git.combine` | conditional | — | branches | Combining branches needs at least two of them, so a single branch is not a combination and the result would be meaningless. |
| PR-53 | `git.worktree` | conditional | — | confirm | Removing a worktree discards its uncommitted work, so it needs an explicit confirmation. |

---

## The rules worth explaining

### PR-3 — a completion needs a commit

Moving a task to `done` is gated on the task's branch having a commit the
base branch does not. The check is `git log base..branch` — not empty.

The evidence is checked against the task's **branch**, not against
whatever is currently checked out. A task with no branch recorded has no
commit to find, so the completion holds and says so.

### PR-9 and PR-10 — two gates on one commit

PR-9 requires the message to match the convention. PR-10 requires
`include_untracked` to be explicitly `true`.

They are independent, so satisfying one leaves the other holding. A
commit with a good message but `include_untracked: false` is gated on
PR-10, not PR-9 — the caller learns exactly what is missing.

PR-9 lives on its own operation, `git.commit.message`, separate from
PR-10's `git.commit`. That split is deliberate. PR-10's evidence *is*
`include_untracked`, so evaluating it unconditionally would hold every
ordinary commit — the ones that stage nothing new. Keeping the message
check on a separate scope means each rule is evaluated on its own terms:
`git.commit.message` is checked always, and `git.commit` only when the
caller asks to include untracked files.

The default pattern is
`^(feat|fix|docs|refactor|test|chore|build|ci)(\(.+\))?: .+`, overridable
by the policy file.

### PR-48 — a claim needs a claimable task

A claim says an agent is working on a task, until a lease runs out. The
evidence is `claimable`, which the server computes: the task is not
blocked, and it is not held by somebody else.

The refusal names the blocker. A claim on a task blocked by `T-003`
answers with `T-003`, so the caller knows what to unblock rather than
just being told no.

The agent is a **label the caller supplies**, not a verified identity.
The server records what it was told; it has no way to check. The claim
prevents two agents from working on the same task *by accident*, which
is the case it is for. It is not an access control.

### PR-49 — a cherry-pick needs a commit and a clean tree

Both pieces of evidence are needed, so the rule names both:
`commit,tree_clean`.

The clean-tree half is the interesting one. A cherry-pick onto a dirty
tree can leave the changes half-applied and the index in a state
nobody planned for. The check is against git, so the server computes it
and puts the answer in the context.

### PR-52 — a combination needs two branches

`git_combine` checks whether branches can be merged together without
merging them. A single branch is not a combination, so the rule holds
until a second one is named.

### PR-53 — only a worktree *removal* needs confirmation

Adding a worktree and listing the worktrees are ordinary. Removing one
discards whatever was uncommitted in it, so it is held until confirmed.

The action travels in the policy context, exactly as PR-24's does for a
stash drop — so one rule covers both the destructive action and the
ordinary ones.

### PR-13 — a branch must be merged, or forced

Deleting a branch discards its commits. The branch is measured as merged
against the **base branch**, not against HEAD.

This detail matters: `git branch --merged` with no argument lists the
branches reachable from HEAD, and a branch is always reachable from
itself. Measuring against HEAD would report every branch as merged, and
the guard would never fire. The server runs `git branch --merged <base>`.

### PR-15 and PR-16 — the branch and the protection

PR-15 is the conditional: a push needs a branch and a remote. PR-16 is
the deny: that branch must not be protected. Protected branches default
to `main`, `master` and `release/*`, overridable by the policy file.

### PR-24 — only a *drop* needs confirmation

PR-23 allows stashing. PR-24 holds a drop. The action travels in the
policy context, so a stash push or a stash list needs no confirmation
and a stash drop does.

### PR-42 and PR-43 — the two pull-request rules

PR-42 is a conditional on the branch not being protected. PR-43 is a
deny that fires when a pull request already exists for the branch — and
that one is checked by the tool against the forge, not by the policy,
because only the tool can ask the forge.

### PR-44 and PR-45 — two operations, because two acts

Proposing tasks reads commits and writes nothing, so it is allowed.
Creating tasks writes to the board, so it is gated on `create_tasks`
being explicitly `true`.

They are separate operations rather than one operation with two rules,
because they are genuinely different acts.

---

## Every conditional rule can be satisfied

A conditional rule whose evidence is never recognised is *permanently*
unsatisfiable: it holds forever, and no caller can get past it. The
operation is switched off, and the refusal names a rule that cannot be
passed.

The evaluator's `evidencePresent` returns `false` for any rule it has
no case for. That is the right default — an unrecognised rule is not
silently permitted — but it makes a missing case invisible to a
refusal-path test. A rule that always holds also always refuses, so
"the push was denied" passes whether or not the push could ever have
been allowed.

So the test suite asks the other question too. For every operation with
a conditional rule, it builds a context that carries the evidence and
asserts the evaluation comes back satisfied. It also removes each rule's
evidence in turn and asserts that the rule is the one that holds — so a
rule cannot be masked by a neighbour.

This is not academic. PR-15 (push) and PR-18 (merge) both lacked a case
for a long while, and every push and every merge was held, with no way
past. The refusal-path tests all passed.

---

## The policy file

A repository may ship `<root>/.orchestrator/policy.json`:

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

`ORCHESTRATOR_POLICY` overrides the path.

A missing file is not an error — the built-in defaults apply, and
`policy_get` reports `source: "default"`.

### A policy file may only tighten

`deny` may list rule ids to turn into `deny`. It may **not** loosen a
built-in `deny` or `conditional` into an `allow`; `maySetVerdict` refuses
that, and `policy_set` reports the refusal.

The reasoning: the built-in rules are the server's safety floor, and a
file inside a repository is not a more trustworthy place to relax them
than the server itself. A project that wants a different floor changes
the server's table — a reviewed change — not a JSON file that arrives
with a clone.

### A tightened rule stops the tool, read or write

Every tool asks the policy, including the read-only ones. A rule that
says "reading the board is allowed" is only worth having if a repository
can tighten it — and a tightened rule that the read tools ignore is a
rule that is not really enforced.

So `"deny": ["PR-1"]` stops `board_get`, and `"deny": ["PR-5"]` stops
`git_status`. The refusal names the rule that stopped it:

```json
{
  "applied": false,
  "denied": true,
  "rule": "PR-5",
  "operation": "git.status",
  "reason": "Reading the repository status changes nothing."
}
```

### A broken policy file is an error

A malformed file, or one naming an unknown rule id, is an error rather
than a silent fallback to the defaults. A policy that quietly fails to
load is a policy nobody is enforcing.

A broken policy file stops the *write* tools. The read-only tools keep
working, and `policy_get` reports the error.

---

## Reading the policy

`policy_get` returns every rule with its effective verdict, the reason,
the evidence field, and whether a file overrode it:

```json
{
  "policy_path": "/repo/.orchestrator/policy.json",
  "source": "file",
  "overrides": ["PR-1"],
  "rules": [
    {
      "id": "PR-16",
      "operation": "git.push",
      "verdict": "deny",
      "reason": "Pushing to a protected branch is refused.",
      "evidence": null,
      "hint": null,
      "overridden": false
    }
  ]
}
```

`source` is `"default"` when no file was found, `"file"` when one was
loaded.

---

## Changing the policy

`policy_set` changes a rule's verdict at runtime. It is gated on
`confirm` (PR-41) and it cannot loosen a built-in rule. Its refusals
name the rule that stopped them.
