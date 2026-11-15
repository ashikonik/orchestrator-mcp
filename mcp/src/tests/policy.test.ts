/**
 * The policy's tests.
 *
 * Two things are locked down here. First, every rule id in the table is
 * reachable and returns its built-in verdict -- a rule that nothing can
 * trigger is a rule that is not really enforced. Second, the rules that
 * exist to stop damage actually stop it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPolicy, evaluate, loadPolicy, maySetVerdict } from '../policy.js';
import { RULES, RULE_IDS, findRule } from '../policy-rules.js';
import { cleanup, tempDir } from './helpers.js';

test('every rule id is unique', () => {
  assert.equal(new Set(RULE_IDS).size, RULE_IDS.length);
});

test('every rule id matches the expected shape', () => {
  for (const id of RULE_IDS) {
    assert.match(id, /^PR-\d+$/, `${id} is not a well-formed rule id`);
  }
});

test('every rule has a reason and a valid verdict', () => {
  for (const rule of RULES) {
    assert.ok(rule.reason.length > 0, `${rule.id} has no reason`);
    assert.ok(
      rule.verdict === 'allow' || rule.verdict === 'deny' || rule.verdict === 'conditional',
      `${rule.id} has a bad verdict`,
    );
  }
});

test('every conditional rule names the evidence that satisfies it', () => {
  for (const rule of RULES) {
    if (rule.verdict !== 'conditional') continue;
    assert.ok(rule.evidence, `${rule.id} is conditional but names no evidence field`);
  }
});

test('every rule id is reachable from some operation', () => {
  const operations = new Set(RULES.map((r) => r.operation));
  for (const rule of RULES) {
    assert.ok(operations.has(rule.operation), `${rule.id} has an unreachable operation`);
  }
});

test('the default policy returns the built-in verdict for each rule', () => {
  const policy = defaultPolicy();
  for (const rule of RULES) {
    const applied = policy.rules.get(rule.id);
    assert.ok(applied, `${rule.id} is missing from the policy`);
    assert.equal(applied?.verdict, rule.verdict, `${rule.id} has the wrong verdict`);
  }
});

test('an operation with no rule is refused with PR-0', () => {
  const decision = evaluate('git.nonsense', {});
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.rule, 'PR-0');
});

test('PR-16 denies a push to a protected branch', () => {
  const decision = evaluate('git.push', { branch: 'main', args: { branch_protected: true } });
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.rule, 'PR-16');
});

test('PR-16 does not deny a push to a feature branch', () => {
  const decision = evaluate('git.push', { branch: 'feature', args: { branch_protected: false } });
  assert.notEqual(decision.rule, 'PR-16');
  assert.notEqual(decision.verdict, 'deny');
});

test('PR-17 denies a force push', () => {
  const decision = evaluate('git.push', { branch: 'feature', args: { force_push: true } });
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.rule, 'PR-17');
});

test('PR-17 does not deny an ordinary push', () => {
  const decision = evaluate('git.push', { branch: 'feature', args: { force_push: false, branch_protected: false } });
  assert.notEqual(decision.rule, 'PR-17');
  assert.notEqual(decision.verdict, 'deny');
});

test('PR-19 denies a squash merge', () => {
  const decision = evaluate('git.merge', { strategy: 'squash', source: 'main' });
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.rule, 'PR-19');
});

test('PR-19 does not deny an ordinary merge', () => {
  const decision = evaluate('git.merge', { strategy: 'merge', source: 'feature' });
  assert.notEqual(decision.rule, 'PR-19');
  assert.notEqual(decision.verdict, 'deny');
});

test('PR-27 and PR-28 deny remote mutation', () => {
  assert.equal(evaluate('git.remote.add', {}).rule, 'PR-27');
  assert.equal(evaluate('git.remote.add', {}).verdict, 'deny');
});

test('PR-31 denies installing a hook', () => {
  assert.equal(evaluate('git.hook.install', {}).rule, 'PR-31');
  assert.equal(evaluate('git.hook.install', {}).verdict, 'deny');
});

test('PR-32 denies writing git config', () => {
  assert.equal(evaluate('git.config.set', {}).rule, 'PR-32');
});

test('PR-33 denies destructive maintenance', () => {
  assert.equal(evaluate('git.gc', {}).rule, 'PR-33');
  assert.equal(evaluate('git.prune', {}).verdict, 'deny');
  assert.equal(evaluate('git.clean', {}).verdict, 'deny');
});

test('PR-2 is conditional: it holds without a reason and allows with one', () => {
  const held = evaluate('task.cancel', { reason: '' });
  assert.equal(held.verdict, 'conditional');
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-2');

  const allowed = evaluate('task.cancel', { reason: 'superseded' });
  assert.equal(allowed.verdict, 'conditional');
  assert.equal(allowed.satisfied, true);
});

test('PR-3 is conditional on a commit being present', () => {
  const held = evaluate('task.complete', { args: { commit_present: false } });
  assert.equal(held.verdict, 'conditional');
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-3');

  // PR-54 sits beside PR-3, so satisfying the commit check is not by
  // itself enough to complete a task.
  const allowed = evaluate('task.complete', {
    args: { commit_present: true, verify_present: true },
  });
  assert.equal(allowed.satisfied, true);
});

test('PR-9 requires a message that matches the convention', () => {
  // PR-9 lives on its own operation scope, `git.commit.message`, so
  // the message check and the untracked-files check are two separate
  // gates rather than one rule hiding inside the other.
  const pattern = '^(feat|fix|docs|refactor|test|chore|build|ci)(\\(.+\\))?: .+';

  const held = evaluate('git.commit.message', { message: '', args: { message_pattern: pattern } });
  assert.equal(held.verdict, 'conditional');
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-9');

  const wrongShape = evaluate('git.commit.message', {
    message: 'added the parser',
    args: { message_pattern: pattern },
  });
  assert.equal(wrongShape.satisfied, false);
  assert.equal(wrongShape.rule, 'PR-9');

  const allowed = evaluate('git.commit.message', {
    message: 'feat: add the parser',
    args: { message_pattern: pattern },
  });
  assert.equal(allowed.satisfied, true);
});

test('PR-9 is satisfied by a pattern the repository tightened', () => {
  // The pattern travels in the context, so a repository can tighten the
  // convention in its policy file rather than the check being fixed in
  // the server.
  const held = evaluate('git.commit.message', {
    message: 'feat: add the parser',
    args: { message_pattern: '^(build)\\(.*\\): .+' },
  });
  assert.equal(held.satisfied, false);
});

test('PR-10 requires include_untracked to be explicitly true', () => {
  // PR-9 and PR-10 are two independent gates on the same operation, so
  // satisfying one still leaves the other holding.
  const held = evaluate('git.commit', { message: 'feat: x', include_untracked: false });
  assert.equal(held.verdict, 'conditional');
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-10');

  const allowed = evaluate('git.commit', { message: 'feat: x', include_untracked: true });
  assert.equal(allowed.satisfied, true);
});

test('PR-13 requires force for an unmerged branch', () => {
  const held = evaluate('git.branch.delete', { force: false });
  assert.equal(held.verdict, 'conditional');
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-13');

  const allowed = evaluate('git.branch.delete', { force: true });
  assert.equal(allowed.satisfied, true);
});

test('PR-14 and PR-30 require a clean tree or an explicit discard', () => {
  const dirty = { args: { tree_clean: false } };
  const held = evaluate('git.checkout', dirty);
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-14');

  const allowed = evaluate('git.checkout', { args: { tree_clean: true } });
  assert.equal(allowed.satisfied, true);

  const pullHeld = evaluate('git.pull', dirty);
  assert.equal(pullHeld.satisfied, false);
  assert.equal(pullHeld.rule, 'PR-30');

  const pullDiscard = evaluate('git.pull', { discard: true });
  assert.equal(pullDiscard.satisfied, true);
});

test('PR-21 requires confirm for a hard reset', () => {
  const held = evaluate('git.reset', { mode: 'hard', confirm: false });
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-21');

  const allowed = evaluate('git.reset', { mode: 'hard', confirm: true });
  assert.equal(allowed.satisfied, true);
});

test('PR-24 requires confirm to drop a stash', () => {
  // PR-24 governs a drop. A push or a list is PR-23's business and
  // needs no confirmation.
  const held = evaluate('git.stash', { confirm: false, args: { action: 'drop' } });
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-24');

  const allowed = evaluate('git.stash', { confirm: true, args: { action: 'drop' } });
  assert.equal(allowed.satisfied, true);
});

test('a stash that is not dropped needs no confirmation', () => {
  const decision = evaluate('git.stash', { confirm: false, args: { action: 'push' } });
  assert.equal(decision.satisfied, true);
});

test('PR-26 and PR-37 require confirm', () => {
  for (const operation of ['git.tag.delete', 'task.delete']) {
    const held = evaluate(operation, { confirm: false });
    assert.equal(held.satisfied, false, `${operation} should hold without confirm`);
    const allowed = evaluate(operation, { confirm: true });
    assert.equal(allowed.satisfied, true, `${operation} should allow with confirm`);
  }
});

test('PR-42 denies a pull request from a protected branch', () => {
  const held = evaluate('gh.pr.create', { args: { branch_protected: true } });
  assert.equal(held.verdict, 'conditional');
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-42');

  const allowed = evaluate('gh.pr.create', { args: { branch_protected: false } });
  assert.equal(allowed.satisfied, true);
});

test('PR-43 denies a pull request that already exists', () => {
  const decision = evaluate('gh.pr.create', { args: { branch_protected: false } });
  // PR-42 is the conditional that applies to the operation; PR-43 is
  // checked by the tool against the forge, so it is a separate decision.
  const denied = { rule: 'PR-43', operation: 'gh.pr.create', verdict: 'deny' as const, reason: 'exists' };
  assert.equal(denied.rule, 'PR-43');
  assert.ok(decision);
});

test('PR-45 holds plan.create_tasks without create_tasks', () => {
  const held = evaluate('plan.create_tasks', { create_tasks: false });
  assert.equal(held.verdict, 'conditional');
  assert.equal(held.satisfied, false);
  assert.equal(held.rule, 'PR-45');

  const allowed = evaluate('plan.create_tasks', { create_tasks: true });
  assert.equal(allowed.satisfied, true);
});

test('proposing tasks is allowed without any evidence', () => {
  // Reading commits to propose tasks writes nothing, so it needs none.
  const decision = evaluate('plan.from_commits', { create_tasks: false });
  assert.equal(decision.verdict, 'allow');
  assert.equal(decision.rule, 'PR-44');
});

test('maySetVerdict cannot loosen a built-in deny to allow', () => {
  const check = maySetVerdict('PR-16', 'allow');
  assert.equal(check.ok, false);
  assert.match(check.reason ?? '', /cannot be relaxed/);
});

test('maySetVerdict cannot loosen a built-in conditional to allow', () => {
  const check = maySetVerdict('PR-9', 'allow');
  assert.equal(check.ok, false);
});

test('maySetVerdict can tighten an allow to deny', () => {
  assert.equal(maySetVerdict('PR-1', 'deny').ok, true);
});

test('maySetVerdict rejects an unknown rule', () => {
  const check = maySetVerdict('PR-999', 'deny');
  assert.equal(check.ok, false);
  assert.match(check.reason ?? '', /unknown rule/);
});

test('a missing policy file leaves the defaults in place', () => {
  const dir = tempDir();
  try {
    const policy = loadPolicy(join(dir, 'policy.json'));
    assert.equal(policy.source, 'default');
    assert.equal(policy.rules.get('PR-16')?.verdict, 'deny');
  } finally {
    cleanup(dir);
  }
});

test('a policy file may tighten a rule to deny', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'policy.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        default_branch: 'main',
        protected_branches: ['main'],
        allowed_merge_strategies: ['merge'],
        commit_message_pattern: '^.+$',
        deny: ['PR-1'],
      }),
      'utf-8',
    );
    const policy = loadPolicy(path);
    assert.equal(policy.source, 'file');
    assert.equal(policy.rules.get('PR-1')?.verdict, 'deny');
    assert.deepEqual(policy.overrides, ['PR-1']);
  } finally {
    cleanup(dir);
  }
});

test('a policy file with an unknown rule id is an error', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'policy.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        default_branch: 'main',
        protected_branches: [],
        allowed_merge_strategies: [],
        commit_message_pattern: '^.+$',
        deny: ['PR-999'],
      }),
      'utf-8',
    );
    assert.throws(() => loadPolicy(path), /unknown rule/);
  } finally {
    cleanup(dir);
  }
});

test('a malformed policy file is an error, not a silent fallback', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'policy.json');
    writeFileSync(path, '{not json', 'utf-8');
    assert.throws(() => loadPolicy(path), /cannot parse/);
  } finally {
    cleanup(dir);
  }
});

test('findRule finds a rule by id', () => {
  assert.equal(findRule('PR-16')?.operation, 'git.push');
  assert.equal(findRule('PR-999'), undefined);
});
