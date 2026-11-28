'use strict';
// parallel-tools.test.ts - independent calls from one reply run concurrently;
// a call that needs approval runs on its own, in call order. Also pins the
// research_brief tool as a gated side effect.

import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-parallel-home-'));
process.env.MUSE_HOME = home;
const { Agent } = require('../agent');
const { DEFAULTS } = require('../config');
const { Sentinel } = require('../sentinel');
const { buildTools } = require('../tools');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function setup(t: TestContext, mode = 'auto', approver: any = async () => { assert.fail('unexpected approval request'); }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-parallel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const cfg = structuredClone(DEFAULTS);
  cfg.sentinel.mode = mode;
  cfg.memory.enabled = false;
  const agent = new Agent(cfg, { approver });
  agent.setProjectScope(project);
  return { agent, cfg, project, outside: directory };
}

const call = (id: string, name: string, args: object) => ({
  id, name, arguments: JSON.stringify(args),
});

// Wraps a tool's run so a test can watch how many calls are in flight at once.
function watch(tool: any, ms = 60) {
  const real = tool.run;
  const stats = { inFlight: 0, peak: 0, order: [] as string[] };
  tool.run = async (args: any, ctx: any) => {
    stats.inFlight++;
    stats.peak = Math.max(stats.peak, stats.inFlight);
    stats.order.push('start');
    await new Promise(resolve => setTimeout(resolve, ms));
    stats.order.push('end');
    stats.inFlight--;
    return real(args, ctx);
  };
  return stats;
}

test('authorized calls from one reply run concurrently, results stay in call order', async t => {
  const { agent, project } = setup(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'AAA');
  fs.writeFileSync(path.join(project, 'b.txt'), 'BBB');
  const stats = watch(agent.toolMap.get('read_file'));
  const results = await agent.executeToolCalls([
    call('1', 'read_file', { path: 'a.txt' }),
    call('2', 'read_file', { path: 'b.txt' }),
  ]);
  assert.equal(stats.peak, 2, 'both reads were in flight at once');
  assert.equal(JSON.parse(results[0]).content, 'AAA');
  assert.equal(JSON.parse(results[1]).content, 'BBB');
});

test('a call that needs approval runs after the batch, one at a time', async t => {
  const { agent, outside } = setup(t, 'ask', async () => ({ v: true }));
  const stats = watch(agent.toolMap.get('write_file'), 20);
  const results = await agent.executeToolCalls([
    call('1', 'write_file', { path: path.join(outside, 'one.txt'), content: '1' }),
    call('2', 'write_file', { path: path.join(outside, 'two.txt'), content: '2' }),
  ]);
  assert.equal(stats.peak, 1, 'gated calls never overlap');
  assert.deepEqual(stats.order, ['start', 'end', 'start', 'end']);
  assert.equal(JSON.parse(results[0]).ok, true);
  assert.equal(JSON.parse(results[1]).ok, true);
  assert.equal(fs.readFileSync(path.join(outside, 'one.txt'), 'utf8'), '1');
});

test('cancelling a run aborts every tool call in flight', async t => {
  const { agent, project } = setup(t);
  fs.writeFileSync(path.join(project, 'a.txt'), 'AAA');
  const tool = agent.toolMap.get('read_file');
  const real = tool.run;
  let aborted = 0;
  tool.run = async (args: any, ctx: any) => {
    await new Promise(resolve => setTimeout(resolve, 40));
    if (ctx.signal.aborted) aborted++;
    return real(args, ctx);
  };
  const batch = agent.executeToolCalls([
    call('1', 'read_file', { path: 'a.txt' }),
    call('2', 'read_file', { path: 'a.txt' }),
  ]);
  setTimeout(() => agent.requestCancel(), 5);
  await batch;
  assert.equal(aborted, 2);
});

test('research_brief is registered and gated as a side effect', async () => {
  const { map } = buildTools({}, { disableSubagent: true });
  const tool = map.get('research_brief');
  assert.ok(tool, 'research_brief is in the registry');
  const cfg = { sentinel: { mode: 'ask', deny_rules: [], egress_allowlist: [] }, agent: { always_ask_tools: [] } };
  const s = new Sentinel(cfg);
  assert.equal(s.decide({ tool: 'research_brief', args: { topic: 'x' } }).decision, 'ask');
  s.setMode('plan');
  assert.equal(s.decide({ tool: 'research_brief', args: { topic: 'x' } }).decision, 'deny');
  s.setMode('auto');
  assert.equal(s.decide({ tool: 'research_brief', args: { topic: 'x' } }).decision, 'allow');
  const bad = await tool.run({}, { cfg: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /topic is required/);
});
