"""Break: the branch tip is resolved by range comparison.

The known trap: comparing `main..main` is empty, so a task whose branch
*is* the default branch never opens the gate. The fix is to resolve the
tip directly. If the tip is instead resolved as `<tip>^`, the gate is
looking for a record about the *parent* commit -- and the record for the
tip no longer opens it.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = "          const tip = resolveRef(branchForCheck, repo);"
new = "          const tip = `${resolveRef(branchForCheck, repo)}^`;"

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
