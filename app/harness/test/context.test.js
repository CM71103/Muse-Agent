'use strict';
// context.test.js - compaction + overflow-retry behavior.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { Agent } = require('../agent');

let mockPort = 0;
let mockServer;
let script = [];

function mkMsg(role, content, tool_calls) {
  const m = { role, content };
  if (tool_calls) m.tool_calls = tool_calls;
  return m;
}

function startMockLlm() {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const resp = script.shift();
      if (!resp) { res.writeHead(500); res.end('script exhausted'); return; }
      if (resp.error) { res.writeHead(resp.error.status || 400); res.end(JSON.stringify(resp.error.body)); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: resp.msg, finish_reason: resp.msg.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 0 },
      }));
    });
  });
  return new Promise(r => mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; r(); }));
}

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test.before(async () => { await startMockLlm(); });
test.after(() => {
  if (mockServer) { mockServer.close(); mockServer.closeAllConnections && mockServer.closeAllConnections(); }
});

function cfg(over) {
  const { loadConfig, deepMerge } = require('../config');
  const base = loadConfig();
  base.llm.base_url = `http://127.0.0.1:${mockPort}/v1`;
  base.llm.api_key = 'k';
  return deepMerge(base, over || {});
}

test('compactHistory: stubs old tool outputs, keeps recent', () => {
  const a = new Agent(cfg(), { onEvent: () => {} });
  a.history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    mkMsg('assistant', null, [call('c1', 'web_fetch', { url: 'x' })]),
    { role: 'tool', tool_call_id: 'c1', content: 'X'.repeat(50000) },
    mkMsg('assistant', null, [call('c2', 'web_fetch', { url: 'y' })]),
    { role: 'tool', tool_call_id: 'c2', content: 'Y'.repeat(50000) },
    mkMsg('assistant', null, [call('c3', 'web_fetch', { url: 'z' })]),
    { role: 'tool', tool_call_id: 'c3', content: 'Z'.repeat(50000) },
    { role: 'assistant', content: 'done' },
  ];
  const did = a.compactHistory(true);
  assert.ok(did);
  const tools = a.history.filter(m => m.role === 'tool');
  // oldest (c1) stubbed; two most recent exchanges (c2, c3) intact
  assert.match(tools[0].content, /dropped to fit context/);
  assert.equal(tools[1].content, 'Y'.repeat(50000));
  assert.equal(tools[2].content, 'Z'.repeat(50000));
  // ids preserved -> protocol stays valid
  assert.equal(tools[0].tool_call_id, 'c1');
});

test('compactHistory: drops old blocks when stubbing is not enough', () => {
  const a = new Agent(cfg(), { onEvent: () => {} });
  a.history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' + 'x'.repeat(80000) },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ];
  a.compactHistory(true);
  assert.equal(a.history[0].role, 'system');
  assert.ok(a.estimateHistoryTokens() < 80000, 'old block should be gone');
  assert.ok(a.history.some(m => m.role === 'user' && m.content === 'q2'));
});

test('compactHistory: keeps small history untouched', () => {
  const a = new Agent(cfg(), { onEvent: () => {} });
  a.history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  assert.equal(a.compactHistory(false), false);
});

test('context overflow refuses request rather than exceeding configured limit', async () => {
  const a = new Agent(cfg({ llm: {context_tokens:1000,max_tokens:8192} }));
  await assert.rejects(()=>a.run('q'), /exceeds context limit/);
});

test('token estimate sanity', () => {
  assert.equal(Agent.estimateTokens({ role: 'user', content: 'a'.repeat(3700) }), 1000);
});
