'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const runLog = require('../run-log');

const CWD = path.join(path.sep, 'work', 'project');

test('file tools are noted once, project-relative inside and absolute outside', () => {
  const touched = runLog.fresh();
  runLog.recordFile(touched, 'read_file', CWD, path.join(CWD, 'src', 'app.js'));
  runLog.recordFile(touched, 'read_file', CWD, path.join(CWD, 'src', 'app.js'));
  runLog.recordFile(touched, 'read_file', CWD, path.join(CWD, 'README.md'));
  runLog.recordFile(touched, 'write_file', CWD, path.join(CWD, 'src', 'app.js'));
  runLog.recordFile(touched, 'read_file', CWD, path.join(path.sep, 'etc', 'hosts'));
  runLog.recordFile(touched, 'list_dir', CWD, path.join(CWD, 'src'));

  assert.deepEqual(touched.read, ['src/app.js', 'README.md', '/etc/hosts']);
  assert.deepEqual(touched.written, [{ path: 'src/app.js', hash: null }]);
});

test('the checkpoint supplies the hash each written file was left in', () => {
  const touched = runLog.fresh();
  runLog.recordFile(touched, 'write_file', CWD, path.join(CWD, 'notes.md'));
  runLog.mergeCheckpoint(touched, [
    { path: path.join(CWD, 'notes.md'), afterHash: 'abc123', existed: true },
    { path: path.join(CWD, 'shell-made.txt'), afterHash: 'def456', existed: false },
  ], CWD);

  assert.deepEqual(touched.written, [
    { path: 'notes.md', hash: 'abc123', existed: true },
    { path: 'shell-made.txt', hash: 'def456', existed: false },
  ]);
});

test('path lists stop at the cap instead of growing without bound', () => {
  const touched = runLog.fresh();
  for (let i = 0; i < runLog.MAX_PATHS + 5; i++) {
    runLog.recordFile(touched, 'read_file', CWD, path.join(CWD, 'f' + i + '.js'));
  }
  assert.equal(touched.read.length, runLog.MAX_PATHS);
  assert.equal(touched.truncated, true);
});

test('a run record carries duration, tokens, status and the files it touched', () => {
  const touched = runLog.fresh();
  runLog.recordFile(touched, 'read_file', CWD, path.join(CWD, 'a.js'));
  runLog.recordFile(touched, 'write_file', CWD, path.join(CWD, 'b.js'));
  const record = runLog.runRecord({
    runId: 'run-1',
    request: '  fix   the\nlogin form  ',
    startedAt: '2026-11-27T10:00:00.000Z',
    endedAt: '2026-11-27T10:00:42.000Z',
    outcome: 'complete',
    turns: 3,
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
    toolErrors: 1,
    touched,
  });

  assert.equal(record.request, 'fix the login form');
  assert.equal(record.durationMs, 42000);
  assert.equal(record.turns, 3);
  assert.equal(record.toolErrors, 1);
  assert.deepEqual(record.usage, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 });
  assert.deepEqual(record.files.read, ['a.js']);
  assert.deepEqual(record.files.written, [{ path: 'b.js', hash: null, existed: true }]);
});

test('an empty usage object is recorded as no tokens, not as zero tokens', () => {
  const record = runLog.runRecord({ runId: 'run-2', usage: {}, tokensMissing: true });
  assert.equal(record.usage, null);
  assert.equal(record.tokensMissing, true);
  assert.equal(record.durationMs, null);
});

test('receipts replay into runs: paired finish wins, a dangling accept is interrupted, newest first', () => {
  const runs = runLog.runsFromReceipts([
    { kind: 'receipt', status: 'run_accepted', runId: 'r1', ts: '2026-11-27T09:00:00.000Z', request: 'first ask' },
    { kind: 'receipt', status: 'run_finished', runId: 'r1', ts: '2026-11-27T09:01:00.000Z', outcome: 'complete', durationMs: 60000, usage: { total_tokens: 10 }, turns: 2, files: { read: ['a.js'], written: [{ path: 'b.js', hash: 'h1' }] } },
    { kind: 'receipt', status: 'run_accepted', runId: 'r2', ts: '2026-11-27T09:30:00.000Z', request: 'second ask' },
    { kind: 'receipt', status: 'approval', runId: 'r2', ts: '2026-11-27T09:31:00.000Z' },
  ]);

  assert.deepEqual(runs.map(r => r.runId), ['r2', 'r1']);
  const [second, first] = runs;
  assert.equal(second.interrupted, true);
  assert.equal(second.outcome, 'interrupted');
  assert.equal(second.request, 'second ask');
  assert.equal(first.interrupted, false);
  assert.equal(first.durationMs, 60000);
  assert.deepEqual(first.files.read, ['a.js']);
  assert.deepEqual(first.files.written, [{ path: 'b.js', hash: 'h1', existed: true }]);
});

test('a request line comes from text, or from a multimodal message with images marked', () => {
  assert.equal(runLog.clipRequest('hello', null), 'hello');
  assert.equal(runLog.clipRequest(null, [{ type: 'text', text: 'look at this' }, { type: 'image' }]), 'look at this [image]');
  assert.equal(runLog.clipRequest('x'.repeat(300), null).length, 160);
  assert.equal(runLog.clipRequest(null, null), '');
});
