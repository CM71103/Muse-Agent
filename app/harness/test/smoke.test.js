'use strict';
// smoke.test.js - end-to-end harness test with a mock OpenAI-compatible LLM server.
// Covers: tool loop, read->write, sentinel deny rule, always-ask approval, taint egress block.
// Run: node --test app/harness/test/

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, parseToml, deepMerge } = require('../config');
const { Agent } = require('../agent');

let mockPort = 0;
let mockServer;

function mkMsg(role, content, tool_calls) {
  const m = { role, content };
  if (tool_calls) m.tool_calls = tool_calls;
  return m;
}

// Scripted LLM: each request pops next scripted response.
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

function cfg(over) {
  const base = loadConfig(); // defaults
  base.llm.base_url = `http://127.0.0.1:${mockPort}/v1`;
  base.llm.api_key = 'test-key';
  base.llm.api_key_env = 'MUSE_TEST_KEY_UNUSED';
  return deepMerge(base, over || {});
}

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test.before(async () => { await startMockLlm(); });
test.after(() => {
  if (mockServer) {
    mockServer.close();
    mockServer.closeAllConnections && mockServer.closeAllConnections();
  }
});

test('config: TOML parse + merge', () => {
  const t = parseToml(`
[llm]
model = "my-model"
max_turns = 5
[hands]
enabled = true
deny = ["a", "b"]
`);
  assert.equal(t.llm.model, 'my-model');
  assert.equal(t.hands.enabled, true);
  assert.deepEqual(t.hands.deny, ['a', 'b']);
  const merged = deepMerge({ a: { b: 1, keep: true } }, { a: { b: 2 } });
  assert.equal(merged.a.b, 2);
  assert.equal(merged.a.keep, true);
});

test('config: multi-line arrays parse (deny_rules regression)', () => {
  const t = parseToml(`
[sentinel]
mode = "ask"
deny_rules = [
  "*rm -rf*",
  "*format *",
  "*shutdown*",
]
egress_allowlist = [
  "duckduckgo.com",
  "github.com",
]
`);
  assert.equal(t.sentinel.mode, 'ask');
  assert.deepEqual(t.sentinel.deny_rules, ['*rm -rf*', '*format *', '*shutdown*']);
  assert.deepEqual(t.sentinel.egress_allowlist, ['duckduckgo.com', 'github.com']);
});

test('config: project-local config.toml auto-loads with deny rules intact', () => {
  const cfg = loadConfig(); // no explicit path, no env -> project-local
  assert.ok(cfg._configFile.endsWith('config.toml'));
  assert.ok(Array.isArray(cfg.sentinel.deny_rules) && cfg.sentinel.deny_rules.length > 0,
    'deny_rules must not be empty — security regression guard');
  assert.ok(cfg.sentinel.deny_rules.some(r => r.includes('rm -rf')));
});

test('agent loop: read_file -> write_file -> final answer', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-'));
  const src = path.join(tmp, 'note.txt');
  fs.writeFileSync(src, 'hello world');
  const dst = path.join(tmp, 'copy.txt');

  script = [
    mkMsg('assistant', null, [call('c1', 'read_file', { path: src })]),
    mkMsg('assistant', null, [call('c2', 'write_file', { path: dst, content: 'hello world' })]),
    mkMsg('assistant', 'I read the file and copied it.'),
  ];

  const events = [];
  const agent = new Agent(cfg(), { onEvent: e => events.push(e), approver: async () => true });
  agent.sentinel.addGrant(tmp);   // read inside granted scope (new policy: reads ask outside grants)
  const res = await agent.run(`copy ${src} to ${dst}`);

  assert.equal(res.text, 'I read the file and copied it.');
  assert.equal(fs.readFileSync(dst, 'utf8'), 'hello world');
  assert.ok(events.some(e => e.type === 'tool_call' && e.name === 'read_file'));
  assert.ok(agent.tainted, 'reading a file should taint session');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sentinel: deny rule blocks rm -rf before approval', async () => {
  script = [
    mkMsg('assistant', null, [call('c1', 'shell', { command: 'rm -rf /' })]),
    mkMsg('assistant', 'Could not run that.'),
  ];
  const agent = new Agent(cfg(), { approver: async () => true, onEvent: () => {} });
  await agent.run('delete everything');

  const toolMsg = agent.history.find(m => m.role === 'tool');
  assert.match(toolMsg.content, /denied by sentinel.*rm -rf/);
});

test('sentinel: shell requires approval; deny blocks execution', async () => {
  script = [
    mkMsg('assistant', null, [call('c1', 'shell', { command: 'echo hi' })]),
    mkMsg('assistant', 'ok'),
  ];
  let approved = false;
  const agent = new Agent(cfg(), { approver: async () => { approved = true; return false; }, onEvent: () => {} });
  await agent.run('run echo');
  const toolMsg = agent.history.find(m => m.role === 'tool');
  assert.ok(approved, 'approver should have been called');
  assert.match(toolMsg.content, /user denied/);
});

test('sentinel: approved shell executes', async () => {
  script = [
    mkMsg('assistant', null, [call('c1', 'shell', { command: 'echo musetest123' })]),
    mkMsg('assistant', 'ran it'),
  ];
  const agent = new Agent(cfg(), { approver: async () => true, onEvent: () => {} });
  await agent.run('run echo');
  const toolMsg = agent.history.find(m => m.role === 'tool');
  const parsed = JSON.parse(toolMsg.content);
  assert.equal(parsed.ok, true);
  assert.match(parsed.output, /musetest123/);
});

test('sentinel: taint blocks egress to non-allowlisted host', async () => {
  script = [
    mkMsg('assistant', null, [call('c1', 'web_fetch', { url: 'https://example.com/secret-exfil' })]),
    mkMsg('assistant', 'blocked'),
  ];
  const events = [];
  const agent = new Agent(cfg(), { onEvent: e => events.push(e), approver: async () => true });
  agent.tainted = true; // simulate prior private read
  await agent.run('fetch example.com');
  const toolMsg = agent.history.find(m => m.role === 'tool');
  const parsed = JSON.parse(toolMsg.content);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /tainted.*allowlist/);
});

test('sentinel: glob rule matching edge cases', () => {
  const { Sentinel } = require('../sentinel');
  const s = new Sentinel(cfg());
  assert.ok(s.matchesRule('shell {"command":"rm -rf /"}', '*rm -rf*'));
  assert.ok(!s.matchesRule('shell {"command":"rm -r /"}', '*rm -rf*'));
  assert.ok(s.matchesRule('shell {"command":"echo rm -rf here"}', '*rm -rf*'));
  assert.ok(s.matchesRule('shell {"command":"format c:"}', '*format *'));
  assert.ok(!s.matchesRule('shell {"command":"echo reformatted"}', '*format *'));
  // trailing-literal anchoring: *shutdown requires haystack to END with shutdown
  assert.ok(!s.matchesRule('shell {"command":"shutdown now extra"}', '*shutdown'));
  assert.ok(!s.matchesRule('shell {"command":"sudo shutdown"}', '*shutdown')); // ends with '}'
  assert.ok(s.matchesRule('shell {"command":"sudo shutdown"}', '*shutdown*'));
  // leading-literal anchoring: format* must START with format
  assert.ok(s.matchesRule('format c: whatever', 'format*'));
  assert.ok(!s.matchesRule('shell {"command":"reformat c:"}', 'format*'));
});

test('tools: list_dir works', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-'));
  fs.writeFileSync(path.join(tmp, 'x.txt'), 'x');
  script = [
    mkMsg('assistant', null, [call('c1', 'list_dir', { path: tmp })]),
    mkMsg('assistant', 'listed'),
  ];
  const agent = new Agent(cfg(), { onEvent: () => {}, approver: async () => true });
  agent.sentinel.addGrant(tmp);   // listing inside granted scope
  await agent.run('list');
  const toolMsg = agent.history.find(m => m.role === 'tool');
  const parsed = JSON.parse(toolMsg.content);
  assert.ok(parsed.entries.some(e => e.name === 'x.txt'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('llm client: missing key error points at env var', async () => {
  const { LlmClient } = require('../llm');
  const c = new LlmClient(cfg());
  c.cfg.api_key = '';
  c.base = 'https://api.example.com/v1'; // non-local host: key required
  await assert.rejects(() => c.chat([mkMsg('user', 'hi')], []), /No API key.*MUSE_LLM_API_KEY/);
});
