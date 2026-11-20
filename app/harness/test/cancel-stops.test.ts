import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../agent.js');
const { DEFAULTS } = require('../config.js');

function config() {
  const cfg = structuredClone(DEFAULTS);
  cfg.sentinel.mode = 'auto';
  cfg.sentinel.deny_rules = [];
  return cfg;
}

function tempProject(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-cancel-'));
  // A killed child process can still hold the directory for a moment.
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {} });
  return dir;
}

// A provider that never answers on its own: only the abort signal ends it,
// exactly like a real streaming request.
function stallingProvider() {
  const state = { aborted: false, calls: 0 };
  const chat = async (_messages: any, _tools: any, opts: any = {}) => {
    state.calls++;
    await new Promise((_resolve, reject) => {
      const signal = opts.signal;
      if (!signal) return;   // never settles - the caller hangs, as a real hung request would
      if (signal.aborted) { state.aborted = true; reject(Object.assign(new Error('cancelled by user'), { name: 'AbortError' })); return; }
      signal.addEventListener('abort', () => {
        state.aborted = true;
        reject(Object.assign(new Error('cancelled by user'), { name: 'AbortError' }));
      }, { once: true });
    });
    return { message: { role: 'assistant', content: 'never' }, finish_reason: 'stop', usage: { total_tokens: 1 } };
  };
  return { chat, state };
}

test('cancelling a stalled LLM call ends the turn immediately', async t => {
  const dir = tempProject(t);
  const agent = new Agent(config(), { approver: async () => true });
  agent.setProjectScope(dir);
  const provider = stallingProvider();
  agent.llm.chat = provider.chat as any;

  const started = Date.now();
  const run = agent.run('Do something long.');
  // Let the request actually reach the provider before cancelling.
  await new Promise(r => setTimeout(r, 50));
  agent.requestCancel();
  const result = await run;
  const elapsed = Date.now() - started;

  assert.equal(result.cancelled, true, 'the run reports itself as cancelled');
  assert.ok(elapsed < 3000, `the turn ended promptly (took ${elapsed}ms), not after a backoff`);
  assert.equal(provider.state.aborted, true, 'the in-flight request was aborted');
});

test('cancelling does not start the next queued turn', async t => {
  const dir = tempProject(t);
  const agent = new Agent(config(), { approver: async () => true });
  agent.setProjectScope(dir);
  const provider = stallingProvider();
  agent.llm.chat = provider.chat as any;

  const run = agent.run('First.');
  await new Promise(r => setTimeout(r, 50));
  agent.requestCancel();
  const result = await run;
  assert.equal(result.cancelled, true);
  // The cancelled turn must be the last thing that happened: no second
  // request may be started after the cancel.
  const callsAtCancel = provider.state.calls;
  await new Promise(r => setTimeout(r, 100));
  assert.equal(provider.state.calls, callsAtCancel, 'no further provider call after the cancel');
});

test('a running shell command is killed when the turn is cancelled', async t => {
  const dir = tempProject(t);
  const agent = new Agent(config(), { approver: async () => true });
  agent.setProjectScope(dir);
  const marker = path.join(dir, 'should-not-exist.txt');
  // The shell tool waits for a file that never appears: only the abort ends it.
  agent.toolMap.set('shell', {
    run: async (_args: any, ctx: any) => {
      await new Promise((resolve, reject) => {
        const signal = ctx.signal;
        const t = setTimeout(() => resolve({ ok: true, output: 'timeout' }), 60000);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        }, { once: true });
      });
      return { ok: true, output: 'done' };
    },
  });
  agent.llm.chat = (async (_m: any, _t: any, _o: any) => ({
    message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'sleep' }) } }] },
    finish_reason: 'tool_calls', usage: { total_tokens: 1 },
  })) as any;

  const started = Date.now();
  const run = agent.run('Run the slow command.');
  await new Promise(r => setTimeout(r, 80));
  agent.requestCancel();
  const result = await run;
  const elapsed = Date.now() - started;
  assert.equal(result.cancelled, true);
  assert.ok(elapsed < 5000, `the tool was interrupted (took ${elapsed}ms)`);
  assert.equal(fs.existsSync(marker), false);
});

test('an aborted request is a cancel, not a 120s timeout', async t => {
  const http = require('node:http');
  const { LlmClient } = require('../llm.js');
  // A server that accepts the request and never answers.
  const server = http.createServer(() => { /* hang */ });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as any).port;
  const client = new LlmClient({ llm: { base_url: `http://127.0.0.1:${port}`, model: 'fixture', api_key: 'sk-test', timeout_s: 120 } });
  const ac = new AbortController();
  const started = Date.now();
  const pending = client.chat([{ role: 'user', content: 'hello' }], null, { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(() => pending, (err: any) => {
    assert.equal(err.name, 'AbortError', 'the failure is a cancel');
    assert.doesNotMatch(err.message, /timeout/i, 'a cancel must not be reported as a timeout');
    return true;
  });
  assert.ok(Date.now() - started < 3000);
});

test('a cancel during the retry backoff ends the wait immediately', async t => {
  const http = require('node:http');
  const { LlmClient } = require('../llm.js');
  let hits = 0;
  const server = http.createServer((_req: any, res: any) => {
    hits++;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'server error' } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as any).port;
  const client = new LlmClient({ llm: { base_url: `http://127.0.0.1:${port}`, model: 'fixture', api_key: 'sk-test', timeout_s: 120, retry_attempts: 5 } });
  const ac = new AbortController();
  const started = Date.now();
  const pending = client.chat([{ role: 'user', content: 'hello' }], null, { signal: ac.signal });
  // Cancel while the client sits in its 2s backoff.
  setTimeout(() => ac.abort(), 400);
  await assert.rejects(() => pending, (err: any) => {
    assert.equal(err.name, 'AbortError');
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `the backoff was cut short (took ${elapsed}ms)`);
  assert.equal(hits, 1, 'no retry was attempted after the cancel');
});

test('the shell tool passes the abort signal to the process', async t => {
  const dir = tempProject(t);
  const agent = new Agent(config(), { approver: async () => true });
  agent.setProjectScope(dir);
  const { buildTools } = require('../tools.js');
  const list = buildTools(config()).tools.find((x: any) => x.name === 'shell') as any;
  const ac = new AbortController();
  const ctx: any = { cwd: dir, cfg: config(), signal: ac.signal, tainted: false, netPolicy: { allowLocal: false } };
  const started = Date.now();
  const pending = list.run({ command: `${process.platform === 'win32' ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30'}` }, ctx);
  setTimeout(() => ac.abort(), 150);
  const result = await pending;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `the command died with the signal (took ${elapsed}ms)`);
  assert.equal(result.cancelled, true, 'the tool reports the cancellation');
});
