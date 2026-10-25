'use strict';
// features.test.js - Antigravity-inspired feature tests:
//   1. spawn_agent: gating (ask), child isolation, approval chaining, no nesting
//   2. MCP: config->tools, mcp__ prefix gating, tool call round-trip
//   3. bridge: token auth, loopback host check, health/status/send
// Run: node --test app/harness/test/features.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { Sentinel } = require('../sentinel');
const { buildTools } = require('../tools');
const { mkSubagentTool, SUBAGENT_MAX_CONCURRENT } = require('../subagent');
const { McpStdioClient, startMcpServers, registry } = require('../mcp');
const { startBridge, timingSafeEqualStr, isLoopbackHost } = require('../bridge');
const { Agent } = require('../agent');

// ---------- helpers ----------

let mockPort = 0;
let mockServer;
let script = [];

function startMockLlm() {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const resp = script.shift();
      if (!resp) { res.writeHead(500); res.end('script exhausted'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: resp, finish_reason: resp.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { total_tokens: 1 },
      }));
    });
  });
  return new Promise(r => mockServer.listen(0, '127.0.0.1', () => {
    mockPort = mockServer.address().port;
    r();
  }));
}

function cfg(over = {}) {
  const base = {
    llm: { base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k', temperature: 0, max_tokens: 100 },
    agent: { max_turns: 5, approval_timeout_s: 5 },
    sentinel: { deny_rules: [] },
    memory: { enabled: false },
    hands: { enabled: false },
  };
  return { ...base, ...over };
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// ---------- 1. subagent ----------

test('sentinel: spawn_agent requires approval', () => {
  const s = new Sentinel({});
  const d = s.decide({ tool: 'spawn_agent', args: { task: 'x' } });
  assert.equal(d.decision, 'ask');
});

test('subagent: child runs isolated loop, returns summary to parent', async () => {
  // child script: first response is final text
  script = [{ role: 'assistant', content: 'child summary: 3 files found' }];
  const parent = new Agent(cfg(), { approver: async () => true });
  const tool = mkSubagentTool({});
  const res = await tool.run({ task: 'survey files' }, {
    cwd: process.cwd(), cfg: parent.cfg, sentinel: parent.sentinel,
    agent: parent, tainted: false, netPolicy: { allowLocal: false },
  });
  assert.equal(res.ok, true);
  assert.match(res.result, /child summary/);
  assert.equal(res.turns, 1);
});

test('subagent: no nesting — child cannot spawn children', async () => {
  const child = new Agent(cfg(), { disableSubagent: true });
  assert.equal(child.toolMap.has('spawn_agent'), false);
  // depth guard fails closed even if the tool were somehow registered
  const nested = mkSubagentTool({ depth: 1 });
  const res2 = await nested.run({ task: 'x' }, { agent: child, cfg: cfg(), sentinel: new Sentinel({}) });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /not available to child agents/);
});

test('subagent: concurrent cap enforced', async () => {
  const parent = new Agent(cfg(), { approver: async () => true });
  const children = new Set();
  const tool = mkSubagentTool({ children });
  // occupy both slots with pending children (simulate by pre-filling set)
  children.add({ fake: 1 }); children.add({ fake: 2 });
  const res = await tool.run({ task: 'x' }, {
    cwd: process.cwd(), cfg: parent.cfg, sentinel: parent.sentinel,
    agent: parent, tainted: false, netPolicy: {},
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /too many concurrent subagents/);
});

test('subagent: parent approval chain routes child approvals to same approver', async () => {
  const approvals = [];
  const parent = new Agent(cfg(), {
    approver: async (req) => { approvals.push(req.tool); return true; },
  });
  // child tries a shell call: scripted child response with tool_call, then final.
  script = [
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { command: 'echo hi' })] },
    { role: 'assistant', content: 'child done' },
  ];
  const tool = mkSubagentTool({});
  const res = await tool.run({ task: 'do shell thing' }, {
    cwd: process.cwd(), cfg: parent.cfg, sentinel: parent.sentinel,
    agent: parent, tainted: false, netPolicy: { allowLocal: false },
  });
  assert.equal(res.ok, true);
  assert.ok(approvals.includes('shell'));
  assert.ok(approvals.every(t => t === 'spawn_agent' || t === 'shell'));
});

test('agent tool registry: parent has spawn_agent, child does not', () => {
  const parent = new Agent(cfg(), {});
  const child = new Agent(cfg(), { disableSubagent: true });
  assert.equal(parent.toolMap.has('spawn_agent'), true);
  assert.equal(child.toolMap.has('spawn_agent'), false);
});

// ---------- 2. MCP ----------

test('sentinel: mcp__ tools are ask (side-effect default)', () => {
  const s = new Sentinel({});
  assert.equal(s.decide({ tool: 'mcp__docs__search', args: {} }).decision, 'ask');
});

test('mcp: stdio client initializes, lists tools, calls (mock server over stdio)', async () => {
  // Mock MCP server: node script speaking JSON-RPC on stdin/stdout.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-mcp-'));
  const serverJs = path.join(tmp, 'server.js');
  fs.writeFileSync(serverJs, `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method === 'initialize') {
        reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } });
      } else if (m.method === 'tools/list') {
        reply(m.id, { tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
      } else if (m.method === 'tools/call') {
        reply(m.id, { content: [{ type: 'text', text: 'echoed: ' + (m.params.arguments.text || '') }] });
      }
    });
    function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
  `);
  const client = new McpStdioClient('mock', { command: process.execPath, args: [serverJs], timeout_s: 10 });
  try {
    const tools = await client.initialize();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'echo');
    const res = await client.call('echo', { text: 'hello' });
    assert.equal(res.content[0].text, 'echoed: hello');
  } finally {
    client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mcp: startMcpServers registers config servers, skips bad ones', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-mcp-'));
  const serverJs = path.join(tmp, 'server.js');
  fs.writeFileSync(serverJs, `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method === 'initialize') reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: {name:'mock',version:'1'} });
      else if (m.method === 'tools/list') reply(m.id, { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] });
      else if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: 'pong' }] });
    });
    function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
  `);
  const logs = [];
  const c = cfg();
  c.mcp = {
    servers: ['good', 'bad'],
    server: {
      good: { command: process.execPath, args: [serverJs], timeout_s: 10 },
      bad: { command: 'definitely-not-a-real-command-xyz', args: [] },
    },
  };
  try {
    await startMcpServers(c, (m) => logs.push(m));
    const clients = registry.clients();
    assert.equal(clients.length, 1);
    assert.equal(clients[0].name, 'good');
    assert.ok(logs.some(l => /failed to start/.test(l)));
    // build agent tools: mcp__ prefix present
    const a = new Agent(JSON.parse(JSON.stringify(c)), {});
    const names = a.tools.map(t => t.name);
    assert.ok(names.includes('mcp__good__ping'));
    // mcp tool runs through agent registry
    const t = a.toolMap.get('mcp__good__ping');
    const res = await t.run({});
    assert.equal(res.ok, true);
    assert.equal(res.result, 'pong');
  } finally {
    registry.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 3. bridge ----------

test('bridge: timing-safe compare + loopback host checks', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', ''), false);
  assert.equal(isLoopbackHost('127.0.0.1:8080'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('evil.example.com'), false);
  assert.equal(isLoopbackHost('192.168.1.5'), false);
});

test('bridge: auth required, health/status/send work with token', async () => {
  const b = await startBridge({
    port: 0,
    deps: {
      getStatus: () => ({ busy: false, version: 'test', sessionId: 's1', projectDir: null, tools: ['read_file'] }),
      send: async (text) => ({ ok: true, text: `echo:${text}`, turns: 1 }),
      cancel: async () => ({ ok: true }),
      reset: async () => ({ ok: true }),
      listSessions: async () => [{ id: 's1', title: 't' }],
    },
  });
  const base = `http://127.0.0.1:${b.port}`;
  const tok = fs.readFileSync(b.tokenFile, 'utf8').trim();
  try {
    // no token -> 401
    let res = await fetch(`${base}/health`);
    assert.equal(res.status, 401);
    // bad token -> 401
    res = await fetch(`${base}/health`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(res.status, 401);
    // good token: health
    res = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${tok}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    // status
    res = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${tok}` } });
    const st = await res.json();
    assert.equal(st.busy, false);
    assert.equal(st.session_id, 's1');
    assert.deepEqual(st.tools, ['read_file']);
    // send
    res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const out = await res.json();
    assert.equal(out.ok, true);
    assert.equal(out.text, 'echo:hello');
    // send empty -> 400
    res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    assert.equal(res.status, 400);
    // unknown route -> 404
    res = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${tok}` } });
    assert.equal(res.status, 404);
    // sessions
    res = await fetch(`${base}/sessions`, { headers: { authorization: `Bearer ${tok}` } });
    const ses = await res.json();
    assert.equal(ses.sessions.length, 1);
  } finally {
    await b.close();
    try { fs.unlinkSync(b.tokenFile); } catch {}
  }
});

test('bridge: busy send returns 409', async () => {
  const b = await startBridge({
    port: 0,
    deps: {
      getStatus: () => ({ busy: true, version: 'test', sessionId: null, projectDir: null, tools: [] }),
      send: async () => ({ ok: true, text: 'x', turns: 0 }),
      cancel: async () => ({ ok: true }),
      reset: async () => ({ ok: true }),
      listSessions: async () => [],
    },
  });
  const base = `http://127.0.0.1:${b.port}`;
  const tok = fs.readFileSync(b.tokenFile, 'utf8').trim();
  try {
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(res.status, 409);
  } finally {
    await b.close();
    try { fs.unlinkSync(b.tokenFile); } catch {}
  }
});

// ---------- bootstrap ----------

test.before(async () => { await startMockLlm(); });
test.after(() => { try { mockServer && mockServer.close(); } catch {} });
