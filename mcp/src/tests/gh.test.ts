/**
 * The `gh` surface's tests.
 *
 * `open_pr` is the one tool that reaches the network, so the surface is
 * the place where "what can this server do to a forge" is answered. The
 * scan at the bottom is the important part: no merge, no close, no
 * delete, no comment, no review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GH_ARGV,
  buildPrCreate,
  buildPrList,
  buildPrView,
  ghEnv,
  parsePrList,
  parsePrUrl,
  runGh,
} from '../gh.js';

test('GH-01 is the plain pull-request create argv', () => {
  assert.deepEqual(GH_ARGV['GH-01'], [
    'pr',
    'create',
    '--title',
    '<title>',
    '--base',
    '<base>',
    '--head',
    '<branch>',
    '--body',
    '<body>',
  ]);
});

test('GH-02 is the draft pull-request create argv', () => {
  assert.ok(GH_ARGV['GH-02'].includes('--draft'));
});

test('the argv table has the expected ids', () => {
  assert.deepEqual(Object.keys(GH_ARGV).sort(), ['GH-01', 'GH-02', 'GH-03', 'GH-04']);
});

test('every argv constant is a non-empty array of strings', () => {
  for (const [id, argv] of Object.entries(GH_ARGV)) {
    assert.ok(Array.isArray(argv), `${id} is not an array`);
    assert.ok(argv.length > 0, `${id} is empty`);
    for (const part of argv) {
      assert.equal(typeof part, 'string', `${id} has a non-string element`);
    }
  }
});

test('the create builder produces the plain form', () => {
  const argv = buildPrCreate({ title: 'T', body: 'B', base: 'main', branch: 'feat/x' });
  assert.deepEqual(argv, ['pr', 'create', '--title', 'T', '--base', 'main', '--head', 'feat/x', '--body', 'B']);
});

test('the create builder puts --draft before --title', () => {
  const argv = buildPrCreate({ title: 'T', body: 'B', base: 'main', branch: 'feat/x', draft: true });
  assert.equal(argv[1], '--draft');
  assert.ok(argv.includes('--title'));
});

test('the list builder names the branch', () => {
  assert.deepEqual(buildPrList('feat/x'), ['pr', 'list', '--head', 'feat/x', '--json', 'number,url,state']);
});

test('the view builder asks for the fields the server reads', () => {
  assert.deepEqual(buildPrView(), ['pr', 'view', '--json', 'number,url,state,title']);
});

test('the environment disables colour and prompting', () => {
  const env = ghEnv();
  assert.equal(env['NO_COLOR'], '1');
  assert.equal(env['GH_PROMPT_DISABLED'], '1');
  assert.equal(env['GH_PAGER'], 'cat');
  assert.equal(env['PAGER'], 'cat');
});

test('parsePrList reads the fields gh reports', () => {
  const stdout = JSON.stringify([{ number: 12, url: 'https://example.test/pr/12', state: 'OPEN' }]);
  const prs = parsePrList(stdout);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].number, 12);
  assert.equal(prs[0].url, 'https://example.test/pr/12');
  assert.equal(prs[0].state, 'OPEN');
});

test('parsePrList treats malformed output as no pull requests', () => {
  assert.deepEqual(parsePrList('not json'), []);
  assert.deepEqual(parsePrList('{"not":"an array"}'), []);
});

test('parsePrList skips entries that are not objects', () => {
  const stdout = JSON.stringify([null, 'nope', { number: 3, url: 'u', state: 'OPEN' }]);
  const prs = parsePrList(stdout);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].number, 3);
});

test('parsePrUrl finds the URL gh printed', () => {
  const stdout = 'Creating pull request for feat/x on GitHub\nhttps://github.test/o/r/pull/7\n';
  assert.equal(parsePrUrl(stdout), 'https://github.test/o/r/pull/7');
});

test('parsePrUrl returns null when there is no URL', () => {
  assert.equal(parsePrUrl('nothing to see here'), null);
});

test('a failing gh call returns the exit code and does not throw', () => {
  const result = runGh(['pr', 'view', '--json', 'number'], process.cwd());
  assert.equal(result.status, 'error');
  assert.notEqual(result.exit_code, 0);
  assert.ok(result.stderr.length > 0);
});

test('the runner reports the argv it used', () => {
  const result = runGh(['pr', 'list', '--head', 'x', '--json', 'number'], process.cwd());
  assert.equal(result.argv[0], 'gh');
  assert.equal(result.argv[1], 'pr');
});

// --------------------------------------------------------------------------
// The surface scan -- the most important assertions in this file.
// --------------------------------------------------------------------------

test('the surface cannot merge a pull request', () => {
  for (const argv of Object.values(GH_ARGV)) {
    assert.ok(!argv.includes('merge'), `found a merge in ${argv.join(' ')}`);
  }
});

test('the surface cannot close or delete a pull request', () => {
  for (const argv of Object.values(GH_ARGV)) {
    assert.ok(!argv.includes('close'), `found a close in ${argv.join(' ')}`);
    assert.ok(!argv.includes('delete'), `found a delete in ${argv.join(' ')}`);
  }
});

test('the surface cannot comment, review or approve', () => {
  for (const argv of Object.values(GH_ARGV)) {
    for (const verb of ['comment', 'review', 'approve', 'label', 'edit']) {
      assert.ok(!argv.includes(verb), `found '${verb}' in ${argv.join(' ')}`);
    }
  }
});

test('no argv runs a shell', () => {
  for (const argv of Object.values(GH_ARGV)) {
    for (const part of argv) {
      assert.ok(!part.includes('&&'), `found a shell operator in ${argv.join(' ')}`);
      assert.ok(!part.includes('|'), `found a pipe in ${argv.join(' ')}`);
      assert.ok(!part.includes(';'), `found a semicolon in ${argv.join(' ')}`);
      assert.ok(!part.includes('`'), `found a backtick in ${argv.join(' ')}`);
      assert.ok(!part.includes('$'), `found a dollar sign in ${argv.join(' ')}`);
    }
  }
});

test('every argv starts with the pr verb', () => {
  for (const argv of Object.values(GH_ARGV)) {
    assert.equal(argv[0], 'pr', `${argv.join(' ')} does not start with 'pr'`);
  }
});
