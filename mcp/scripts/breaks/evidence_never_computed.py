"""Break: the evidence is never computed.

The verifier is never asked, so the gate has nothing to go on and holds
every completion -- including the ones that should pass.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = "          verification = verifyCommit(repo, tip);"
new = "          verification = null;"

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
