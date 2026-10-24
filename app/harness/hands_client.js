'use strict';
// hands_client.js - Node client for the Python hands sidecar (127.0.0.1, bearer token).
// Auto-starts sidecar on first call, waits for health, then POSTs actions.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// packaged: sidecar ships in resources/python (can't exec from inside asar)
const SIDECAR_DIR = (typeof process.resourcesPath === 'string' && process.resourcesPath)
  ? path.join(process.resourcesPath, 'python')
  : path.join(__dirname, '..', '..', 'python');

function handsTokenFile() {
  return process.env.MUSE_HOME
    ? path.join(process.env.MUSE_HOME, 'hands_token')
    : path.join(os.homedir(), '.muse-agent', 'hands_token');
}

function ensureToken() {
  const file = handsTokenFile();
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tok = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, tok, { mode: 0o600 });
  return tok;
}

let starting = null;

async function waitForHealth(base, token, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function startSidecar() {
  if (starting) return starting;
  const pyExe = process.env.MUSE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const proc = spawn(pyExe, ['-m', 'muse_hands.server'], {
    cwd: SIDECAR_DIR,
    stdio: 'ignore',
    detached: process.platform === 'win32' ? false : true,
  });
  proc.on('error', () => { starting = null; });
  proc.unref();
  starting = new Promise(r => r(proc.pid));
  return starting;
}

function handsClient(handsCfg) {
  const host = handsCfg.host || '127.0.0.1';
  const port = handsCfg.port || 8788;
  const base = `http://${host}:${port}`;
  const token = ensureToken();

  return {
    async request(action) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`${base}/execute`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(action),
          });
          if (res.status === 401 || res.status === 403) throw new Error('sidecar rejected token');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } catch (e) {
          if (attempt === 0) {
            await startSidecar();
            const ok = await waitForHealth(base, token);
            if (!ok) throw new Error('sidecar did not become healthy (is Python + deps installed? see README)');
            continue;
          }
          throw e;
        }
      }
    },
    async health() {
      try {
        const res = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
        return res.ok;
      } catch { return false; }
    },
  };
}

module.exports = handsClient;
