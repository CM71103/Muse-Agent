import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-lifecycle-home-'));
process.env.MUSE_HOME = home;
const { Agent } = require('../agent');
const { MemoryLayer } = require('../../memory/layer');
const { DEFAULTS, deepMerge } = require('../config');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

async function setup(t: TestContext, maxTurns = 5) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-lifecycle-'));
  const cfg = deepMerge(DEFAULTS, { llm: { max_tokens: 100, context_tokens: 200000 },
    agent: { max_turns: maxTurns }, sentinel: { mode: 'ask', deny_rules: [] },
    memory: { project_id_strategy: 'manual', project_id: 'fixture', embed_model: 'fixture', embed_dims: 2,
      adaptive_ranking: true, query_clustering: false, adaptive_budget: false } });
  const mem = new MemoryLayer(cfg, { dataDir: directory,
    embed: async (_cfg: any, texts: string[]) => ({ model: 'fixture', vectors: texts.map(() => ({ vector: [1, 0] })) }) });
  t.after(() => { mem.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await mem.ingest([{ source_event_id: 'fixture', text: 'The release command is bun run dist.', provenance: 'user' }]);
  await mem.embedPending();
  const agent = new Agent(cfg, { approver: async () => true });
  agent.attachMemory(mem);
  agent.toolMap.set('shell', { run: async () => ({ ok: true, output: 'fixture observation' }) });
  return { agent, mem, id: mem.listMemories()[0].id };
}
const toolReply = (id: string) => ({ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'shell', arguments: '{"command":"fixture only"}' } }] },
  finish_reason: 'tool_calls', usage: { total_tokens: 3 } });
const answer = (content: string, reason = 'stop') => ({ message: { role: 'assistant', content },
  finish_reason: reason, usage: { total_tokens: 5 } });

test('memory survives multiple tool calls; final answer and total usage drive feedback', async t => {
  const { agent, mem, id } = await setup(t);
  const requests: any[] = [];
  agent.llm.chat = async (messages: any) => {
    requests.push(structuredClone(messages));
    const turn = mem.store.listTurns()[0];
    assert.equal(turn.state, requests.length === 1 ? 'prepared' : 'sent');
    return requests.length < 3 ? toolReply(`call-${requests.length}`) : answer('Use bun run dist [c1].');
  };
  const result = await agent.run('How do I release?');
  const blocks = requests.map(Agent.memorySectionOf);
  assert.equal(requests.length, 3);
  assert.ok(blocks.every((block: string) => block && block === blocks[0]));
  const turn = mem.store.getTurn(result.memory_turn_id);
  assert.equal(turn.state, 'completed');
  assert.equal(turn.response_text, result.text);
  assert.equal(turn.usage.total_tokens, 11);
  assert.equal(agent.memorySection(), '');
  assert.equal(mem.grade(result.memory_turn_id, 1).ok, true);
  assert.equal(mem.store.getMemory(id).evidence.default.cited_n, 1);
});

test('output continuations retain memory and record the combined answer', async t => {
  const { agent, mem } = await setup(t);
  let count = 0;
  agent.llm.chat = async (messages: any) => {
    assert.match(Agent.memorySectionOf(messages), /release command/);
    return ++count === 1 ? answer('The release command is', 'length') : answer('bun run dist [c1].');
  };
  const result = await agent.run('Explain release');
  const turn = mem.store.getTurn(result.memory_turn_id);
  assert.equal(turn.response_text, result.text);
  assert.match(turn.response_text, /release command is\nbun run dist/);
  assert.equal(turn.usage.total_tokens, 10);
});

test('later provider failure leaves memory turn ungradeable and removes injected context', async t => {
  const { agent, mem } = await setup(t);
  let calls = 0;
  agent.llm.chat = async () => { if (++calls === 1) return toolReply('one'); throw new Error('fixture provider failure'); };
  await assert.rejects(() => agent.run('Release'), /fixture provider failure/);
  const turn = mem.store.listTurns()[0];
  assert.equal(turn.state, 'unknown');
  assert.equal(mem.grade(turn.id, 1).reason, 'turn_not_completed');
  assert.equal(agent.memorySection(), '');
});

test('deleting recalled memory between tool calls prevents resending it', async t => {
  const { agent, mem, id } = await setup(t);
  let calls = 0;
  agent.llm.chat = async () => { calls++; return toolReply('delete-between-calls'); };
  agent.toolMap.set('shell', { run: async () => { mem.deleteMemory(id); return { ok: true }; } });
  await assert.rejects(() => agent.run('Release'), /MEMORY_REPACK_REQUIRED/);
  assert.equal(calls, 1);
  assert.equal(agent.memorySection(), '');
});

test('tool-limit summary retains memory but does not claim successful completion', async t => {
  const { agent, mem } = await setup(t, 1);
  let calls = 0;
  agent.llm.chat = async (messages: any) => {
    assert.match(Agent.memorySectionOf(messages), /release command/);
    return ++calls === 1 ? toolReply('one') : answer('Progress summary [c1].');
  };
  const result = await agent.run('Release');
  const turn = mem.store.getTurn(result.memory_turn_id);
  assert.equal(turn.state, 'unknown');
  assert.equal(turn.fail_reason, 'turn_limit');
});

test('ordinary requests and raw tool results remain extraction events, not stored facts', async t => {
  const { agent, mem } = await setup(t);
  await agent.ingestUserTurn('Fix the release bug');
  await agent.ingestToolResult('shell', 'temporary build output', 'one');
  assert.equal(mem.listMemories().length, 1);
  assert.equal(agent._sourceEvents.length, 2);
  await agent.ingestUserTurn('I prefer concise answers.');
  assert.equal(mem.listMemories().length, 2);
  assert.equal(mem.listMemories().find((row: any) => row.type === 'preference').text, 'I prefer concise answers.');
  assert.equal(mem.listMemories().find((row: any) => row.type === 'preference').status, 'pending_embed');
});

test('completed IPC answers persist capture without waiting on a held embedding provider', async t => {
  const { agent, mem } = await setup(t);
  let embeddingRequests = 0;
  mem.embed = () => { embeddingRequests++; return new Promise(() => {}); };
  // Isolate post-answer capture from pre-turn retrieval, whose separate
  // provider latency remains outside this regression's scope.
  mem.requestContext = async () => ({ turn_id: null, clamp_reason: 'no_memories' });
  const events: any[] = [];
  agent.events = (event: any) => events.push(event);
  agent.llm.chat = async () => answer('I will remember Mango.');
  const source = fs.readFileSync(path.join(__dirname, '../../main/index.js'), 'utf8');
  const body = source.match(/ipcMain\.handle\('agent:send', async \(e, text\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(body);
  const context: any = {
    agent, agentBusy: false, requireTrusted: () => {}, currentProjectId: null,
    send: () => {}, setBusyState: (busy: boolean) => { context.agentBusy = busy; },
  };
  const handler = require('node:vm').runInNewContext(`(async(e,text)=>{${body[1]}})`, context);
  const nextTick = Symbol('IPC still waiting');
  const result = await Promise.race([
    handler({}, 'My cat is named Mango.'),
    new Promise(resolve => setImmediate(() => resolve(nextTick))),
  ]);
  assert.notEqual(result, nextTick, 'IPC must settle without starting or waiting for post-answer network embedding');
  assert.equal(result.ok, true);
  assert.equal(context.agentBusy, false);
  assert.ok(events.some(event => event.type === 'done'));
  assert.equal(embeddingRequests, 0);
  const row = mem.listMemories().find((memory: any) => /Mango/.test(memory.text));
  assert.equal(row.status, 'pending_embed');
  assert.ok(agent._sourceEvents.some((event: any) => /Mango/.test(event.text)));
});

test('agent project selection switches automatic memory and clears the old feedback target', async t => {
  const { agent, mem } = await setup(t);
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-selected-one-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-selected-two-'));
  t.after(() => { fs.rmSync(first, { recursive: true, force: true }); fs.rmSync(second, { recursive: true, force: true }); });
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(first);
  t.after(() => { if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling; });
  mem.setScope('auto', '', null);
  agent.setProjectScope(first);
  const oldScope = mem.projectId;
  assert.ok(oldScope);
  const extractions: any[] = [];
  mem.extractSession = async (events: any) => { extractions.push({ scope: mem.projectId, events }); return { ok: true, extracted: 0 }; };
  await agent.ingestToolResult('shell', 'temporary observation', 'old-project');
  agent.lastMemoryTurnId = 'old-grade-target';
  agent.setProjectScope(second);
  assert.notEqual(mem.projectId, oldScope);
  assert.equal(extractions.length, 1);
  assert.equal(extractions[0].scope, oldScope);
  assert.equal(agent._sourceEvents.length, 0);
  assert.equal(agent.lastMemoryTurnId, null);
  agent.setProjectScope(null);
  assert.equal(mem.projectId, null);
});

test('a memoryless response cannot leave feedback pointing at an older answer', async t => {
  const { agent, mem } = await setup(t);
  agent.lastMemoryTurnId = 'previous-answer';
  mem.requestContext = async () => ({ turn_id: null, clamp_reason: 'embed_cooldown' });
  agent.llm.chat = async () => answer('Answer without memory.');
  const result = await agent.run('Another question');
  assert.equal(result.memory_turn_id, null);
  assert.equal(agent.lastMemoryTurnId, null);
});

test('old first-response evidence cannot be graded as final-answer evidence', async t => {
  const { agent, mem } = await setup(t);
  agent.llm.chat = async () => answer('Release [c1].');
  const result = await agent.run('Release');
  const turn = mem.store.getTurn(result.memory_turn_id);
  assert.match(turn.evidence_version, /-v2$/);
  mem.store._putTurn({ ...turn, evidence_version: turn.evidence_version.replace(/-v2$/, '-v1') });
  assert.equal(mem.grade(turn.id, 1).reason, 'version_mismatch');
});
