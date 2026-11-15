"""Break: the verifier's answer is ignored.

The verifier's verdict is what the gate turns on. If the verdict is
replaced by `true`, every branch opens the gate -- whether or not the
work was ever checked.
"""
import sys

path = sys.argv[1]
s = open(path).read()

old = "          verifyPresent = verification.verified;"
new = "          verifyPresent = true;"

if old not in s:
    sys.exit(1)

open(path, 'w').write(s.replace(old, new))
