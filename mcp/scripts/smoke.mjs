#!/usr/bin/env node
/**
 * The smoke test — the server over a real stdio subprocess.
 *
 * The unit tests drive the server in-process. That proves the tools work,
 * but it does not prove the *binary* works: that `dist/index.js` starts,
 * speaks the protocol on stdout, keeps stdout clean, and answers a
 * `tools/list`.
 *
 * So this script does the things an in-process test cannot:
 *
 *   - it spawns the real entry point as a child process;
 *   - it checks that nothing but protocol JSON reaches stdout;
 *   - it counts the tools and checks their names.
 *
 * It is the last check before the server is registered with a harness.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, 'dist', 'index.js');

/** The tools the server must expose, in sorted order. */
const EXPECTED = [
  'board_get',
  'board_set',
  'git_combine',
  'git_commit',
  'git_diff',
  'git_log',
  'git_operate',
  'git_status',
  'git_worktree',
  'open_pr',
  'plan_from_commits',
  'policy_get',
  'policy_set',
  'task_claim',
  'task_create',
  'task_delete',
  'task_get',
  'task_list',
  'task_move',
  'task_next',
  'task_note',
  'task_update',
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/** Send one JSON-RPC message and wait for the reply with the same id. */
function request(child, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15000);
    const onLine = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(`stdout carried a line that is not JSON: ${line}`);
      }
      if (message.id !== id) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve(message);
    };
    const onData = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() === '') continue;
        onLine(line);
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

let exited = false;
child.on('exit', (code) => {
  exited = true;
  if (code !== 0 && code !== null) fail(`the server exited with code ${code}\n${stderr}`);
});

try {
  // The initialize handshake.
  const init = await request(child, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  });

  if (!init.result) fail(`initialize returned no result: ${JSON.stringify(init)}`);
  if (init.result.serverInfo?.name !== 'orchestrator') {
    fail(`the server reported the wrong name: ${JSON.stringify(init.result.serverInfo)}`);
  }
  console.log(`OK: initialize — server ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);

  // The initialized notification, then the tool list.
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = await request(child, 2, 'tools/list', {});
  const tools = listed.result?.tools;
  if (!Array.isArray(tools)) fail(`tools/list returned no tools: ${JSON.stringify(listed)}`);

  const names = tools.map((t) => t.name).sort();
  if (names.length !== EXPECTED.length) {
    fail(`expected ${EXPECTED.length} tools, got ${names.length}: ${names.join(', ')}`);
  }
  const missing = EXPECTED.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !EXPECTED.includes(n));
  if (missing.length || extra.length) {
    fail(`the tool list does not match — missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`);
  }
  console.log(`OK: tools/list — ${names.length} tools, exactly as expected`);

  // A read tool, to prove the server actually does something.
  const called = await request(child, 3, 'tools/call', {
    name: 'policy_get',
    arguments: {},
  });
  const text = called.result?.content?.[0]?.text;
  if (typeof text !== 'string') fail(`policy_get returned no text: ${JSON.stringify(called)}`);
  const payload = JSON.parse(text);
  if (!Array.isArray(payload.rules)) fail(`policy_get returned no rules: ${text.slice(0, 200)}`);
  console.log(`OK: tools/call — policy_get returned ${payload.rules.length} rules`);

  // The server must still be running, and stdout must have carried
  // nothing but protocol messages.
  if (exited) fail('the server exited before the smoke test finished');

  console.log('');
  console.log('SMOKE: PASS');
  child.stdin.end();
  process.exit(0);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
