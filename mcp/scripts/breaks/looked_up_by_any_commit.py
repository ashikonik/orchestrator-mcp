"""Break: the record is looked up by any commit.

A run record is evidence about the commit it ran against. A record for a
different commit is evidence about different code. If the lookup stops
filtering by commit, a record for some unrelated commit opens the gate.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = "  const forCommit = records.filter((r) => r.commit === commit);"
new = "  const forCommit = records;"

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
