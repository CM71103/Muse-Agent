'use strict';
// bridge.js - host bridge: loopback-only HTTP API into the RUNNING agent
// (Antigravity's host-bridge concept, minus ConnectRPC/protobuf — plain JSON).
// Lets scripts, hotkeys, other local apps drive the same live agent instance
// the desktop app uses, instead of spawning their own.
//
// Security model (mirrors the hands sidecar):
//   - binds 127.0.0.1 only, never 0.0.0.0
//   - bearer token required, timing-safe compare; token generated into
//     ~/.muse-agent/bridge_token (mode 600) on first start
//   - host header must be loopback (blocks DNS-rebinding)
//   - send() during a busy agent returns 409, never queues or preempts
//
// Endpoints (all JSON):
//   GET  /health           {ok, busy, version}
//   GET  /status           {ok, busy, session_id, project_dir, tools[]}
//   POST /send   {text}    runs agent turn; returns {ok, text, turns}
//   GET  /sessions         {ok, sessions:[...]}
//   POST /cancel           cancels the running turn
//   POST /reset            resets the session (blocked while busy)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

function tokenFile() {
  const dir = process.env.MUSE_HOME || path.join(os.homedir(), '.muse-agent');
  return path.join(dir, 'bridge_token');
}

function ensureToken() {
  const f = tokenFile();
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  const tok = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, tok, { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch {}   // Windows: no-op, ACL default
  return tok;
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) {
    // compare against a dummy of same length to keep timing uniform, then fail
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

// deps: {getStatus, send, cancel, reset, listSessions} — injected so bridge
// never imports Electron. port 0 = pick ephemeral (returned).
function startBridge({ port = 0, deps }) {
  const token = ensureToken();
  const server = http.createServer(async (req, res) => {
    const reply = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      // host-header validation (DNS rebinding guard)
      if (!isLoopbackHost(req.headers.host)) { reply(403, { ok: false, error: 'forbidden host' }); return; }
      // bearer token
      const auth = String(req.headers.authorization || '');
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (!m || !timingSafeEqualStr(m[1].trim(), token)) {
        reply(401, { ok: false, error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /health') {
        const st = deps.getStatus();
        reply(200, { ok: true, busy: !!st.busy, version: st.version || '0.1.3' });
        return;
      }
      if (route === 'GET /status') {
        const st = deps.getStatus();
        reply(200, { ok: true, busy: !!st.busy, session_id: st.sessionId || null, project_dir: st.projectDir || null, tools: st.tools || [] });
        return;
      }
      if (route === 'GET /sessions') {
        reply(200, { ok: true, sessions: await deps.listSessions() });
        return;
      }
      if (route === 'POST /send') {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (body.length > 200000) { reply(413, { ok: false, error: 'payload too large' }); return; }
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { reply(400, { ok: false, error: 'invalid JSON' }); return; }
        const text = String(parsed.text || '');
        if (!text.trim()) { reply(400, { ok: false, error: 'empty text' }); return; }
        const st = deps.getStatus();
        if (st.busy) { reply(409, { ok: false, error: 'agent busy' }); return; }
        const out = await deps.send(text);
        reply(200, out);
        return;
      }
      if (route === 'POST /cancel') {
        reply(200, await deps.cancel());
        return;
      }
      if (route === 'POST /reset') {
        const st = deps.getStatus();
        if (st.busy) { reply(409, { ok: false, error: 'agent busy' }); return; }
        reply(200, await deps.reset());
        return;
      }
      reply(404, { ok: false, error: 'not found' });
    } catch (e) {
      reply(500, { ok: false, error: String(e && e.message || e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        tokenFile: tokenFile(),
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

module.exports = { startBridge, ensureToken, tokenFile, timingSafeEqualStr, isLoopbackHost };
