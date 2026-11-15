/**
 * Reading the verifier's run records.
 *
 * The orchestrator's `done` gate asks: was this work *checked*? The
 * verifier's answer is a run record — a file under
 * `<repo>/.verifier/runs/` carrying the command, the exit code, the
 * commit it ran against, and a digest over all of it.
 *
 * The orchestrator does not run checks. It reads the records the
 * verifier left, and it re-checks each record's digest before believing
 * it. That re-check is the whole point: a record is a claim, and a
 * claim that was edited after the fact must not open a gate.
 *
 * The two servers are deliberately decoupled. The orchestrator depends
 * on the *record format*, not on the verifier being installed: a
 * project can verify its work any way it likes, as long as it leaves a
 * record in this shape. A project with no verifier produces no
 * records, and the gate reports that rather than guessing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Where the verifier's records live, relative to the repository root. */
export const VERIFIER_DIR = '.verifier';
export const VERIFIER_RUNS_DIR = 'runs';

/**
 * The fields a record's digest covers.
 *
 * The same list the verifier uses. It is written out here rather than
 * imported, because the two servers are separate programs: the
 * orchestrator reads records that the verifier wrote, possibly with a
 * different version of the verifier. The list is the contract between
 * them.
 */
const DIGEST_FIELDS = [
  'argv',
  'branch',
  'check',
  'commit',
  'exit_code',
  'output',
  'output_truncated',
  'passed',
  'root',
  'signal',
  'source',
  'touched',
] as const;

/** A run record, as the orchestrator reads it. */
export interface RunRecord {
  id: string;
  check: string;
  argv: string[];
  passed: boolean;
  exit_code: number | null;
  commit: string | null;
  branch: string | null;
  started_at: string;
  digest: string;
  [key: string]: unknown;
}

/** What the orchestrator concluded from the records. */
export interface VerificationStatus {
  /** Whether a usable, passing record exists for the commit. */
  verified: boolean;
  /** The record that was found, when one was. */
  record: RunRecord | null;
  /** Why the answer is what it is. */
  reason: string;
  /** The commit the record was looked for by. */
  commit: string | null;
}

/** The digest of a record's content, computed the way the verifier does. */
export function computeDigest(record: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {};
  for (const field of DIGEST_FIELDS) {
    payload[field] = record[field];
  }
  // The keys are sorted so the digest does not depend on the order the
  // fields are written in. The same rule the verifier uses.
  const sorted = [...DIGEST_FIELDS].sort();
  return createHash('sha256')
    .update(JSON.stringify(payload, sorted), 'utf-8')
    .digest('hex');
}

/** Does the record's digest still match its content? */
export function digestHolds(record: Record<string, unknown>): boolean {
  if (typeof record['digest'] !== 'string') return false;
  return computeDigest(record) === record['digest'];
}

/** The records directory for a repository. */
export function recordsDir(repoRoot: string): string {
  return join(repoRoot, VERIFIER_DIR, VERIFIER_RUNS_DIR);
}

/**
 * Every run record for a repository.
 *
 * A record that cannot be parsed is skipped rather than fatal: one
 * corrupt file should not make the whole gate say "no records". The
 * gate's answer is about whether a *usable* record exists.
 */
export function readRecords(repoRoot: string): RunRecord[] {
  const dir = recordsDir(repoRoot);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, entry), 'utf-8');
      const parsed = JSON.parse(raw) as RunRecord;
      if (parsed && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      // A record that cannot be read is not evidence.
    }
  }
  return out;
}

/**
 * The record that verifies a commit.
 *
 * The search is by commit, because that is what "this work was
 * checked" means: a record that ran against a *different* commit is
 * evidence about different code, and must not open the gate for this
 * one.
 *
 * Among the records for the commit, the most recent passing one wins.
 * A failing record does not erase a passing one — the work may have
 * been fixed and re-run — but a passing record whose digest has been
 * broken does not count at all.
 */
export function verifyCommit(repoRoot: string, commit: string | null): VerificationStatus {
  if (!commit) {
    return {
      verified: false,
      record: null,
      reason:
        'No commit could be resolved for the task\'s branch, so there is nothing ' +
        'for a run record to be evidence about.',
      commit: null,
    };
  }

  const records = readRecords(repoRoot);
  if (records.length === 0) {
    return {
      verified: false,
      record: null,
      reason:
        `No run records exist under ${recordsDir(repoRoot)}. Run the project's ` +
        'checks with the verifier to produce one.',
      commit,
    };
  }

  const forCommit = records.filter((r) => r.commit === commit);
  if (forCommit.length === 0) {
    const commits = [...new Set(records.map((r) => r.commit).filter(Boolean))];
    return {
      verified: false,
      record: null,
      reason:
        `No run record exists for commit ${commit.slice(0, 7)}. The records that ` +
        `exist are for: ${commits.map((c) => String(c).slice(0, 7)).join(', ') || '(none)'}.`,
      commit,
    };
  }

  // The records for the commit, newest first. The id starts with an
  // ISO timestamp, so a reverse lexicographic sort is a reverse
  // chronological sort.
  forCommit.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  const broken = forCommit.find((r) => !digestHolds(r));
  const passing = forCommit.find((r) => r.passed && digestHolds(r));

  if (passing) {
    return {
      verified: true,
      record: passing,
      reason:
        `The '${passing.check}' check passed at ${passing.started_at} and its ` +
        'digest still matches.',
      commit,
    };
  }

  if (broken) {
    return {
      verified: false,
      record: broken,
      reason:
        'The run record for this commit has been edited since it was written: ' +
        'its digest no longer matches its content.',
      commit,
    };
  }

  const failing = forCommit[0]!;
  return {
    verified: false,
    record: failing,
    reason:
      `The '${failing.check}' check did not pass at ${failing.started_at} ` +
      `(exit code ${failing.exit_code}).`,
    commit,
  };
}
