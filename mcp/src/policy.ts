/**
 * The policy evaluator.
 *
 * Every operation the server performs passes through `evaluate()` first.
 * The evaluator answers one question: may this operation proceed, and if
 * not, what exactly is missing?
 *
 * Three verdicts:
 *
 *  - `allow` -- proceed.
 *  - `deny` -- refuse, and say why.
 *  - `conditional` -- proceed if the evidence is present, otherwise hold
 *    and name the evidence.
 *
 * The distinction between `deny` and `conditional` is the useful one for a
 * caller. "You may not push to main" is a wall. "Push a feature branch" is
 * a door with the key visible.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parsePolicy } from './board-schema.js';
import { RULES, findRule, isTightenable } from './policy-rules.js';
import type { Rule } from './policy-rules.js';
import type { PolicyContext, PolicyDecision, PolicyVerdict } from './types.js';
import type { PolicyFile } from './board-schema.js';

/** The policy in force for one evaluation. */
export interface Policy {
  rules: Map<string, { verdict: PolicyVerdict; reason?: string }>;
  file: PolicyFile | null;
  source: 'default' | 'file';
  path: string | null;
  /** Rule ids the repo's policy file overrode. */
  overrides: string[];
}

/** The built-in defaults, derived from the rule table. */
export function defaultPolicy(): Policy {
  const rules = new Map<string, { verdict: PolicyVerdict; reason?: string }>();
  for (const rule of RULES) {
    rules.set(rule.id, { verdict: rule.verdict, reason: rule.reason });
  }
  return { rules, file: null, source: 'default', path: null, overrides: [] };
}

/**
 * Load the policy for a project.
 *
 * A missing policy file is normal -- the built-in defaults apply. A
 * *present but malformed* file is an error: silently falling back to the
 * defaults would quietly discard the repository's own rules, which is the
 * opposite of what the file is for.
 */
export function loadPolicy(path: string): Policy {
  const base = defaultPolicy();
  if (!existsSync(path)) return base;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(
      `cannot parse ${path} as JSON: ${e instanceof Error ? e.message : String(e)}. ` +
        'Fix or move the file; the built-in defaults are not used, because a policy ' +
        'file that cannot be read must not silently become no policy.',
    );
  }

  const parsed = parsePolicy(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const file = parsed.policy;

  // An unknown rule id in `deny` is an error rather than a no-op. A typo
  // in a policy file would otherwise look like a rule that was tightened,
  // when it was not tightened at all.
  for (const id of file.deny) {
    if (!findRule(id)) {
      throw new Error(
        `${path} denies unknown rule '${id}'. The known rule ids are: ` +
          RULES.map((r) => r.id).join(', '),
      );
    }
  }

  const overrides: string[] = [];
  for (const id of file.deny) {
    const rule = findRule(id);
    if (!rule) continue;
    // A repository may tighten any rule to `deny`. It may not loosen one
    // that is already `deny` or `conditional` -- the built-in verdict is
    // the floor, not the ceiling.
    base.rules.set(id, { verdict: 'deny', reason: rule.reason });
    overrides.push(id);
  }

  return { ...base, file, source: 'file', path, overrides };
}

/**
 * Can a repository's policy file set this rule's verdict?
 *
 * Only `allow` -> `deny` is permitted. Anything else is a loosening
 * attempt and is refused.
 */
export function maySetVerdict(ruleId: string, verdict: PolicyVerdict): { ok: boolean; reason?: string } {
  const rule = findRule(ruleId);
  if (!rule) {
    return { ok: false, reason: `unknown rule '${ruleId}'` };
  }
  if (verdict === 'allow') {
    if (rule.verdict === 'allow') return { ok: true };
    return {
      ok: false,
      reason:
        `rule '${ruleId}' is '${rule.verdict}' by default and cannot be relaxed to 'allow'. ` +
        'A repository may tighten a policy, never loosen it.',
    };
  }
  if (verdict === 'deny') return { ok: true };
  // 'conditional' would be a loosening of a built-in 'deny'.
  if (rule.verdict === 'deny') {
    return {
      ok: false,
      reason: `rule '${ruleId}' is 'deny' by default and cannot be relaxed to 'conditional'.`,
    };
  }
  return { ok: true };
}

/** Is the rule's evidence present in the context? */
function evidencePresent(ruleId: string, ctx: PolicyContext): boolean {
  switch (ruleId) {
    case 'PR-2':
      return typeof ctx.reason === 'string' && ctx.reason.trim().length > 0;
    case 'PR-3':
      // Checked against git by the caller; the context carries the answer.
      return ctx.args?.['commit_present'] === true;
    case 'PR-54':
      // Checked against the verifier's run records by the caller; the
      // context carries the answer. The record's digest is re-checked
      // there, so a record edited after the fact does not open this
      // gate.
      return ctx.args?.['verify_present'] === true;
    case 'PR-9':
      // The message must match the repository's convention. The pattern
      // travels in the context, so a repository can tighten it in its
      // policy file rather than the check being hard-coded here.
      if (typeof ctx.message !== 'string' || ctx.message.trim().length === 0) return false;
      const pattern = ctx.args?.['message_pattern'];
      if (typeof pattern !== 'string') return false;
      try {
        return new RegExp(pattern).test(ctx.message);
      } catch {
        // A pattern that is not a valid regular expression matches
        // nothing -- the message does not satisfy it.
        return false;
      }
    case 'PR-10':
      return ctx.include_untracked === true;
    case 'PR-13':
      // The evidence is "this branch is merged, or the caller forced it".
      // The server computes the merged case against git and puts the
      // answer in the context; the caller says force explicitly.
      return ctx.force === true || ctx.args?.['force'] === true;
    case 'PR-49':
      // A cherry-pick needs a commit to apply, and a clean tree to
      // apply it onto. Both are computed by the caller, which is the
      // only place that can ask git.
      return (
        typeof ctx.args?.['commit'] === 'string' &&
        ctx.args['commit'].length > 0 &&
        ctx.args?.['tree_clean'] === true
      );
    case 'PR-14':
    case 'PR-30':
      return ctx.discard === true || ctx.args?.['tree_clean'] === true;
    case 'PR-15':
      // A push needs somewhere to push. The branch has to be named and
      // it has to be one the repository has not protected -- the
      // protected case is PR-16's denial, but the evidence here has to
      // agree with it, or a push to `main` would be held by the
      // conditional *and* denied by the rule that names the real
      // reason.
      const pushBranch = ctx.args?.['branch'] ?? ctx.branch;
      if (typeof pushBranch !== 'string' || pushBranch.trim() === '') return false;
      if (ctx.args?.['branch_protected'] === true) return false;
      const remote = ctx.args?.['remote'];
      return typeof remote === 'string' && remote.trim() !== '';
    case 'PR-18':
      // A merge needs a source and one of the permitted strategies. The
      // squash strategy is PR-19's denial.
      const source = ctx.args?.['source'] ?? ctx.source;
      if (typeof source !== 'string' || source.trim() === '') return false;
      const strategy = ctx.args?.['strategy'] ?? ctx.strategy;
      return strategy === 'merge' || strategy === 'rebase';
    case 'PR-17':
      // A force push is always a denial, never a conditional.
      return false;
    case 'PR-20':
      return ctx.mode === 'soft' || ctx.mode === 'mixed' || ctx.mode === 'hard';
    case 'PR-21':
    case 'PR-26':
    case 'PR-37':
    case 'PR-41':
      return ctx.confirm === true;
    case 'PR-24':
      // PR-24 governs a stash *drop*. A push or a list is PR-23's
      // business and needs no confirmation.
      if (ctx.args?.['action'] !== 'drop') return true;
      return ctx.confirm === true;
    case 'PR-42':
      // Checked against git by the caller.
      return ctx.args?.['branch_protected'] === false;
    case 'PR-45':
      return ctx.create_tasks === true;
    case 'PR-48':
      // The server computes whether the task is claimable -- unblocked,
      // and not claimed by somebody else -- and puts the answer in the
      // context. The blocker is named in the context too, so the
      // refusal can say which task is in the way.
      return ctx.args?.['claimable'] === true;
    case 'PR-52':
      // At least two branches, and they have to be names rather than a
      // single string: the caller may pass either a list or a
      // comma-separated string, and both mean the same thing.
      const branches = ctx.args?.['branches'];
      if (Array.isArray(branches)) return branches.length >= 2;
      if (typeof branches === 'string') {
        return branches.split(',').filter((b) => b.trim() !== '').length >= 2;
      }
      return false;
    case 'PR-53':
      // Only a *removal* is destructive. Adding and listing a worktree
      // are ordinary.
      if (ctx.args?.['action'] !== 'remove') return true;
      return ctx.confirm === true;
    default:
      return false;
  }
}

/**
 * Does a `deny` rule's refusal apply in this context?
 *
 * A rule with no `appliesWhen` always applies. A rule with one applies
 * only when the context says so -- so "pushing to a protected branch is
 * refused" refuses the protected push and not the feature-branch one.
 */
function denyApplies(ruleId: string, ctx: PolicyContext): boolean {
  switch (ruleId) {
    case 'PR-8':
      return ctx.args?.['not_in_repository'] === true;
    case 'PR-16':
      return ctx.args?.['branch_protected'] === true;
    case 'PR-17':
      return ctx.args?.['force_push'] === true || ctx.force === true;
    case 'PR-19':
      return ctx.strategy === 'squash' || ctx.args?.['strategy'] === 'squash';
    case 'PR-11':
      return ctx.args?.['path_escapes_repo'] === true;
    case 'PR-43':
      return ctx.args?.['pr_exists'] === true;
    default:
      return true;
  }
}

/**
 * Evaluate one operation against the policy.
 *
 * `operation` is the operation name -- `git.push`, `task.cancel` and so
 * on. Every rule that governs the operation is applied.
 *
 * The rules combine in a fixed order of precedence, not in table order:
 *
 *   1. any applicable `deny` wins, and the first one in table order is
 *      reported;
 *   2. otherwise any unsatisfied `conditional` holds, and the first one
 *      in table order is reported;
 *   3. otherwise the operation is allowed.
 *
 * Table order alone would be wrong. `git.push` has three rules: PR-15
 * (conditional, satisfied by naming a branch), PR-16 (deny, a protected
 * branch) and PR-17 (deny, a force push). Evaluating them in table order
 * and stopping at the first would let PR-15's satisfaction mask PR-16's
 * denial -- so a push to `main` would be allowed because the caller named
 * a branch. A deny has to outrank a satisfied conditional, because a
 * deny is a wall and a satisfied conditional is only the absence of one.
 */
export function evaluate(
  operation: string,
  ctx: PolicyContext,
  policy: Policy = defaultPolicy(),
): PolicyDecision {
  const applicable = RULES.filter((r) => r.operation === operation);
  if (applicable.length === 0) {
    // An operation with no rule is not covered by the policy. Rather than
    // allow it silently, it is refused: the policy table is the complete
    // list of things the server may do, and an unlisted operation is a
    // bug in the server rather than a permission.
    return {
      rule: 'PR-0',
      operation,
      verdict: 'deny',
      reason: `the operation '${operation}' is not covered by the policy table.`,
      hint: 'This is a bug in the server, not something you can work around.',
    };
  }

  // Pass 1: a deny is a wall. It outranks everything else.
  for (const rule of applicable) {
    const override = policy.rules.get(rule.id);
    const verdict = override?.verdict ?? rule.verdict;
    if (verdict !== 'deny') continue;
    if (!denyApplies(rule.id, ctx)) continue;
    return {
      rule: rule.id,
      operation,
      verdict: 'deny',
      reason: override?.reason ?? rule.reason,
      hint: rule.hint,
    };
  }

  // Pass 2: an unsatisfied conditional holds the operation.
  let satisfiedRule: Rule | undefined;
  for (const rule of applicable) {
    const override = policy.rules.get(rule.id);
    const verdict = override?.verdict ?? rule.verdict;
    if (verdict !== 'conditional') continue;
    const satisfied = evidencePresent(rule.id, ctx);
    if (!satisfied) {
      return {
        rule: rule.id,
        operation,
        verdict: 'conditional',
        reason: override?.reason ?? rule.reason,
        satisfied: false,
        hint: rule.hint,
      };
    }
    // The first satisfied conditional is remembered, so the response can
    // say which gate the evidence opened rather than just "allow".
    if (!satisfiedRule) satisfiedRule = rule;
  }

  // Pass 3: everything the operation needs is present.
  if (satisfiedRule) {
    return {
      rule: satisfiedRule.id,
      operation,
      verdict: 'conditional',
      reason: policy.rules.get(satisfiedRule.id)?.reason ?? satisfiedRule.reason,
      satisfied: true,
    };
  }

  const first = applicable[0];
  return {
    rule: first.id,
    operation,
    verdict: 'allow',
    reason: first.reason,
  };
}

/** The rules that may be tightened by a policy file. */
export function tightenableRules(): string[] {
  return RULES.filter(isTightenable).map((r) => r.id);
}
