import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../agent.js');
const { Sentinel, canonicalPath } = require('../sentinel.js');
const { DEFAULTS } = require('../config.js');
const { mkSubagentTool } = require('../subagent.js');

function fixture(t: TestContext) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-boundary-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project');
  const outside = path.join(temp, 'outside');
  const second = path.join(temp, 'second');
  for (const dir of [root, outside, second]) fs.mkdirSync(dir);
  for (const dir of [outside, second]) fs.writeFileSync(path.join(dir, 'fixture.txt'), 'private fixture');
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, outside, second, link };
}

function config(mode = 'ask') {
  const cfg = structuredClone(DEFAULTS);
  cfg.sentinel.mode = mode;
  cfg.sentinel.deny_rules = [];
  return cfg;
}

async function call(agent: any, name: string, args: object) {
  return JSON.parse(await agent.executeToolCall({
    id: 'boundary', function: { name, arguments: JSON.stringify(args) },
  }));
}

test('junction reads and listings outside the project require approval', async t => {
  const f = fixture(t);
  const requests: any[] = [];
  const agent = new Agent(config(), { approver: async (request: any) => { requests.push(request); return false; } });
  agent.setProjectScope(f.root);
  assert.equal((await call(agent, 'read_file', { path: 'link/fixture.txt' })).ok, false);
  assert.equal((await call(agent, 'list_dir', { path: 'link' })).ok, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].resolvedPath, canonicalPath(path.join(f.outside, 'fixture.txt')));
});

for (const mode of ['accept_edits']) {
  test(`${mode}: new nested writes through a junction cannot escape approval`, async t => {
    const f = fixture(t);
    let approvals = 0;
    const agent = new Agent(config(mode), { approver: async () => { approvals++; return false; } });
    agent.setProjectScope(f.root);
    assert.equal((await call(agent, 'write_file', { path: 'link/new/sub/file.txt', content: 'must not write' })).ok, false);
    assert.equal(approvals, 1);
    assert.equal(fs.existsSync(path.join(f.outside, 'new')), false);
    assert.equal((await call(agent, 'write_file', { path: 'new/sub/file.txt', content: 'in scope' })).ok, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'new/sub/file.txt'), 'utf8'), 'in scope');
  });
}

test('a selected project alias grants its canonical directory', async t => {
  const f = fixture(t);
  const agent = new Agent(config(), { approver: async () => { throw new Error('unexpected approval'); } });
  agent.setProjectScope(f.link);
  const result = await call(agent, 'read_file', { path: 'fixture.txt' });
  assert.equal(result.content, 'private fixture');
  assert.equal(result.path, canonicalPath(path.join(f.outside, 'fixture.txt')));
});

test('dangling junctions fail closed instead of becoming granted new paths', async t => {
  const f = fixture(t);
  fs.rmSync(f.outside, { recursive: true, force: true });
  const agent = new Agent(config('accept_edits'), { approver: async () => true });
  agent.setProjectScope(f.root);
  const result = await call(agent, 'write_file', { path: 'link/new.txt', content: 'must not write' });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot resolve tool path/);
  assert.equal(fs.existsSync(f.outside), false);
});

test('retargeting a junction while approval is pending denies the operation', async t => {
  const f = fixture(t);
  const agent = new Agent(config(), { approver: async () => {
    fs.unlinkSync(f.link);
    fs.symlinkSync(f.second, f.link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } });
  agent.setProjectScope(f.root);
  const result = await call(agent, 'read_file', { path: 'link/fixture.txt' });
  assert.equal(result.ok, false);
  assert.match(result.error, /destination changed/);
});

test('switching to plan during approval prevents tool execution', async () => {
  let release!: (approved: boolean) => void;
  const agent = new Agent(config(), { approver: () => new Promise<boolean>(resolve => { release = resolve; }) });
  let executed = false;
  agent.toolMap.set('shell', { run: async () => { executed = true; return { ok: true }; } });
  const pending = call(agent, 'shell', { command: 'fixture only' });
  agent.sentinel.setMode('plan');
  release(true);
  assert.equal((await pending).ok, false);
  assert.equal(executed, false);
});

test('new deny rules take precedence over pending approvals', async () => {
  let release!: (approved: boolean) => void;
  const sentinel = new Sentinel(config(), { approver: () => new Promise<boolean>(resolve => { release = resolve; }) });
  const pending = sentinel.gate({ tool: 'shell', args: { command: 'fixture' } });
  sentinel.denyRules.push('*fixture*');
  release(true);
  assert.equal((await pending).decision, 'deny');
});

test('canonical destination deny rules cannot be bypassed with an innocent alias', async t => {
  const f = fixture(t);
  const secret = path.join(f.root, 'secret');
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'fixture.txt'), 'denied fixture');
  fs.symlinkSync(secret, path.join(f.root, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  const cfg = config('auto');
  cfg.sentinel.deny_rules = ['*secret*'];
  let approvals = 0;
  const agent = new Agent(cfg, { approver: async () => { approvals++; return true; } });
  agent.setProjectScope(f.root);
  const result = await call(agent, 'read_file', { path: 'public/fixture.txt' });
  assert.equal(result.ok, false);
  assert.match(result.error, /matched deny rule/);
  assert.equal(approvals, 0);
});

test('original anchored deny rules still apply alongside canonical-path rules', () => {
  const cfg = config();
  cfg.sentinel.deny_rules = ['read_file {"path":"alias.txt"}'];
  const sentinel = new Sentinel(cfg);
  assert.equal(sentinel.decide({ tool: 'read_file', args: { path: 'alias.txt' }, resolvedPath: path.resolve('target.txt') }).decision, 'deny');
});

test('cancellation during pending approval prevents later approved shell execution', async () => {
  let release!: (approved: boolean) => void;
  const agent = new Agent(config(), { approver: () => new Promise<boolean>(resolve => { release = resolve; }) });
  let executed = false;
  agent.toolMap.set('shell', { run: async () => { executed = true; return { ok: true }; } });
  const pending = call(agent, 'shell', { command: 'fixture only' });
  agent.requestCancel();
  release(true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/);
  assert.equal(executed, false);
});

test('parent cancellation immediately blocks a child awaiting approval', async t => {
  let release!: (approved: boolean) => void;
  const parent = new Agent(config(), { approver: () => new Promise<boolean>(resolve => { release = resolve; }) });
  const originalRun = Agent.prototype.run;
  t.after(() => { Agent.prototype.run = originalRun; });
  let executed = false;
  Agent.prototype.run = async function () {
    this.toolMap.set('shell', { run: async () => { executed = true; return { ok: true }; } });
    const pending = call(this, 'shell', { command: 'fixture only' });
    parent.requestCancel();
    release(true);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error, /cancelled/);
    return { text: 'cancelled safely', turns: 0, cancelled: true };
  };
  const result = await mkSubagentTool().run({ task: 'fixture only' }, { agent: parent });
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, true);
  assert.equal(executed, false);
});

test('subagents share live restrictions and propagate private-read taint', async t => {
  const f = fixture(t);
  const requests: any[] = [];
  const parent = new Agent(config(), { approver: async (request: any) => { requests.push(request); return false; } });
  parent.setProjectScope(f.root);
  parent.sentinel.setMode('auto');
  const originalRun = Agent.prototype.run;
  t.after(() => { Agent.prototype.run = originalRun; });
  Agent.prototype.run = async function () {
    assert.equal(this.sentinel, parent.sentinel);
    assert.equal(this.sentinel.mode, 'auto');
    parent.sentinel.setMode('plan');
    assert.equal((await call(this, 'shell', { command: 'fixture only' })).ok, false);
    parent.sentinel.setMode('ask');
    await call(this, 'read_file', { path: path.join(f.outside, 'fixture.txt') });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].subagent, true);
    this.markTainted('fixture private read');
    assert.equal(parent.tainted, true);
    assert.equal(this.tainted, true);
    return { text: 'verified', turns: 0 };
  };
  const result = await mkSubagentTool().run({ task: 'fixture only' }, { agent: parent });
  assert.equal(result.ok, true);
  assert.equal(result.result, 'verified');
});
