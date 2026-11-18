import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-receipts-home-'));
process.env.MUSE_HOME = home;
const session = require('../session');
const { Agent } = require('../agent');
const { DEFAULTS, deepMerge } = require('../config');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const cfg = () => deepMerge(DEFAULTS, { llm: { max_tokens: 100 }, agent: { max_turns: 5 }, sentinel: { mode: 'ask', deny_rules: [] } });

// --- run receipts (crash-safe resume) ---

test('run() writes accepted + finished receipts with usage in the result', async () => {
  const agent = new Agent(cfg(), { approver: async () => true });
  agent.llm.chat = async () => ({ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  const res = await agent.run('hello', { commandId: 'cmd-r1' });
  assert.equal(res.text, 'hi');
  assert.equal(res.usage.total_tokens, 5);
  const receipts = session.load(agent.sessionId).receipts;
  assert.deepEqual(receipts.map(r => r.status), ['run_accepted', 'run_finished']);
  assert.equal(receipts[0].commandId, 'cmd-r1');
  assert.equal(receipts[1].outcome, 'complete');
});

test('an interrupted run is detected on restore and a closed one is not', async () => {
  const c = cfg();
  const id = session.newId();
  session.save({ id, history: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'partial work' }] });
  session.appendReceipt(id, { runId: 'run-1', commandId: 'cmd-1', status: 'run_accepted' });

  const agent = new Agent(c, { approver: async () => true });
  await agent.restore(id);
  assert.ok(agent.interruptedRun, 'dangling accept must surface as an interrupted run');
  assert.equal(agent.interruptedRun.runId, 'run-1');

  // a later finished receipt closes run-1: restore sees a clean session again
  session.appendReceipt(id, { runId: 'run-1', status: 'run_finished', outcome: 'complete' });
  const agent2 = new Agent(c, { approver: async () => true });
  await agent2.restore(id);
  assert.equal(agent2.interruptedRun, null);
});

// --- agent:send: queue_after_active + idempotent dispatch ---

function loadSendHandler(shim: Record<string, any>) {
  const source = fs.readFileSync(path.join(__dirname, '../../main/index.js'), 'utf8');
  const body = source.match(/ipcMain\.handle\('agent:send', async \(e, text, commandId\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(body, 'agent:send handler must be extractable');
  return vm.runInNewContext(`(async(e,text,commandId)=>{${body[1]}})`, shim);
}

function queueShim(agentStub: any) {
  const calls: any[] = [];
  const gates: Array<() => void> = [];
  const shim: any = {
    agent: agentStub, agentBusy: false, requireTrusted: () => {}, currentProjectId: null,
    projectStore: { get: () => null }, send: () => {}, refreshBoxTools: () => {},
    learningService: { touch: () => {}, flush: async () => {} },
    setBusyState: (busy: boolean) => { shim.agentBusy = busy; },
    turnQueue: [], completedCommands: new Map(), queueState: () => ({ items: [], running: false }),
    require: (name: string) => {
      if (name === '../harness/turns') return {
        runTurn: ({ raw, commandId }: any) => new Promise(resolve => {
          calls.push({ raw, commandId });
          gates.push(() => resolve({ text: 'done:' + raw, turns: 1, usage: { total_tokens: 1 } }));
        }),
        resetAgent: () => {},
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  return { shim, calls, gates };
}

test('messages sent while a run is active queue in order and drain after it settles', async () => {
  const { shim, calls, gates } = queueShim({ lastMemoryTurnId: null });
  const send = loadSendHandler(shim);
  const p1 = send({}, 'first');                       // starts running immediately
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);

  const q2 = await send({}, 'second');                // queued behind the active run
  assert.equal(q2.queued, true);
  assert.equal(q2.position, 1);
  const q3 = await send({}, 'third', 'cmd-3');
  assert.equal(q3.queued, true);
  assert.equal(q3.position, 2);
  // re-sending a queued command is idempotent: same slot, no duplicate
  const q3again = await send({}, 'third', 'cmd-3');
  assert.equal(q3again.queued, true);
  assert.equal(q3again.position, 2);
  assert.equal(shim.turnQueue.length, 2);

  gates.shift()!();                                   // first run settles -> drain runs second, third in order
  await new Promise(r => setImmediate(r));
  gates.shift()!();
  await new Promise(r => setImmediate(r));
  gates.shift()!();
  const res1 = await p1;                              // resolves only after the whole drain
  assert.equal(res1.text, 'done:first');
  assert.deepEqual(calls.map(c => c.raw), ['first', 'second', 'third']);
  assert.equal(shim.turnQueue.length, 0, 'queue drains to empty');
});

test('a completed commandId is acknowledged, never executed twice', async () => {
  const { shim, calls, gates } = queueShim({ lastMemoryTurnId: null });
  const send = loadSendHandler(shim);
  const p1 = send({}, 'build it', 'cmd-x');
  await new Promise(r => setImmediate(r));
  gates.shift()!();
  const res = await p1;
  assert.equal(res.ok, true);

  const again = await send({}, 'build it', 'cmd-x');
  assert.equal(again.deduped, true);
  assert.equal(calls.length, 1, 'the recorded receipt must prevent a second execution');
});
