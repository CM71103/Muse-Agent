import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-auto-home-'));
process.env.MUSE_HOME = home;
const { Agent, systemPrompt } = require('../agent');
const { DEFAULTS } = require('../config');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-auto-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(project); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'fixture.txt'), 'AUTO_READ_OK');
  const cfg = structuredClone(DEFAULTS);
  cfg.sentinel.mode = 'auto';
  cfg.agent.always_ask_tools = ['shell', 'read_file', 'write_file', 'web_fetch', 'spawn_agent'];
  cfg.memory.enabled = false;
  const agent = new Agent(cfg, { approver: async () => { assert.fail('Auto invoked approval UI'); } });
  agent.setProjectScope(project);
  return { agent, cfg, directory, project, outside };
}
const call = async (agent: any, name: string, args: object) => JSON.parse(await agent.executeToolCall({
  id: name, function: { name, arguments: JSON.stringify(args) },
}));

test('Auto executes file tools outside the selected project without invoking approvals', async t => {
  const { agent, outside, project } = setup(t);
  assert.equal((await call(agent, 'read_file', { path: path.join(outside, 'fixture.txt') })).content, 'AUTO_READ_OK');
  assert.equal((await call(agent, 'list_dir', { path: outside })).ok, true);
  const destination = path.join(outside, 'nested/new.txt');
  assert.equal((await call(agent, 'write_file', { path: destination, content: 'AUTO_WRITE_OK' })).ok, true);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'AUTO_WRITE_OK');
  fs.symlinkSync(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call(agent, 'read_file', { path: 'linked/fixture.txt' })).content, 'AUTO_READ_OK');
});

test('Auto runs an actual PowerShell command without an approval callback', { skip: process.platform !== 'win32' }, async t => {
  const { agent } = setup(t);
  const result = await call(agent, 'shell', { command: 'powershell.exe -NoProfile -NonInteractive -Command "Write-Output AUTO_POWERSHELL_OK"', timeout_s: 15 });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /AUTO_POWERSHELL_OK/);
});

test('Auto executes registered MCP tools and blocks unregistered tools', async t => {
  const { agent } = setup(t);
  agent.toolMap.set('mcp__fixture__lookup', { run: async () => ({ ok: true, result: 'AUTO_MCP_OK' }) });
  assert.equal((await call(agent, 'mcp__fixture__lookup', {})).result, 'AUTO_MCP_OK');
  assert.match((await call(agent, 'mcp__missing__lookup', {})).error, /unknown tool/);
});

test('Auto subagents inherit approval-free tool execution', async t => {
  const { agent, outside } = setup(t);
  const originalRun = Agent.prototype.run;
  t.after(() => { Agent.prototype.run = originalRun; });
  Agent.prototype.run = async function () {
    assert.equal(this.isSubagent, true);
    assert.equal(this.sentinel, agent.sentinel);
    const result = await call(this, 'read_file', { path: path.join(outside, 'fixture.txt') });
    return { text: result.content, turns: 1 };
  };
  const result = await call(agent, 'spawn_agent', { task: 'Read the fixture only.' });
  assert.equal(result.ok, true);
  assert.equal(result.result, 'AUTO_READ_OK');
});

test('Auto retains deny rules and cancellation checks', async t => {
  const { agent } = setup(t);
  let executed = false;
  agent.toolMap.set('shell', { run: async () => { executed = true; return { ok: true }; } });
  assert.match((await call(agent, 'shell', { command: 'rm -rf fixture' })).error, /matched deny rule/);
  agent.requestCancel();
  assert.match((await call(agent, 'shell', { command: 'fixture only' })).error, /cancelled/);
  assert.equal(executed, false);
});

test('Auto instructions refresh in an existing conversation and after a live mode change', async t => {
  const { agent, cfg } = setup(t);
  agent.history = [{ role: 'system', content: systemPrompt(cfg, 'Project instructions must survive.', agent.cwdOverride, true, 'ask') }];
  let requests = 0;
  agent.llm.chat = async (messages: any) => {
    const prompt = messages[0].content;
    assert.match(prompt, /Project instructions must survive/);
    if (++requests === 1) {
      assert.match(prompt, /PERMISSION MODE: auto/);
      assert.doesNotMatch(prompt, /shell still asks/);
      agent.sentinel.setMode('plan');
      return { message: { content: null, tool_calls: [{ id: 'blocked', function: { name: 'shell', arguments: '{"command":"fixture only"}' } }] }, finish_reason: 'tool_calls', usage: { total_tokens: 1 } };
    }
    assert.match(prompt, /PERMISSION MODE: plan/);
    assert.doesNotMatch(prompt, /PERMISSION MODE: auto/);
    return { message: { content: 'Plan only.' }, finish_reason: 'stop', usage: { total_tokens: 1 } };
  };
  agent.toolMap.set('shell', { run: async () => { assert.fail('Plan executed shell'); } });
  await agent.run('Check the active mode.');
  assert.equal(requests, 2);
});
