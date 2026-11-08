#!/usr/bin/env bash
# Rebuild everything the MCP server needs, from scratch, and prove it works.
#
#   ./rebuild.sh          install, compile, test, smoke-test
#   ./rebuild.sh --ci     the same, but treat any warning as a failure
#
# The order matters:
#
#   1. the dependencies are installed, because the build needs them;
#   2. the TypeScript is compiled, because the tests import from dist/;
#   3. the tests run against the compiled output;
#   4. the smoke test runs last, because it is the only check that the
#      *binary* starts and speaks the protocol.
#
# `npm ci` is used rather than `npm install` so the lockfile decides the
# dependency tree exactly -- a server that starts offline needs to start
# with the versions that were tested.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MCP_ROOT="$(cd "$HERE/.." && pwd)"
cd "$MCP_ROOT"

CI=0
[ "${1:-}" = "--ci" ] && CI=1

step() { echo; echo "==> $*"; }

step "installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

step "compiling the TypeScript server"
npm run build

step "running the TypeScript tests"
npm test

step "smoke test: the server starts and answers over stdio"
node "$MCP_ROOT/scripts/smoke.mjs"

step "end-to-end test: the server drives a real repository"
node "$MCP_ROOT/scripts/e2e.mjs"

echo
echo "REBUILD: PASS"
echo "The server is at $MCP_ROOT/dist/index.js"
