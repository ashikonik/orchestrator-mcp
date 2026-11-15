"""Break: the rule stops reading the evidence.

The rule still exists and still reads as a gate, but it returns `true`
whatever the context says. A gate that always opens is not a gate.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = "      return ctx.args?.['verify_present'] === true;"
new = "      return true;"

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
