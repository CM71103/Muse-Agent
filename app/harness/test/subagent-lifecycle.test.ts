import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../agent.js');
const { DEFAULTS } = require('../config.js');
const { mkSubagentTool, SUBAGENT_RESULT_CAP } = require('../subagent.js');

function mockRun(t: TestContext, run: (this: any, task: string) => Promise<object>) {
  const original = Agent.prototype.run;
  Agent.prototype.run = run;
  t.after(() => { Agent.prototype.run = original; });
}

function setup() {
  const events: any[] = [];
  const questions: any[] = [];
  const cfg = structuredClone(DEFAULTS);
  cfg.sentinel.mode = 'ask';
  cfg.sentinel.deny_rules = [];
  const parent = new Agent(cfg, {
    onEvent: (event: any) => events.push(event),
    questionAsker: async (question: any) => { questions.push(question); return { answer: 'fixture answer' }; },
    approver: async () => false,
  });
  return { parent, events, questions };
}

test('child lifecycle, forwarded events, questions and result share a stable UUID', async t => {
  const { parent, events, questions } = setup();
  const children = new Set();
  mockRun(t, async function (task) {
    assert.equal(this.sentinel, parent.sentinel);
    assert.equal(this.toolMap.has('spawn_agent'), false);
    assert.equal(children.has(this), true);
    this.events({ type: 'turn', turn: 0 });
    this.events({ type: 'message', text: 'child progress', subagentId: 'cannot override assigned ID' });
    assert.equal(await this.askUser('fixture question'), 'fixture answer');
    this.events({ type: 'done', reason: 'complete' });
    return { text: 'child summary', turns: 1 };
  });
  const result = await mkSubagentTool({ children }).run({ task: 'review fixture' }, { agent: parent });
  assert.equal(result.ok, true);
  assert.match(result.subagentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(children.size, 0);
  assert.equal(events[0].type, 'subagent_start');
  assert.equal(events[0].task, 'review fixture');
  assert.equal(events.at(-1).type, 'subagent_done');
  assert.equal(events.at(-1).result, 'child summary');
  assert.equal(events.at(-1).turns, 1);
  assert.equal(events.at(-1).cancelled, false);
  assert.equal(events.filter(event => event.type === 'subagent_done').length, 1);
  assert.ok(events.every(event => event.subagent === true && event.subagentId === result.subagentId));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].subagentId, result.subagentId);
  assert.equal(questions[0].subagent, true);
});

test('failed child emits one terminal lifecycle event and releases its live slot', async t => {
  const { parent, events } = setup();
  const children = new Set();
  mockRun(t, async function () {
    this.events({ type: 'turn', turn: 1 });
    throw new Error('fixture provider failure');
  });
  const result = await mkSubagentTool({ children }).run({ task: 'fixture failure' }, { agent: parent });
  assert.equal(result.ok, false);
  assert.match(result.error, /fixture provider failure/);
  assert.equal(children.size, 0);
  const done = events.filter(event => event.type === 'subagent_done');
  assert.equal(done.length, 1);
  assert.equal(done[0].subagentId, result.subagentId);
  assert.equal(done[0].turns, 2);
  assert.equal(done[0].error, result.error);
});

test('configuration failure after accepted start still emits one failed completion', async () => {
  const { parent, events } = setup();
  parent.cfg.circularFixture = parent.cfg;
  const result = await mkSubagentTool().run({ task: 'invalid config fixture' }, { agent: parent });
  assert.equal(result.ok, false);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'subagent_start');
  assert.equal(events[1].type, 'subagent_done');
  assert.equal(events[1].subagentId, events[0].subagentId);
  assert.match(events[1].error, /circular/i);
});

test('parent cancellation is reflected in the child terminal lifecycle', async t => {
  const { parent, events } = setup();
  mockRun(t, async function () {
    parent.requestCancel();
    assert.equal(this._cancelRequested, true);
    this.events({ type: 'done', reason: 'cancelled' });
    return { text: 'partial result', turns: 1, cancelled: true };
  });
  const result = await mkSubagentTool().run({ task: 'cancel fixture' }, { agent: parent });
  const done = events.filter(event => event.type === 'subagent_done');
  assert.equal(result.cancelled, true);
  assert.equal(done.length, 1);
  assert.equal(done[0].cancelled, true);
  assert.equal(done[0].result, 'partial result');
});

test('concurrent children have distinct IDs and keep events paired with their tasks', async t => {
  const { parent, events } = setup();
  const releases = new Map<string, () => void>();
  const children = new Set();
  mockRun(t, async function (task) {
    this.events({ type: 'message', text: task });
    await new Promise<void>(resolve => { releases.set(task, resolve); });
    return { text: `${task} complete`, turns: 1 };
  });
  const tool = mkSubagentTool({ children });
  const first = tool.run({ task: 'first' }, { agent: parent });
  const second = tool.run({ task: 'second' }, { agent: parent });
  const rejected = await tool.run({ task: 'third' }, { agent: parent });
  assert.equal(rejected.ok, false);
  assert.equal(events.filter(event => event.type === 'subagent_start').length, 2);
  releases.get('second')!();
  releases.get('first')!();
  const results = await Promise.all([first, second]);
  assert.notEqual(results[0].subagentId, results[1].subagentId);
  assert.equal(children.size, 0);
  for (let index = 0; index < results.length; index++) {
    const task = index ? 'second' : 'first';
    const own = events.filter(event => event.subagentId === results[index].subagentId);
    assert.equal(own[0].task, task);
    assert.equal(own.at(-1).result, `${task} complete`);
    assert.equal(own.filter(event => event.type === 'subagent_done').length, 1);
  }
});

test('rejected nested or cancelled-before-start children emit no started lifecycle', async () => {
  const { parent, events } = setup();
  assert.equal((await mkSubagentTool({ depth: 1 }).run({ task: 'nested' }, { agent: parent })).ok, false);
  assert.equal((await mkSubagentTool().run({ task: '  ' }, { agent: parent })).ok, false);
  parent._cancelRequested = true;
  assert.equal((await mkSubagentTool().run({ task: 'cancelled' }, { agent: parent })).ok, false);
  assert.equal(events.length, 0);
});

test('large child summaries are bounded in both tool result and lifecycle event', async t => {
  const { parent, events } = setup();
  mockRun(t, async function () { return { text: 'x'.repeat(SUBAGENT_RESULT_CAP + 10), turns: 1 }; });
  const result = await mkSubagentTool().run({ task: 'large fixture' }, { agent: parent });
  assert.equal(result.truncated, true);
  assert.equal(result.result.length, SUBAGENT_RESULT_CAP);
  assert.equal(events.at(-1).result, result.result);
});
