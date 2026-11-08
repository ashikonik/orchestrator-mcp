/**
 * The policy rules, as data.
 *
 * Every rule the server can enforce is a row here: its id, the operation
 * it governs, its built-in verdict, the reason it exists, and the
 * evidence field that satisfies a conditional rule.
 *
 * The rules are data rather than code so that:
 *
 *  - `policy_get` can report the whole table without the server having to
 *    keep a second copy in sync;
 *  - a repository's `policy.json` can tighten a rule without a code
 *    change;
 *  - the tests can assert that every id is reachable.
 */
import type { PolicyVerdict } from './types.js';

export interface Rule {
  id: string;
  operation: string;
  verdict: PolicyVerdict;
  reason: string;
  /** The argument that satisfies a conditional rule. */
  evidence?: string;
  /**
   * For a `deny` rule: the context fact that makes the denial apply.
   *
   * Some refusals are unconditional -- a force push is always refused,
   * whatever the branch. Others are refusals of a *situation*: pushing
   * to a protected branch is refused, but pushing to a feature branch is
   * fine. Those rules carry the fact they test here, so a rule that
   * reads as "always deny" in the table does not deny every push.
   */
  appliesWhen?: string;
  /** What to tell the caller when the rule holds them up. */
  hint?: string;
}

/**
 * The built-in rules.
 *
 * The order is the order the rules are reported in `policy_get`, so it
 * groups them by what they govern: the board, tasks, git, then the forge.
 */
export const RULES: readonly Rule[] = [
  // --- the board ---------------------------------------------------------
  {
    id: 'PR-1',
    operation: 'board.read',
    verdict: 'allow',
    reason: 'Reading the board changes nothing.',
  },
  {
    id: 'PR-4',
    operation: 'board.write',
    verdict: 'allow',
    reason: 'Writing the board is the server\'s purpose.',
  },

  // --- tasks -------------------------------------------------------------
  {
    id: 'PR-2',
    operation: 'task.cancel',
    verdict: 'conditional',
    reason: 'Cancelling a task requires a reason, so the board records why it was dropped.',
    evidence: 'reason',
    hint: 'Pass a non-empty reason.',
  },
  {
    id: 'PR-3',
    operation: 'task.complete',
    verdict: 'conditional',
    reason: 'Completing a task requires a commit on its branch, so "done" means the work landed.',
    evidence: 'commit_present',
    hint: 'Commit the work on the task\'s branch first.',
  },
  {
    id: 'PR-34',
    operation: 'task.create',
    verdict: 'allow',
    reason: 'Creating a task is the ordinary way to record work.',
  },
  {
    id: 'PR-35',
    operation: 'task.update',
    verdict: 'allow',
    reason: 'Updating a task\'s fields is ordinary.',
  },
  {
    id: 'PR-36',
    operation: 'task.move',
    verdict: 'allow',
    reason: 'Moving a task is governed by the task state machine, not by the policy.',
  },
  {
    id: 'PR-37',
    operation: 'task.delete',
    verdict: 'conditional',
    reason: 'Deleting a task is destructive and needs an explicit confirmation.',
    evidence: 'confirm',
    hint: 'Pass confirm: true.',
  },
  {
    id: 'PR-38',
    operation: 'task.list',
    verdict: 'allow',
    reason: 'Listing tasks changes nothing.',
  },
  {
    id: 'PR-39',
    operation: 'task.get',
    verdict: 'allow',
    reason: 'Reading one task changes nothing.',
  },
  {
    id: 'PR-48',
    operation: 'task.claim',
    verdict: 'conditional',
    reason:
      'Claiming a task requires that it is unblocked and not already claimed, so two agents ' +
      'do not work on the same task.',
    evidence: 'claimable',
    hint: 'The task must be unblocked, and any existing claim must have lapsed or be released.',
  },
  {
    id: 'PR-50',
    operation: 'task.next',
    verdict: 'allow',
    reason: 'Choosing the next task reads the board and changes nothing.',
  },
  {
    id: 'PR-51',
    operation: 'task.note',
    verdict: 'allow',
    reason: 'A note records what someone said; it does not change the task\'s state.',
  },

  // --- git: reading ------------------------------------------------------
  {
    id: 'PR-5',
    operation: 'git.status',
    verdict: 'allow',
    reason: 'Reading the repository status changes nothing.',
  },
  {
    id: 'PR-6',
    operation: 'git.diff',
    verdict: 'allow',
    reason: 'Reading a diff changes nothing.',
  },
  {
    id: 'PR-7',
    operation: 'git.log',
    verdict: 'allow',
    reason: 'Reading the commit history changes nothing.',
  },
  {
    id: 'PR-8',
    operation: 'git.status',
    verdict: 'deny',
    reason: 'The path is not inside a git repository.',
    appliesWhen: 'not_in_repository',
    hint: 'Pass a project path that is a repository, or run the server from one.',
  },

  // --- git: committing ----------------------------------------------------
  {
    id: 'PR-9',
    operation: 'git.commit.message',
    verdict: 'conditional',
    reason: 'A commit message must follow the repository\'s convention.',
    evidence: 'message',
    hint: 'Use a message matching the repository\'s commit_message_pattern.',
  },
  {
    id: 'PR-10',
    operation: 'git.commit',
    verdict: 'conditional',
    reason: 'Adding untracked files to a commit must be asked for explicitly.',
    evidence: 'include_untracked',
    hint: 'Pass include_untracked: true.',
  },
  {
    id: 'PR-11',
    operation: 'git.commit',
    verdict: 'deny',
    reason: 'The path escapes the repository root.',
    appliesWhen: 'path_escapes_repo',
    hint: 'Use paths inside the repository.',
  },

  // --- git: branches ------------------------------------------------------
  {
    id: 'PR-12',
    operation: 'git.branch.create',
    verdict: 'allow',
    reason: 'Creating and listing branches is ordinary development work.',
  },
  {
    id: 'PR-47',
    operation: 'git.branch.list',
    verdict: 'allow',
    reason: 'Listing the branches changes nothing.',
  },
  {
    id: 'PR-13',
    operation: 'git.branch.delete',
    verdict: 'conditional',
    reason: 'Deleting a branch discards its commits, so it must be merged or forced.',
    evidence: 'force',
    hint: 'Merge the branch first, or pass force: true.',
  },
  {
    id: 'PR-14',
    operation: 'git.checkout',
    verdict: 'conditional',
    reason: 'Switching branches with a dirty tree can lose work, so the tree must be clean or the discard explicit.',
    evidence: 'discard',
    hint: 'Commit or stash the changes first, or pass discard: true.',
  },

  // --- git: pushing -------------------------------------------------------
  {
    id: 'PR-15',
    operation: 'git.push',
    verdict: 'conditional',
    reason: 'A push needs a branch that is not protected, and a configured remote.',
    evidence: 'branch',
    hint: 'Push a feature branch.',
  },
  {
    id: 'PR-16',
    operation: 'git.push',
    verdict: 'deny',
    reason: 'Pushing to a protected branch is refused.',
    appliesWhen: 'branch_protected',
    hint: 'Push a feature branch and open a pull request instead.',
  },
  {
    id: 'PR-17',
    operation: 'git.push',
    verdict: 'deny',
    reason: 'Force-pushing is refused: it can destroy commits that exist nowhere else.',
    appliesWhen: 'force_push',
    hint: 'Merge or rebase locally and push normally.',
  },

  // --- git: merging -------------------------------------------------------
  {
    id: 'PR-18',
    operation: 'git.merge',
    verdict: 'conditional',
    reason: 'A merge needs a source and one of the permitted strategies.',
    evidence: 'source',
    hint: 'Name the source branch and a strategy of merge or rebase.',
  },
  {
    id: 'PR-19',
    operation: 'git.merge',
    verdict: 'deny',
    reason: 'Squash merges are refused: they discard the individual commits.',
    appliesWhen: 'squash_merge',
    hint: 'Use merge or rebase.',
  },

  // --- git: history rewriting --------------------------------------------
  {
    id: 'PR-20',
    operation: 'git.reset',
    verdict: 'conditional',
    reason: 'A reset must name one of the permitted modes.',
    evidence: 'mode',
    hint: 'Use soft, mixed or hard.',
  },
  {
    id: 'PR-21',
    operation: 'git.reset',
    verdict: 'conditional',
    reason: 'A hard reset discards uncommitted work irreversibly.',
    evidence: 'confirm',
    hint: 'Pass confirm: true.',
  },
  {
    id: 'PR-22',
    operation: 'git.revert',
    verdict: 'allow',
    reason: 'Reverting is the safe way to undo a commit: it adds a new one.',
  },
  {
    id: 'PR-49',
    operation: 'git.cherry-pick',
    verdict: 'conditional',
    reason: 'A cherry-pick must name a commit, and the tree must be clean before it applies.',
    evidence: 'commit,tree_clean',
    hint: 'Commit or stash the changes first, then cherry-pick the commit.',
  },
  {
    id: 'PR-23',
    operation: 'git.stash',
    verdict: 'allow',
    reason: 'Stashing preserves work rather than discarding it.',
  },
  {
    id: 'PR-24',
    operation: 'git.stash',
    verdict: 'conditional',
    reason: 'Dropping a stash discards it irreversibly.',
    evidence: 'confirm',
    hint: 'Pass confirm: true.',
  },
  {
    id: 'PR-25',
    operation: 'git.tag.create',
    verdict: 'allow',
    reason: 'Creating and listing tags is ordinary.',
  },
  {
    id: 'PR-26',
    operation: 'git.tag.delete',
    verdict: 'conditional',
    reason: 'Deleting a tag discards a named point in history.',
    evidence: 'confirm',
    hint: 'Pass confirm: true.',
  },
  {
    id: 'PR-52',
    operation: 'git.combine',
    verdict: 'conditional',
    reason:
      'Combining branches needs at least two of them, so a single branch is not a combination ' +
      'and the result would be meaningless.',
    evidence: 'branches',
    hint: 'Name at least two branches to combine.',
  },
  {
    id: 'PR-53',
    operation: 'git.worktree',
    verdict: 'conditional',
    reason: 'Removing a worktree discards its uncommitted work, so it needs an explicit confirmation.',
    evidence: 'confirm',
    hint: 'Pass confirm: true to remove a worktree.',
  },

  // --- git: remotes and maintenance ---------------------------------------
  {
    id: 'PR-27',
    operation: 'git.remote.add',
    verdict: 'deny',
    reason: 'Adding a remote is refused: it can point the repository at somewhere unexpected.',
    appliesWhen: 'always',
    hint: 'Add the remote yourself, then use the server.',
  },
  {
    id: 'PR-28',
    operation: 'git.remote.set-url',
    verdict: 'deny',
    reason: 'Changing a remote URL is refused: it can redirect a push.',
    appliesWhen: 'always',
    hint: 'Change the URL yourself, then use the server.',
  },
  {
    id: 'PR-29',
    operation: 'git.fetch',
    verdict: 'allow',
    reason: 'Fetching only reads from the remote.',
  },
  {
    id: 'PR-46',
    operation: 'git.remote.list',
    verdict: 'allow',
    reason: 'Listing and showing remotes only reads the configuration.',
  },
  {
    id: 'PR-30',
    operation: 'git.pull',
    verdict: 'conditional',
    reason: 'A pull with a dirty tree can conflict with the working changes.',
    evidence: 'discard',
    hint: 'Commit or stash the changes first, or pass discard: true.',
  },
  {
    id: 'PR-31',
    operation: 'git.hook.install',
    verdict: 'deny',
    reason: 'Installing git hooks is refused: a hook runs arbitrary code on every commit.',
    hint: 'Install the hook yourself, then use the server.',
  },
  {
    id: 'PR-32',
    operation: 'git.config.set',
    verdict: 'deny',
    reason: 'Writing git config is refused: it can redirect remotes or change hooks globally.',
    hint: 'Set the config yourself, then use the server.',
  },
  {
    id: 'PR-33',
    operation: 'git.gc',
    verdict: 'deny',
    reason: 'Destructive maintenance is refused: it removes objects that may be the only copy of a commit.',
    hint: 'Run git gc yourself.',
  },

  // --- the forge ----------------------------------------------------------
  {
    id: 'PR-40',
    operation: 'policy.get',
    verdict: 'allow',
    reason: 'Reading the policy changes nothing.',
  },
  {
    id: 'PR-41',
    operation: 'policy.set',
    verdict: 'conditional',
    reason: 'Writing the policy needs an explicit confirmation, and a repository may only tighten it.',
    evidence: 'confirm',
    hint: 'Pass confirm: true.',
  },
  {
    id: 'PR-42',
    operation: 'gh.pr.create',
    verdict: 'conditional',
    reason: 'A pull request must come from a branch that is not protected.',
    evidence: 'branch_protected',
    hint: 'Open the pull request from a feature branch.',
  },
  {
    id: 'PR-43',
    operation: 'gh.pr.create',
    verdict: 'deny',
    reason: 'A pull request already exists for this branch.',
    appliesWhen: 'pr_exists',
    hint: 'Update the existing pull request instead.',
  },
  {
    id: 'PR-44',
    operation: 'plan.from_commits',
    verdict: 'allow',
    reason: 'Reading commits to propose tasks changes nothing.',
  },
  {
    id: 'PR-45',
    operation: 'plan.create_tasks',
    verdict: 'conditional',
    reason: 'Creating tasks from commits must be asked for explicitly.',
    evidence: 'create_tasks',
    hint: 'Pass create_tasks: true to write the proposed tasks.',
  },
];

/** Every rule id, in table order. */
export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);

/** Look a rule up by id. */
export function findRule(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id);
}

/** Look a rule up by the operation it governs. */
export function rulesForOperation(operation: string): Rule[] {
  return RULES.filter((r) => r.operation === operation);
}

/**
 * The rules that can never be relaxed.
 *
 * A repository's `policy.json` may add a rule id to `deny`, but it may not
 * remove one, and it may not turn a built-in `deny` or `conditional` into
 * an `allow`. This is the "a repository may tighten, never loosen" rule,
 * and it is what makes a repo-supplied policy file safe to load.
 */
export function isTightenable(rule: Rule): boolean {
  return rule.verdict === 'allow';
}
