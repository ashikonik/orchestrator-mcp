"""Break: the rule stops being conditional.

PR-54's case in `evidencePresent` is renamed, so the evaluator no
longer knows how to satisfy it. The rule then holds every completion
forever -- the gate is a wall, and no caller can ever get past it.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = "    case 'PR-54':"
new = "    case 'PR-54-UNUSED':"

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
