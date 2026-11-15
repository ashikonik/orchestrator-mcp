# Registering the server

The orchestrator is a **local stdio server**. It is one Node process, it
speaks MCP over stdin and stdout, and it starts offline.

Registration is a one-time, explicit step per harness.

Throughout this document, `<repo>` is the path to this repository on your
machine — `/path/to/orchestrator` below.

---

## Before anything else

The server must be built. The entrypoint is `dist/index.js`, and it does
not exist until you compile it:

```bash
cd <repo>/mcp
./scripts/rebuild.sh
```

That installs dependencies, compiles the TypeScript, runs the tests, and
proves the binary starts and answers over stdio. If it prints
`REBUILD: PASS`, the server is ready to register.

---

## The quick way

```bash
cd <repo>/mcp

./scripts/register.sh --list          # which harnesses, and where their config is
./scripts/register.sh                 # print the snippet for every harness
./scripts/register.sh puku-cli        # print the snippet for one harness
./scripts/register.sh --apply puku-cli  # actually write it
```

`--apply` **adds** the server. It never edits an existing `orchestrator`
entry — if one is there, it refuses and says so.

Restart the harness afterwards; most of them read the config at startup.

### Scoping to one project

```bash
./scripts/register.sh --apply --project /path/to/repo puku-cli
./scripts/register.sh --apply --project /path/to/repo claude-code
```

This writes a project-level config instead of the global one:

| harness | project config |
|---|---|
| `puku-cli` | `<project>/.puku-cli/mcp.json` |
| `claude-code` | `<project>/.mcp.json` |

A project-level registration applies to that project only. The global
one applies everywhere.

---

## The harnesses

| harness | config file | format |
|---|---|---|
| `claude-code` | `~/.claude.json` | JSON |
| `puku-cli` | `~/.puku-cli/puku-cli.json` | JSON |
| `opencode` | `~/.config/opencode/opencode.json` | JSON |
| `codex` | `~/.codex/config.toml` | TOML |
| `codex-agents` | `~/.codex/config.toml` | TOML |
| `cline` | — | none |
| `agentsmd` | — | none |

`cline` and `agentsmd` have no MCP configuration surface on this
machine. The server still works with them — see below.

---

## The snippets

### JSON harnesses (`claude-code`, `puku-cli`)

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["<repo>/mcp/dist/index.js"]
    }
  }
}
```

### `opencode`

```json
{
  "mcp": {
    "orchestrator": {
      "type": "local",
      "command": ["node", "<repo>/mcp/dist/index.js"]
    }
  }
}
```

### TOML harnesses (`codex`, `codex-agents`)

```toml
[mcp_servers.orchestrator]
command = "node"
args = ["<repo>/mcp/dist/index.js"]
```

### Two things the snippets never do

- **Never `bunx`.** It is not installed on this machine, and a `bunx`
  server that cannot start is worse than no server.
- **Never `npx -y`.** It needs the network on every cold start, and the
  whole point of this server is that it starts offline.

The command is `node` with an absolute path to a compiled entrypoint.
Nothing is fetched at startup.

---

## `cline` and `agentsmd`

These harnesses have no MCP config file on this machine. Any MCP host
that can spawn a process can run the server directly:

```
node <repo>/mcp/dist/index.js
```

and speak to it over stdio. Point the harness's MCP server settings at
that command.

---

## The environment

The server needs to know which project it is working on. Set it per
harness, in the server's `env` block:

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["<repo>/mcp/dist/index.js"],
      "env": { "ORCHESTRATOR_ROOT": "/path/to/repo" }
    }
  }
}
```

| variable | meaning |
|---|---|
| `ORCHESTRATOR_ROOT` | the project directory |
| `ORCHESTRATOR_BOARD` | the board file, overriding the default path |
| `ORCHESTRATOR_POLICY` | the policy file, overriding the default path |
| `ORCHESTRATOR_DEFAULT_BRANCH` | the base branch, when the repository has no remote HEAD |

Without `ORCHESTRATOR_ROOT`, the server resolves the project from the
working directory: the git repository root if there is one, otherwise
the directory itself.

Every tool also takes an explicit `project` argument, so a caller can
point a single call at a different repository. That argument wins over
the environment.

---

## A global registration, done properly

The server resolves the project per call, so one global registration
serves every repository. The `project` argument on each tool call, or
`ORCHESTRATOR_ROOT` in the environment, selects which one.

If you would rather have one harness per project, register it
project-scoped instead:

```bash
./scripts/register.sh --apply --project ~/Projects/my-app puku-cli
```

---

## Checking that it works

After registering, ask the harness to list the server's tools. It should
report twenty-two of them:

```
board_get         board_set         git_combine
git_commit        git_diff          git_log
git_operate       git_status        git_worktree
open_pr           plan_from_commits policy_get
policy_set        task_claim        task_create
task_delete       task_get          task_list
task_move         task_next         task_note
task_update
```

From the shell, the same check:

```bash
cd <repo>/mcp
node scripts/smoke.mjs
```

It spawns the real entrypoint, does the `initialize` handshake, calls
`tools/list`, calls one tool, and checks that stdout carried nothing
but protocol messages. It prints `SMOKE: PASS`.

---

## When something goes wrong

**The server does not appear in the harness.** The harness reads its
config at startup — restart it. If it still does not appear, the config
key is wrong for that harness; check the table above against the file.

**The server starts but every tool fails.** The project is probably not
resolvable. Set `ORCHESTRATOR_ROOT`, or pass `project` on the call.

**The tools work but git operations fail.** The server needs `git` on
the `PATH` of the harness's process. It also needs `gh` for `open_pr`,
and `gh` needs to be authenticated — but only for that one tool; every
other tool works without it.

**A tool refuses and you do not know why.** The refusal names the rule.
`PR-*` is the policy (`docs/POLICY.md`), `ST-*` is the state machine
(`docs/BOARD_FORMAT.md`), `INV-*` is a board invariant. `policy_get`
returns all 54 policy rules with their reasons.

---

## Uninstalling

Remove the `orchestrator` entry from the harness's config file. Nothing
else is left behind except the board and policy files, which live in the
project and are yours to keep or delete.

```bash
# puku-cli
jq 'del(.mcpServers.orchestrator)' ~/.puku-cli/puku-cli.json > /tmp/c.json \
  && mv /tmp/c.json ~/.puku-cli/puku-cli.json
```
