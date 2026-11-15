#!/usr/bin/env bash
# Prove that the PR-54 gate actually breaks when the code that provides
# it is broken.
#
# The guarantee: **a task cannot reach `done` on an unverified branch, and
# a run record edited after the fact does not open the gate.** The gate is
# the reason `done` means "checked", not merely "committed".
#
# The breaks are the ones that would make the gate mean nothing:
#
#   * the gate not being consulted at all;
#   * the verifier's evidence being ignored;
#   * the digest check being skipped;
#   * the record being looked up by the wrong commit;
#   * the branch tip being resolved by range comparison, which is the
#     known `main..main` trap.
#
# Each break is a small Python program that edits one source file. The
# programs live in `scripts/breaks/` rather than inline, because a
# multi-line replacement written inline in a shell heredoc cannot keep
# its newlines -- and a replacement that does not match is not a break.
#
# The files are saved and restored in-process, so the tree is left
# exactly as it was.
set -u

cd "$(dirname "$0")/.."
TS=src/verify.ts
SRV=src/server.ts
POL=src/policy.ts
BREAKS=scripts/breaks
SAVED=$(mktemp -d)
OUT=/tmp/break-verify-out.txt

restore() {
  cp -f "$SAVED/verify.ts" "$TS" 2>/dev/null
  cp -f "$SAVED/server.ts" "$SRV" 2>/dev/null
  cp -f "$SAVED/policy.ts" "$POL" 2>/dev/null
  npm run build >/dev/null 2>&1
  # The restore is the one part of this script that can lose work, so
  # it is checked: the saved copies must be byte-identical to what is
  # on disk now, or the tree was not restored and the script must say
  # so rather than exit quietly.
  for pair in "$TS:$SAVED/verify.ts" "$SRV:$SAVED/server.ts" "$POL:$SAVED/policy.ts"; do
    local now="${pair%%:*}" then="${pair#*:}"
    if ! cmp -s "$now" "$then"; then
      echo "RESTORE FAILED: $now does not match its saved copy" >&2
    fi
  done
  rm -rf "$SAVED"
}
trap restore EXIT

cp "$TS" "$SAVED/verify.ts"
cp "$SRV" "$SAVED/server.ts"
cp "$POL" "$SAVED/policy.ts"

failures=0

# Apply a break, then run the gate's tests.
#
# The first argument is the label, the second the break program, and the
# third the source file the program edits.
break_and_expect_fail() {
  local label="$1" program="$2" file="$3"
  echo "=== BREAK: $label"
  local before
  before=$(md5sum "$TS" "$SRV" "$POL" | md5sum | cut -d' ' -f1)
  if ! python3 "$BREAKS/$program" "$file"; then
    echo "    NOT APPLIED -- the anchor text was not found"
    failures=$((failures + 1))
    return
  fi
  local after
  after=$(md5sum "$TS" "$SRV" "$POL" | md5sum | cut -d' ' -f1)
  if [ "$before" = "$after" ]; then
    echo "    NOT APPLIED -- the program did not change the file"
    failures=$((failures + 1))
    return
  fi
  npm run build >/dev/null 2>&1
  if node --test dist/tests/verify-gate.test.js >"$OUT" 2>&1; then
    echo "    NOT DETECTED -- the gate still passed"
    failures=$((failures + 1))
  else
    echo "    detected."
    grep -E "^✖" "$OUT" | head -4 | sed 's/^/      /'
  fi
  cp "$SAVED/verify.ts" "$TS"
  cp "$SAVED/server.ts" "$SRV"
  cp "$SAVED/policy.ts" "$POL"
  npm run build >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# The gate stops being consulted.
# ---------------------------------------------------------------------------

break_and_expect_fail \
  "the gate is not consulted at all" \
  gate_not_consulted.py "$SRV"

break_and_expect_fail \
  "the verifier's answer is ignored" \
  verifier_answer_ignored.py "$SRV"

break_and_expect_fail \
  "the evidence is never computed" \
  evidence_never_computed.py "$SRV"

# ---------------------------------------------------------------------------
# The gate stops being a rule.
# ---------------------------------------------------------------------------

break_and_expect_fail \
  "the rule stops being conditional" \
  rule_not_conditional.py "$POL"

break_and_expect_fail \
  "the rule stops reading the evidence" \
  rule_ignores_evidence.py "$POL"

# ---------------------------------------------------------------------------
# The record's integrity stops being checked.
# ---------------------------------------------------------------------------

break_and_expect_fail \
  "the digest check is skipped" \
  digest_check_skipped.py "$TS"

break_and_expect_fail \
  "a failing record counts as a passing one" \
  failing_counts_as_passing.py "$TS"

# ---------------------------------------------------------------------------
# The record is looked up by the wrong thing.
# ---------------------------------------------------------------------------

break_and_expect_fail \
  "the record is looked up by any commit" \
  looked_up_by_any_commit.py "$TS"

# ---------------------------------------------------------------------------
# The branch tip is resolved by range comparison -- the known trap.
# ---------------------------------------------------------------------------

break_and_expect_fail \
  "the branch tip is resolved by range comparison" \
  tip_by_range_comparison.py "$SRV"

echo
echo "=== restored; the gate must pass again"
npm run build >/dev/null 2>&1
if node --test dist/tests/verify-gate.test.js >"$OUT" 2>&1; then
  echo "    PASS"
else
  echo "    NOT PASSING after the restore -- the tree was not restored cleanly"
  failures=$((failures + 1))
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "BREAK CHECK: PASS -- every break was detected"
  exit 0
fi
echo "BREAK CHECK: FAIL -- $failures break(s) went unnoticed"
exit 1
