"""Break: a failing record counts as a passing one.

The gate must open only on a *passing* run. If the `passed` flag is
dropped from the search, a run that failed its checks opens the gate --
which is exactly the outcome the gate exists to prevent.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = "  const passing = forCommit.find((r) => r.passed && digestHolds(r));"
new = "  const passing = forCommit.find((r) => digestHolds(r));"

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
