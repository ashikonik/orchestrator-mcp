"""Break: the digest check is skipped.

A record is a claim. The digest is what makes it checkable. If the
digest is not compared, a record edited after the fact -- a failing run
rewritten to say it passed -- opens the gate.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = "  const passing = forCommit.find((r) => r.passed && digestHolds(r));"
new = "  const passing = forCommit.find((r) => r.passed);"

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
