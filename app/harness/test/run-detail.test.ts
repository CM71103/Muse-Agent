import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-rundetail-home-'));
process.env.MUSE_HOME = home;
const session = require('../session');
const runLog = require('../run-log');
const { Agent } = require('../agent');
const { DEFAULTS, deepMerge } = require('../config');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const cfg = () => deepMerge(DEFAULTS, { llm: { max_tokens: 100 }, agent: { max_turns: 6 }, sentinel: { mode: 'ask', deny_rules: [] } });

test('a finished run records what it read and wrote, its tokens and its status', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-rundetail-work-'));
  fs.writeFileSync(path.join(work, 'a.js'), 'const one = 1;\n');
  const events: any[] = [];
  const agent = new Agent(cfg(), { approver: async () => true, onEvent: (ev: any) => events.push(ev) });
  agent.cwdOverride = work;

  let requests = 0;
  agent.llm.chat = async () => {
    requests++;
    if (requests === 1) {
      return {
        message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) } }] },
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
    }
    if (requests === 2) {
      return {
        message: { content: null, tool_calls: [{ id: 'c2', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out/b.txt', content: 'hi\n' }) } }] },
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
    }
    return { message: { content: 'Done.' }, finish_reason: 'stop', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
  };

  const res = await agent.run('Trim a.js and add b.txt');
  assert.equal(res.text, 'Done.');
  assert.equal(res.usage.total_tokens, 23);

  const receipts = session.load(agent.sessionId).receipts;
  const accepted = receipts.find((r: any) => r.status === 'run_accepted');
  const finished = receipts.find((r: any) => r.status === 'run_finished');
  assert.equal(accepted.request, 'Trim a.js and add b.txt');
  assert.equal(finished.outcome, 'complete');
  assert.equal(finished.usage.total_tokens, 23);
  assert.ok(finished.durationMs >= 0, 'duration is measured, not invented');
  assert.deepEqual(finished.files.read, ['a.js']);
  assert.deepEqual(finished.files.written.map((w: any) => w.path), ['out/b.txt']);
  const written = finished.files.written[0];
  const onDisk = crypto.createHash('sha256').update(fs.readFileSync(path.join(work, 'out/b.txt'))).digest('hex');
  assert.equal(written.hash, onDisk, 'the receipt pins the state the file was left in');

  const done = events.find((e: any) => e.type === 'done');
  assert.equal(done.outcome, 'complete');
  assert.equal(done.request, 'Trim a.js and add b.txt');
  assert.deepEqual(done.files.read, ['a.js']);
  assert.deepEqual(done.files.written, [{ path: 'out/b.txt', hash: onDisk, existed: false }]);
  assert.equal(typeof done.durationMs, 'number');

  // What the ledger pane reads back: the same run, from disk.
  const [run] = runLog.runsFromReceipts(session.load(agent.sessionId).receipts);
  assert.equal(run.runId, finished.runId);
  assert.equal(run.interrupted, false);
  assert.equal(run.outcome, 'complete');
  assert.deepEqual(run.files.written.map((w: any) => w.path), ['out/b.txt']);
  fs.rmSync(work, { recursive: true, force: true });
});

test('a cancelled run closes its record as cancelled with the writes it made', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-rundetail-cancel-'));
  const events: any[] = [];
  const agent = new Agent(cfg(), { approver: async () => true, onEvent: (ev: any) => events.push(ev) });
  agent.cwdOverride = work;
  let calls = 0;
  agent.llm.chat = async () => {
    if (calls++ === 0) {
      return {
        message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'keep.txt', content: 'partial' }) } }] },
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    return { message: { content: 'should not finish' }, finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  };
  const running = agent.run('write something');
  setTimeout(() => agent.requestCancel(), 5);
  await running;

  const receipts = session.load(agent.sessionId).receipts;
  const finished = receipts.find((r: any) => r.status === 'run_finished');
  assert.equal(finished.outcome, 'cancelled');
  assert.deepEqual(finished.files.written.map((w: any) => w.path), ['keep.txt']);
  const done = events.find((e: any) => e.type === 'done');
  assert.equal(done.reason, 'cancelled');
  assert.equal(done.outcome, 'cancelled');
  fs.rmSync(work, { recursive: true, force: true });
});
