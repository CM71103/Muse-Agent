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

// --- sidecar supervisor (Antigravity languageServer.js pattern) ---
// Watch spawned sidecar processes: track exits, restart within a sliding
// window, give up after max restarts. State surfaces via onSupervision so the
// host can notify/log. Spawn is a module-global: the supervisor survives
// handsClient() re-construction (client is created per tool call today).
const supervisor = {
  proc: null,
  restarts: 0,
  windowStart: 0,
  onSupervision: null,             // set by host: (msg) => void
  RESTART_WINDOW_MS: 5 * 60 * 1000,
  MAX_RESTARTS: 3,
};

function superviseNote(msg) {
  try { if (supervisor.onSupervision) supervisor.onSupervision(msg); } catch {}
  try { console.log(`[hands] ${msg}`); } catch {}
}

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

// Wire a spawned sidecar process into supervision: stderr notes, exit/restart
// policy, proc registry. Shared by the python-path spawn and the py-launcher
// fallback so both get identical treatment.
function attachToSupervisor(proc) {
  let errBuf = '';
  try {
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      errBuf = (errBuf + d).slice(-1500);
      const lines = errBuf.trim().split(/\r?\n/);
      const tail = lines.slice(-3).join(' | ');
      if (tail) superviseNote(`sidecar stderr: ${tail}`);
    });
  } catch {}
  proc.on('error', () => { starting = null; superviseNote('sidecar spawn error (python not found?)'); });
  proc.on('exit', (code) => {
    if (supervisor.proc !== proc) return;      // replaced already
    supervisor.proc = null;
    starting = null;
    const now = Date.now();
    if (supervisor.windowStart === 0 || now - supervisor.windowStart > supervisor.RESTART_WINDOW_MS) {
      supervisor.windowStart = now;
      supervisor.restarts = 0;
    }
    if (/10048|address already in use/i.test(errBuf)) {
      superviseNote('sidecar port already occupied — stopped duplicate process; no restart');
      return;
    }
    supervisor.restarts++;
    if (supervisor.restarts > supervisor.MAX_RESTARTS) {
      superviseNote(`sidecar exited (code ${code}) — restart cap reached (${supervisor.MAX_RESTARTS}); giving up. Toggle hands off/on to retry.`);
      return;
    }
    superviseNote(`sidecar exited unexpectedly (code ${code}) — restarting (${supervisor.restarts}/${supervisor.MAX_RESTARTS})`);
    setImmediate(() => { try { startSidecar(); } catch {} });
  });
  supervisor.proc = proc;
  proc.unref();
  return proc;
}

function spawnSidecarProcess() {
  const pyExe = process.env.MUSE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const args = ['-m', 'muse_hands.server'];
  const spawnOpts = {
    cwd: SIDECAR_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform === 'win32' ? false : true,
  };
  const proc = spawn(pyExe, args, spawnOpts);
  // PATH-independent fallback: the py launcher lives in C:\Windows and finds
  // every registered python even when PATH is broken. Fires on spawn error
  // (ENOENT), i.e. python not resolvable.
  proc.on('error', () => {
    if (process.platform === 'win32' && !/\.exe$/i.test(pyExe)) {
      try {
        const alt = spawn('py', ['-3', ...args], spawnOpts);
        superviseNote(`python ("${pyExe}") not on PATH — sidecar via py launcher`);
        attachToSupervisor(alt);
      } catch { superviseNote('sidecar spawn error (no python on PATH and py launcher failed)'); }
      return;
    }
    superviseNote('sidecar spawn error (python not found?)');
  });
  return attachToSupervisor(proc);
}

function startSidecar() {
  if (starting) return starting;
  const proc = spawnSidecarProcess();
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
          if (res.status === 401 || res.status === 403) throw Object.assign(new Error('sidecar rejected token'), { noSpawn: true });
          if (!res.ok) {
            let detail = '';
            try { detail = (await res.text()).slice(0, 200); } catch {}
            throw Object.assign(new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`), { noSpawn: true });
          }
          try { return await res.json(); }
          catch (e) { e.noSpawn = true; throw e; }
        } catch (e) {
          if (e.noSpawn) throw e; // HTTP errors prove a server is already listening.
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
module.exports.supervisor = supervisor;    // host sets onSupervision for UI/log
