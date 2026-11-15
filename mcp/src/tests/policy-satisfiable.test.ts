/**
 * Every conditional rule must be satisfiable.
 *
 * The policy evaluator's `evidencePresent` returns `false` for any rule
 * it has no case for. That is the safe default -- an unknown rule is not
 * silently permitted -- but it means a rule with a missing case is
 * *permanently* unsatisfiable: it holds forever, and no caller can ever
 * get past it.
 *
 * A test that only checks the refusal path would not catch that. Every
 * rule here is refused when its evidence is absent, and that test would
 * pass whether or not the rule could ever be satisfied.
 *
 * So this file does the other half: for every operation that has a
 * conditional rule, it builds a context that carries all of that
 * operation's evidence and asserts the evaluation comes back satisfied.
 * If a case is removed from `evidencePresent`, this fails.
 *
 * The granularity is the *operation*, not the rule, because the
 * evaluator requires every conditional rule on an operation to be
 * satisfied. `git.reset` has two -- one for the mode, one for the
 * confirmation -- and clearing one while the other holds still holds
 * the operation. So a context that satisfies PR-20 but not PR-21 is a
 * held operation, not a satisfied rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../policy.js';
import { RULES } from '../policy-rules.js';
import type { PolicyContext } from '../types.js';

/**
 * A context that satisfies each operation's conditional rules.
 *
 * The keys are the ones `evidencePresent` reads. An operation with no
 * entry here is one this file cannot check -- and the test below fails,
 * so the list cannot silently fall behind the rule table.
 */
const SATISFIABLE: Record<string, PolicyContext> = {
  'task.cancel': { reason: 'superseded by the new approach' },
  'task.complete': { args: { commit_present: true, verify_present: true } },
  'task.delete': { confirm: true },
  'task.claim': { args: { claimable: true } },
  'git.commit.message': {
    message: 'feat: add the parser',
    args: { message_pattern: '^(feat|fix): .+' },
  },
  'git.commit': { include_untracked: true },
  'git.branch.delete': { force: true },
  'git.checkout': { discard: true },
  'git.push': {
    branch: 'feature',
    args: { branch: 'feature', remote: 'origin', branch_protected: false },
  },
  'git.merge': { source: 'feature', strategy: 'merge', args: { source: 'feature', strategy: 'merge' } },
  'git.reset': { mode: 'soft', confirm: true, args: { mode: 'soft', target: 'HEAD' } },
  'git.stash': { args: { action: 'push' } },
  'git.tag.delete': { confirm: true },
  'git.pull': { discard: true },
  'git.cherry-pick': { args: { commit: 'abc123', tree_clean: true } },
  'git.combine': { args: { branches: ['main', 'feature'] } },
  'git.worktree': { args: { action: 'list' } },
  'policy.set': { confirm: true },
  'gh.pr.create': { args: { branch_protected: false } },
  'plan.create_tasks': { create_tasks: true },
};

const conditionalRules = RULES.filter((r) => r.verdict === 'conditional');

/** The operations that have at least one conditional rule. */
const conditionalOperations = [...new Set(conditionalRules.map((r) => r.operation))].sort();

test('every conditional operation has a context that satisfies it', () => {
  const missing = conditionalOperations.filter((op) => !(op in SATISFIABLE));
  assert.deepEqual(
    missing,
    [],
    `these operations have no satisfying context in this file: ${missing.join(', ')}`,
  );
});

test('the satisfying contexts are not stale -- they still belong to a live rule', () => {
  const live = new Set(conditionalOperations);
  for (const op of Object.keys(SATISFIABLE)) {
    assert.ok(live.has(op), `${op} is in the satisfying-context table but has no conditional rule`);
  }
});

for (const operation of conditionalOperations) {
  test(`${operation} can be satisfied`, () => {
    const ctx = SATISFIABLE[operation];
    assert.ok(ctx, `${operation} has no satisfying context`);
    const decision = evaluate(operation, ctx);
    assert.equal(
      decision.verdict,
      'conditional',
      `${operation} should hold rather than allow or deny`,
    );
    assert.equal(
      decision.satisfied,
      true,
      `${operation} could not be satisfied: ${decision.reason} (rule ${decision.rule})`,
    );
  });
}

/**
 * The operations that are *not* held by an empty context.
 *
 * A rule can be conditional and still be satisfied by default -- PR-24
 * governs a stash *drop*, and a stash push or list needs no
 * confirmation, so the rule returns true for every action but `drop`.
 * PR-53 governs a worktree *removal*, and adding or listing one needs
 * no confirmation. Such an operation is gated, but it is not held by
 * default.
 */
const SATISFIED_BY_DEFAULT = new Set(['git.stash', 'git.worktree']);

test('every conditional operation is held when its evidence is absent', () => {
  // The other half of the pair: the operation has to *hold* without the
  // evidence, otherwise it is not a gate at all.
  for (const operation of conditionalOperations) {
    if (SATISFIED_BY_DEFAULT.has(operation)) continue;
    const decision = evaluate(operation, {});
    assert.equal(
      decision.verdict,
      'conditional',
      `${operation} should hold with no context, but the decision was ${decision.verdict}`,
    );
    assert.equal(
      decision.satisfied,
      false,
      `${operation} was satisfied by an empty context, so it gates nothing`,
    );
  }
});

test('the operations satisfied by default are gated all the same', () => {
  // PR-24 holds a stash *drop* until it is confirmed, and lets every
  // other action through. PR-53 holds a worktree *removal*. The
  // operations are therefore gated, even though an empty context does
  // not hold them.
  for (const operation of SATISFIED_BY_DEFAULT) {
    const decision = evaluate(operation, {});
    assert.equal(decision.verdict, 'conditional', `${operation} should be gated`);
    assert.equal(decision.satisfied, true, `${operation} should pass by default`);

    // And the destructive action is the one it holds.
    const destructive = evaluate(operation, { args: { action: DESTRUCTIVE_ACTION[operation] } });
    assert.equal(destructive.verdict, 'conditional');
    assert.equal(
      destructive.satisfied,
      false,
      `the destructive action of ${operation} should be held until it is confirmed`,
    );

    // And confirming it opens the gate.
    const confirmed = evaluate(operation, {
      args: { action: DESTRUCTIVE_ACTION[operation] },
      confirm: true,
    });
    assert.equal(
      confirmed.satisfied,
      true,
      `the destructive action of ${operation} should be allowed once it is confirmed`,
    );
  }
});

/** The action each action-scoped rule holds until it is confirmed. */
const DESTRUCTIVE_ACTION: Record<string, string> = {
  'git.stash': 'drop',
  'git.worktree': 'remove',
};

test('each conditional rule on an operation is reachable', () => {
  // Every rule on an operation must be the one that reports the hold
  // when its own evidence is missing. A rule that is never the one to
  // report is a rule the caller can never satisfy *and* never see
  // named.
  for (const rule of conditionalRules) {
    const peers = conditionalRules.filter((r) => r.operation === rule.operation);
    const ctx = SATISFIABLE[rule.operation];
    assert.ok(ctx, `${rule.operation} has no satisfying context`);

    // Take the satisfying context and remove this rule's evidence. The
    // operation must still be held -- and the rule that holds it must
    // be this one, or another rule is masking it.
    assert.ok(rule.evidence, `${rule.id} is conditional but names no evidence, so it can never be satisfied`);
    const without = { ...ctx, args: { ...(ctx.args ?? {}) } };
    // A rule that gates one action of an operation reads the action
    // first. The action has to be the destructive one, or the rule
    // passes by default and the evidence removal proves nothing.
    const destructive = DESTRUCTIVE_ACTION[rule.operation];
    if (destructive) without.args = { ...(without.args ?? {}), action: destructive };
    removeEvidence(rule.evidence, without);
    const decision = evaluate(rule.operation, without);
    assert.equal(
      decision.verdict,
      'conditional',
      `${rule.id} was satisfied without its evidence`,
    );
    assert.equal(
      decision.satisfied,
      false,
      `${rule.id} was satisfied without its evidence`,
    );
    assert.equal(
      decision.rule,
      rule.id,
      `${rule.id} was masked by ${decision.rule} when its evidence was removed`,
    );
    assert.ok(peers.length >= 1);
  }
});

/**
 * Remove one rule's evidence from a context.
 *
 * The evidence names a field the rule reads. Removing it must make the
 * rule unsatisfied -- so the removal has to reach every place the rule
 * could read it from. A rule with two pieces of evidence names both,
 * comma-separated, and both have to go.
 */
function removeEvidence(evidence: string, ctx: PolicyContext): void {
  for (const name of evidence.split(',')) {
    removeOne(name.trim(), ctx);
  }
}

function removeOne(evidence: string, ctx: PolicyContext): void {
  switch (evidence) {
    case 'reason':
      ctx.reason = undefined;
      break;
    case 'message':
      ctx.message = undefined;
      break;
    case 'include_untracked':
      ctx.include_untracked = undefined;
      break;
    case 'discard':
      ctx.discard = undefined;
      break;
    case 'force':
      ctx.force = undefined;
      break;
    case 'confirm':
      ctx.confirm = undefined;
      break;
    case 'create_tasks':
      ctx.create_tasks = undefined;
      break;
    case 'mode':
      ctx.mode = undefined;
      break;
    case 'commit':
    case 'claimable':
    case 'branches':
    case 'remote':
    case 'branch_protected':
    case 'tree_clean':
    case 'strategy':
    case 'message_pattern':
    case 'action':
    case 'commit_present':
    case 'verify_present':
      if (ctx.args) delete ctx.args[evidence];
      break;
    case 'branch':
      // PR-15 reads the branch from `args` and falls back to the
      // top-level field, so both have to go.
      ctx.branch = undefined;
      if (ctx.args) delete ctx.args['branch'];
      break;
    case 'source':
      // PR-18 reads the source from `args` and falls back to the
      // top-level field.
      ctx.source = undefined;
      if (ctx.args) delete ctx.args['source'];
      break;
    default:
      throw new Error(`the test does not know how to remove the evidence '${evidence}'`);
  }
}
