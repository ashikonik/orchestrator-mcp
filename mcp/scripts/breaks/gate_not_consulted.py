"""Break: the gate's evidence is not consulted.

The server computes `verify_present` and then hands it to the policy.
If the computed value is replaced by a constant, the policy still holds
the operation -- but it holds it for the wrong reason, and the gate is
no longer a gate.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = """        ctx.args = {
          commit_present: commitPresent,
          verify_present: verifyPresent,
        };"""

new = """        ctx.args = {
          commit_present: commitPresent,
          verify_present: true,
        };"""

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
