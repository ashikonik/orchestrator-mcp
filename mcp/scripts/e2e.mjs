#!/usr/bin/env node
/**
 * The end-to-end test — the server driving a real repository.
 *
 * The unit tests run the server in-process. The smoke test proves the
 * binary speaks the protocol. This script proves the two together do
 * the *work*: that a task lands on the board, that a commit lands in
 * git, that a destructive operation is refused with the right rule,
 * that a dry run writes nothing, and that a real write does.
 *
 * It drives the real `dist/index.js` as a child process over real
 * stdio, against a throwaway git repository in a temp directory. The
 * real home directory is never touched.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, 'dist', 'index.js');

/** Everything the run needs, in one place so a failure can say what broke. */
const state = { repo: null, board: null };

function fail(message) {
  console.error(`FAIL: ${message}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  if (state.repo) rmSync(state.repo, { recursive: true, force: true });
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'orchestrator',
      GIT_AUTHOR_EMAIL: 'orchestrator@example.invalid',
      GIT_COMMITTER_NAME: 'orchestrator',
      GIT_COMMITTER_EMAIL: 'orchestrator@example.invalid',
    },
  });
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

class Client {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutLines = [];

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        this.stdoutLines.push(line);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail(`stdout carried a line that is not JSON: ${line}`);
        }
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          entry.resolve(message);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        20000,
      );
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async call(name, args = {}) {
    const reply = await this.request('tools/call', { name, arguments: args });
    const text = reply.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      fail(`${name} returned no text: ${JSON.stringify(reply)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      fail(`${name} returned text that is not JSON: ${text.slice(0, 300)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'orchestrator-e2e-'));
state.repo = dir;
state.board = join(dir, '.orchestrator', 'board.json');

git(['init', '-q', '-b', 'main', dir], dir);
git(['config', 'user.name', 'orchestrator'], dir);
git(['config', 'user.email', 'orchestrator@example.invalid'], dir);
git(['config', 'commit.gpgsign', 'false'], dir);
writeFileSync(join(dir, 'README.md'), '# e2e\n', 'utf-8');
git(['add', '--', 'README.md'], dir);
git(['commit', '-q', '-m', 'chore: seed the repository'], dir);

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ORCHESTRATOR_ROOT: dir,
    ORCHESTRATOR_DEFAULT_BRANCH: 'main',
  },
});
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});
const client = new Client(child);

try {
  // --- the handshake ------------------------------------------------------
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1.0.0' },
  });
  if (init.result?.serverInfo?.name !== 'orchestrator') {
    fail(`the server reported the wrong name: ${JSON.stringify(init.result?.serverInfo)}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  console.log(`OK: initialize — server ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);

  // --- a task lands on the board -----------------------------------------
  const created = await client.call('task_create', {
    title: 'Add the greeting',
    body: 'The first task the board ever sees.',
    labels: ['e2e'],
  });
  if (!created.id || !created.task) {
    fail(`task_create returned no task: ${JSON.stringify(created)}`);
  }
  if (!existsSync(state.board)) fail('task_create wrote no board file');
  const onDisk = JSON.parse(readFileSync(state.board, 'utf-8'));
  if (onDisk.tasks.length !== 1) fail(`the board holds ${onDisk.tasks.length} tasks, expected 1`);
  if (onDisk.tasks[0].title !== 'Add the greeting') fail('the board holds the wrong task');
  console.log(`OK: task_create — ${created.id} on the board`);

  // --- a dry run writes nothing ------------------------------------------
  const dry = await client.call('task_create', {
    title: 'Should never exist',
    dry_run: true,
  });
  if (dry.dry_run !== true) fail('a dry run did not say so');
  if (dry.created === true) fail('a dry run claimed it created something');
  const afterDry = JSON.parse(readFileSync(state.board, 'utf-8'));
  if (afterDry.tasks.length !== 1) fail('a dry run changed the board');
  console.log('OK: dry_run — the board is unchanged');

  // --- an illegal transition is refused ----------------------------------
  const refused = await client.call('task_move', {
    id: created.id,
    to: 'done',
  });
  if (refused.refused !== true) {
    fail(`todo -> done was not refused: ${JSON.stringify(refused)}`);
  }
  if (refused.rule !== 'ST-9') {
    fail(`todo -> done was refused with ${refused.rule}, expected ST-9`);
  }
  console.log(`OK: task_move — todo -> done refused with ${refused.rule}`);

  // --- a commit lands in git ---------------------------------------------
  writeFileSync(join(dir, 'greeting.txt'), 'hello\n', 'utf-8');
  const committed = await client.call('git_commit', {
    message: 'feat: add the greeting',
    include_untracked: true,
  });
  if (!committed.commit_hash) fail(`git_commit returned no hash: ${JSON.stringify(committed)}`);
  const subject = git(['log', '-1', '--pretty=%s'], dir).trim();
  if (subject !== 'feat: add the greeting') {
    fail(`the commit landed with the subject '${subject}'`);
  }
  const tracked = git(['ls-files'], dir).split('\n').map((l) => l.trim());
  if (!tracked.includes('greeting.txt')) fail('the untracked file was not committed');
  console.log(`OK: git_commit — ${committed.commit_hash.slice(0, 8)} "${subject}"`);

  // --- a protected branch refuses a push --------------------------------
  const pushed = await client.call('git_operate', {
    operation: 'push',
    args: { branch: 'main', remote: 'origin' },
  });
  if (pushed.denied !== true) {
    fail(`a push to main was not denied: ${JSON.stringify(pushed)}`);
  }
  if (pushed.rule !== 'PR-16') {
    fail(`a push to main was denied with ${pushed.rule}, expected PR-16`);
  }
  console.log(`OK: git_operate — push to main denied with ${pushed.rule}`);

  // --- a protected branch refuses a PR -----------------------------------
  const pr = await client.call('open_pr', {
    title: 'Add the greeting',
    body: 'A pull request that must not be opened from main.',
    base: 'main',
    dry_run: true,
  });
  if (pr.denied !== true && pr.gated !== true) {
    fail(`a pull request from main was not refused: ${JSON.stringify(pr)}`);
  }
  console.log(`OK: open_pr — a pull request from main is refused`);

  // --- the task can now be completed -------------------------------------
  git(['checkout', '-q', '-b', 'feat/greeting'], dir);
  writeFileSync(join(dir, 'greeting.txt'), 'hello again\n', 'utf-8');
  git(['add', '--', 'greeting.txt'], dir);
  git(['commit', '-q', '-m', 'feat: extend the greeting'], dir);

  const moved = await client.call('task_move', {
    id: created.id,
    to: 'in_progress',
  });
  if (moved.applied !== true) fail(`todo -> in_progress was not applied: ${JSON.stringify(moved)}`);

  const done = await client.call('task_move', {
    id: created.id,
    to: 'done',
  });
  if (done.gated !== true) {
    fail(`in_progress -> done was not gated: ${JSON.stringify(done)}`);
  }
  if (done.gate !== 'PR-3') {
    fail(`in_progress -> done was gated on ${done.gate}, expected PR-3`);
  }
  console.log(`OK: task_move — in_progress -> done gated on ${done.gate}`);

  // --- the board records the history -------------------------------------
  const finalBoard = JSON.parse(readFileSync(state.board, 'utf-8'));
  const task = finalBoard.tasks.find((t) => t.id === created.id);
  if (!task) fail('the task vanished from the board');
  if (task.history.length < 2) fail(`the task has ${task.history.length} history entries, expected 2`);
  console.log(`OK: the board — ${task.history.length} history entries`);

  // --- a policy file tightens a rule and the tools honour it -------------
  const policyPath = join(dir, '.orchestrator', 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      schema_version: 1,
      default_branch: 'main',
      protected_branches: ['main', 'release/*'],
      allowed_merge_strategies: ['merge', 'rebase'],
      commit_message_pattern: '^(feat|fix|chore): .+',
      deny: ['PR-5'],
    }),
    'utf-8',
  );

  const policy = await client.call('policy_get', {});
  if (policy.source !== 'file') fail(`the policy file was not picked up: ${JSON.stringify(policy)}`);
  if (!Array.isArray(policy.overrides) || !policy.overrides.includes('PR-5')) {
    fail(`the policy file did not override PR-5: ${JSON.stringify(policy.overrides)}`);
  }

  // PR-5 is `git.status`. Tightening it to `deny` must stop the tool.
  const status = await client.call('git_status', {});
  if (status.denied !== true) {
    fail(`a tightened rule did not stop git_status: ${JSON.stringify(status)}`);
  }
  if (status.rule !== 'PR-5') {
    fail(`git_status was denied with ${status.rule}, expected PR-5`);
  }
  console.log('OK: policy_get — a policy file tightens PR-5 and git_status is denied');

  // --- a broken policy file is an error, not a silent fallback -----------
  writeFileSync(policyPath, '{not json', 'utf-8');
  const broken = await client.call('policy_get', {});
  if (!broken.error) fail(`a broken policy file was not reported: ${JSON.stringify(broken)}`);
  if (broken.source !== 'default') {
    fail(`a broken policy file fell back to ${broken.source}, expected 'default' with an error`);
  }
  writeFileSync(
    policyPath,
    JSON.stringify({
      schema_version: 1,
      default_branch: 'main',
      protected_branches: ['main'],
      allowed_merge_strategies: ['merge'],
      commit_message_pattern: '^(feat|fix|chore): .+',
      deny: [],
    }),
    'utf-8',
  );
  console.log('OK: policy_get — a broken policy file is reported, not silently ignored');

  // --- plan_from_commits proposes without writing ------------------------
  const proposed = await client.call('plan_from_commits', {
    branch: 'feat/greeting',
    base: 'main',
  });
  if (!Array.isArray(proposed.proposed) || proposed.proposed.length === 0) {
    fail(`plan_from_commits proposed nothing: ${JSON.stringify(proposed)}`);
  }
  if ((proposed.created ?? []).length !== 0) {
    fail('plan_from_commits created tasks without being asked');
  }
  const beforePlan = JSON.parse(readFileSync(state.board, 'utf-8'));
  if (beforePlan.tasks.length !== 1) fail('plan_from_commits changed the board');
  console.log(`OK: plan_from_commits — ${proposed.proposed.length} proposal(s), nothing written`);

  // --- a delete needs a confirmation, and retires the id ------------------
  const created2 = await client.call('task_create', { title: 'A throwaway task' });
  const unconfirmed = await client.call('task_delete', { id: created2.id });
  if (unconfirmed.gated !== true) {
    fail(`a delete without a confirmation was not gated: ${JSON.stringify(unconfirmed)}`);
  }
  if (unconfirmed.gate !== 'PR-37') {
    fail(`a delete was gated on ${unconfirmed.gate}, expected PR-37`);
  }

  const deleted = await client.call('task_delete', { id: created2.id, confirm: true });
  if (deleted.deleted !== 1) fail(`the delete did not happen: ${JSON.stringify(deleted)}`);

  const afterDelete = JSON.parse(readFileSync(state.board, 'utf-8'));
  if (afterDelete.tasks.length !== 1) fail('the delete did not remove the task');
  if (!Array.isArray(afterDelete.retired_ids) || !afterDelete.retired_ids.includes(created2.id)) {
    fail(`the deleted id was not retired: ${JSON.stringify(afterDelete.retired_ids)}`);
  }

  const recreated = await client.call('task_create', { title: 'A new task' });
  if (recreated.id === created2.id) {
    fail(`a retired id was reused: ${recreated.id}`);
  }
  console.log(`OK: task_delete — gated without confirm, and the id is retired (${created2.id} not reused)`);

  // --- two writers at once: no lost update ------------------------------
  // The board is shared state, so two agents writing it at the same
  // moment is the normal case. The writes are serialized by a lock, so
  // the second writer reads the board the first one left and builds on
  // it. Nothing is lost: the history records both changes.
  const [writerA, writerB] = await Promise.all([
    client.call('task_update', { id: created.id, title: 'Written by A' }),
    client.call('task_update', { id: created.id, title: 'Written by B' }),
  ]);

  if (writerA.applied !== true || writerB.applied !== true) {
    fail(
      'a concurrent write was refused even though it should have been serialized: ' +
        JSON.stringify({ writerA, writerB }),
    );
  }

  const raced = JSON.parse(readFileSync(state.board, 'utf-8'));
  const racedTask = raced.tasks.find((t) => t.id === created.id);
  if (racedTask.title !== 'Written by A' && racedTask.title !== 'Written by B') {
    fail(`the board holds neither writer's title: '${racedTask.title}'`);
  }
  // Both changes are in the history, so neither writer's work was lost.
  const updateNotes = racedTask.history.filter((h) => h.note === 'updated title');
  if (updateNotes.length < 2) {
    fail(
      `the history records ${updateNotes.length} update(s); both writers' changes should be there`,
    );
  }
  console.log(
    `OK: two concurrent writes — both applied, both in the history (${updateNotes.length} updates, no lost update)`,
  );

  // --- the new board fields -----------------------------------------------
  // The parent, the priority and the locks are optional fields, and
  // optional fields are the ones that get stripped by a schema that
  // does not know them. So the e2e writes them and reads them back.
  const parentTask = await client.call('task_create', {
    title: 'A parent task',
    priority: 5,
    locks: ['src/parent.ts'],
  });
  const childTask = await client.call('task_create', {
    title: 'A child task',
    parent: parentTask.id,
    priority: 9,
  });
  const fieldsBoard = JSON.parse(readFileSync(state.board, 'utf-8'));
  const childOnDisk = fieldsBoard.tasks.find((t) => t.id === childTask.id);
  if (childOnDisk.parent !== parentTask.id) {
    fail(`the parent did not survive the round trip: ${JSON.stringify(childOnDisk.parent)}`);
  }
  if (childOnDisk.priority !== 9) {
    fail(`the priority did not survive the round trip: ${JSON.stringify(childOnDisk.priority)}`);
  }
  const parentOnDisk = fieldsBoard.tasks.find((t) => t.id === parentTask.id);
  if (!Array.isArray(parentOnDisk.locks) || parentOnDisk.locks[0] !== 'src/parent.ts') {
    fail(`the locks did not survive the round trip: ${JSON.stringify(parentOnDisk.locks)}`);
  }
  console.log('OK: board fields — parent, priority and locks survive the round trip');

  // --- a claim cycle ------------------------------------------------------
  // Claim, heartbeat, release. The claim is a lease, and the lease is
  // visible on the task.
  const claimed = await client.call('task_claim', {
    id: childTask.id,
    agent: 'agent-a',
    lease_seconds: 120,
  });
  if (claimed.claimed !== true) {
    fail(`the claim was not taken: ${JSON.stringify(claimed)}`);
  }
  if (!claimed.claim?.lease_expires_at) {
    fail(`the claim has no lease: ${JSON.stringify(claimed)}`);
  }

  // A second agent may not take a live claim.
  const stolen = await client.call('task_claim', {
    id: childTask.id,
    agent: 'agent-b',
  });
  if (stolen.gated !== true && stolen.claimed !== false) {
    fail(`a second agent took a live claim: ${JSON.stringify(stolen)}`);
  }

  const released = await client.call('task_claim', {
    id: childTask.id,
    agent: 'agent-a',
    action: 'release',
  });
  if (released.released !== 1) {
    fail(`the claim was not released: ${JSON.stringify(released)}`);
  }
  if (released.task?.claim !== null) {
    fail(`the released task still holds a claim: ${JSON.stringify(released.task.claim)}`);
  }
  console.log('OK: task_claim — claim, a refused second claim, and a release');

  // --- a note, and a retry that does not duplicate it ---------------------
  // A note without a key is appended every time. A note *with* a key is
  // appended once: the retry finds the note that key made and returns
  // it instead of appending a second copy.
  const noted = await client.call('task_note', {
    id: childTask.id,
    text: 'A note from the e2e run.',
    actor: 'e2e',
    idempotency_key: 'e2e-note-1',
  });
  if (!Array.isArray(noted.notes) || noted.notes.length !== 1) {
    fail(`the note was not appended: ${JSON.stringify(noted)}`);
  }
  const notedAgain = await client.call('task_note', {
    id: childTask.id,
    text: 'A note from the e2e run.',
    actor: 'e2e',
    idempotency_key: 'e2e-note-1',
  });
  if (notedAgain.notes_added !== 0) {
    fail(`a retried note was appended again: ${JSON.stringify(notedAgain)}`);
  }
  if (!Array.isArray(notedAgain.notes) || notedAgain.notes.length !== 1) {
    fail(`a retried note left ${notedAgain.notes?.length} notes on the task, expected 1`);
  }
  console.log('OK: task_note — a note is appended, and a keyed retry is not');

  // --- next-work selection ------------------------------------------------
  // The next task is the one with the highest priority that is not
  // blocked and not claimed by somebody else.
  const next = await client.call('task_next', {});
  if (!next.next) {
    fail(`task_next found nothing: ${JSON.stringify(next)}`);
  }
  if (next.next.id !== childTask.id) {
    fail(`task_next chose ${next.next.id}, expected the highest-priority task ${childTask.id}`);
  }
  console.log(`OK: task_next — chose ${next.next.id}, the highest-priority unclaimed task`);

  // --- combining branches -------------------------------------------------
  // Two branches that touch the same file conflict, and the tool names
  // the conflicting path.
  git(['checkout', '-q', '-b', 'side-a', 'main'], dir);
  writeFileSync(join(dir, 'shared.txt'), 'from a\n', 'utf-8');
  git(['add', '--', 'shared.txt'], dir);
  git(['commit', '-q', '-m', 'feat: change the shared file from a'], dir);
  git(['checkout', '-q', '-b', 'side-b', 'main'], dir);
  writeFileSync(join(dir, 'shared.txt'), 'from b\n', 'utf-8');
  git(['add', '--', 'shared.txt'], dir);
  git(['commit', '-q', '-m', 'feat: change the shared file from b'], dir);
  git(['checkout', '-q', 'main'], dir);

  const combined = await client.call('git_combine', { branches: ['main', 'side-a', 'side-b'] });
  if (combined.combined !== false) {
    fail(`two conflicting branches combined cleanly: ${JSON.stringify(combined)}`);
  }
  if (!Array.isArray(combined.conflicts) || !combined.conflicts.includes('shared.txt')) {
    fail(`the conflicting path was not reported: ${JSON.stringify(combined.conflicts)}`);
  }
  // Nothing was merged.
  if (existsSync(join(dir, 'shared.txt'))) {
    fail('git_combine left a merged file in the working tree');
  }
  console.log(`OK: git_combine — reports the conflict on ${combined.conflicts.join(', ')}`);

  // --- a worktree outside the repository ---------------------------------
  const worktreePath = `${dir}-worktree`;
  const worktree = await client.call('git_worktree', {
    action: 'add',
    path: worktreePath,
    branch: 'side-a',
  });
  if (!worktree.applied) {
    fail(`the worktree was not added: ${JSON.stringify(worktree)}`);
  }
  if (!existsSync(worktreePath)) fail('the worktree directory does not exist');
  const listed = await client.call('git_worktree', { action: 'list' });
  if (!Array.isArray(listed.worktrees) || listed.worktrees.length < 2) {
    fail(`the worktree was not listed: ${JSON.stringify(listed)}`);
  }
  rmSync(worktreePath, { recursive: true, force: true });
  console.log('OK: git_worktree — a worktree is added outside the repository and listed');

  // --- stdout carried nothing but protocol -------------------------------
  for (const line of client.stdoutLines) {
    try {
      JSON.parse(line);
    } catch {
      fail(`stdout carried a line that is not JSON: ${line}`);
    }
  }
  console.log(`OK: stdout — ${client.stdoutLines.length} protocol messages, nothing else`);

  console.log('');
  console.log('E2E: PASS');
  child.stdin.end();
  cleanup();
  process.exit(0);
} catch (e) {
  if (stderr) console.error(`--- server stderr ---\n${stderr}`);
  fail(e instanceof Error ? e.message : String(e));
}
