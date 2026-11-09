'use strict';
// Boot diagnostics: any uncaught error in main is captured to a log file
// before the (silent) process exit, so packaged runs are debuggable.
function appendBootLog(msg) {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    fs.appendFileSync(path.join(os.tmpdir(), 'muse-main-crash.log'),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

process.on('uncaughtException', (e) => {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    fs.appendFileSync(path.join(os.tmpdir(), 'muse-main-crash.log'),
      `[${new Date().toISOString()}] uncaught: ${e && e.stack || e}\n`);
  } catch {}
  try { console.error(e); } catch {}
});
process.on('unhandledRejection', (e) => {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    fs.appendFileSync(path.join(os.tmpdir(), 'muse-main-crash.log'),
      `[${new Date().toISOString()}] unhandledRejection: ${e && e.stack || e}\n`);
  } catch {}
});

// app/main/index.js - Electron main. Thin shell, nanoMuse-style:
// window + native menus minimal, agent runs in-process (renderer drives it over preload).

const { app, BrowserWindow, Menu, dialog, shell, safeStorage, Tray, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { loadConfig, configDir, userConfigFile } = require('../harness/config');
const { Agent } = require('../harness/agent');
const sessionStore = require('../harness/session');   // used by sessions:* IPC below

let mainWindow = null;
let agent = null;
let memoryError = null;
let agentBusy = false;
let pendingApprovals = new Map(); // id -> {resolve, request}
let pendingQuestions = new Map(); // id -> {resolve, q}
let currentProjectDir = null;
let currentProjectId = null;
const projectStore = require('../harness/projects');

function ensureConfigFile() {
  const file = userConfigFile();
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // packaged build seeds from bundled template (carries the build-time config);
  // dev falls back to config.example.toml
  let src = null;
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    const template = path.join(process.resourcesPath, 'template.toml');
    if (fs.existsSync(template)) src = template;
  }
  if (!src) {
    const example = path.join(__dirname, '..', '..', 'config.example.toml');
    if (fs.existsSync(example)) src = example;
  }
  if (src) fs.copyFileSync(src, file);
  return file;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 700,
    minHeight: 480,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    backgroundColor: '#f2f3f2',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    try {
      // Force-raise: always-on-top for the first moment pulls the window
      // above anything covering it, then we drop the flag.
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
      setTimeout(() => { try { mainWindow.setAlwaysOnTop(false); } catch {} }, 1500);
      appendBootLog(`window shown: bounds=${JSON.stringify(mainWindow.getBounds())} visible=${mainWindow.isVisible()}`);
      setTimeout(() => {
        try {
          appendBootLog(`+1s check: visible=${mainWindow.isVisible()} minimized=${mainWindow.isMinimized()} focused=${mainWindow.isFocused()} bounds=${JSON.stringify(mainWindow.getBounds())}`);
        } catch {}
      }, 1000);
    } catch {}
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    appendBootLog(`renderer load FAILED: ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    appendBootLog(`renderer GONE: ${JSON.stringify(details)}`);
  });

  // Navigation/popup policy: this is a single-page local app. Deny everything
  // that is not our own page; hand real http(s) links to the system browser.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isRendererUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// IPC caller check: only our own top-level renderer frame may invoke handlers.
// Comparison is resilient rather than exact: file URLs differ in drive-letter
// case, slash direction and percent-encoding depending on how the page loaded.
const RENDERER_PATH = path.resolve(__dirname, '..', 'renderer', 'index.html').replace(/\\/g, '/').toLowerCase();

function isRendererUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'file:') return false;
    let p = decodeURIComponent(url.pathname).replace(/\\/g, '/').toLowerCase();
    if (/^\/[a-z]:/.test(p)) p = p.slice(1);          // file:///D:/... -> d:/...
    p = p.replace(/\/{2,}/g, '/');                     // collapse doubled slashes
    return p === RENDERER_PATH;
  } catch { return false; }
}

function trustedSender(e) {
  try {
    const f = e.senderFrame;
    if (!f || f.parent) return false;                  // sub-frames never trusted
    if (!isRendererUrl(f.url)) return false;
    // Sender must be our main window's webContents (not devtools/other windows).
    return mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents;
  } catch (err) {
    console.error('[ipc] sender check exception:', err && err.message);
    return false;
  }
}
function requireTrusted(e) {
  if (!trustedSender(e)) {
    // Diagnostic only — never logs payloads, just channel + frame URL shape.
    let frameUrl = 'unknown';
    try { frameUrl = String(e.senderFrame && e.senderFrame.url || 'no-frame'); } catch { frameUrl = 'frame-error'; }
    console.error(`[ipc] rejected caller: frame=${frameUrl}`);
    throw new Error('untrusted IPC caller');
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function secureConfig() {
  const cfg=loadConfig();
  const credentials=require('../harness/credentials').vault(safeStorage,configDir());
  const saved=credentials.read();
  if (cfg.llm.api_key || cfg.memory.embed_api_key) {
    credentials.write({...saved,...(cfg.llm.api_key ? {llm:cfg.llm.api_key, llm_origin: originOf(cfg.llm.base_url) || saved.llm_origin || ''} : {}),...(cfg.memory.embed_api_key ? {embed:cfg.memory.embed_api_key} : {})});
    cfg.llm.api_key=''; cfg.memory.embed_api_key='';
    require('../harness/configWrite').writeSections(cfg,cfg._configFile);
  }
  const keys=credentials.read();
  cfg.llm.api_key=keys.llm || ''; cfg.memory.embed_api_key=keys.embed || '';
  cfg.llm.key_origin=keys.llm_origin || '';
  return cfg;
}

// ---- tray + desktop notifications (Antigravity pattern) ----
let tray = null;
let trayBusy = false;         // last known busy state pushed to tray

function windowUnfocused() {
  return !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused();
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    if (!windowUnfocused()) return;          // focused: skip, chat visible
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { try { showMainWindow(); } catch {} });
    n.show();
  } catch {}
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTray() {
  try {
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
    let image = null;
    try { image = nativeImage.createFromPath(iconPath); } catch {}
    if (!image || image.isEmpty()) image = nativeImage.createEmpty();
    if (image && !image.isEmpty()) image = image.resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip('Muse Agent');
    updateTray();
    tray.on('click', () => showMainWindow());
  } catch (e) {
    console.error('[tray] failed:', e.message);
    tray = null;
  }
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const label = agentBusy ? 'Muse — working…' : 'Muse — idle';
  const cancelState = agentBusy ? 'enabled' : 'disabled';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Show window', click: () => showMainWindow() },
    { label: 'New session', enabled: !agentBusy, click: () => { if (agentBusy) return; agent && agent.reset(); send('session-reset', {}); } },
    { label: 'Cancel current turn', enabled: agentBusy, click: () => { if (agent && agentBusy) agent.requestCancel(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { try { app.quit(); } catch {} } },
  ]));
  tray.setToolTip(label);
}

function setBusyState(busy) {
  agentBusy = busy;
  if (busy !== trayBusy) { trayBusy = busy; updateTray(); }
}

// MCP servers start once per app run (Antigravity-style tool extensibility).
// Idempotent; failures degrade to no MCP tools, never block the agent.
let mcpStarted = false;
let mcpPromise = null;
function ensureMcp(cfg) {
  if (mcpStarted) return mcpPromise;
  if (!cfg.mcp || !Array.isArray(cfg.mcp.servers) || !cfg.mcp.servers.length) {
    mcpStarted = true; mcpPromise = Promise.resolve([]);
    return mcpPromise;
  }
  mcpStarted = true;
  mcpPromise = require('../harness/mcp').startMcpServers(cfg, (msg) => {
    console.log(msg);
    send('agent-event', { type: 'info', text: msg });
  }).catch(() => []);
  return mcpPromise;
}

async function mkAgent(opts = {}) {
  const cfg = secureConfig();
  memoryError = null;
  await ensureMcp(cfg);   // tool discovery must precede tool registry build
  const a = new Agent(cfg, {
    approver: (request) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      pendingApprovals.set(id, { resolve, request });
      notify('Muse needs approval', `Tool "${request.tool}" is waiting for you${request.subagent ? ' (subagent)' : ''}`);
      send('approval-request', { id, tool: request.tool, args: request.args, subagent: !!request.subagent, subagentId: request.subagentId });
    }),
    questionAsker: (q) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      pendingQuestions.set(id, { resolve, q });
      send('agent-question', { id, question: q.question, options: q.options || [], subagent: !!q.subagent, subagentId: q.subagentId });
    }),
    onEvent: (ev) => {
      // Memory hiccups are recoverable; do not let the UI treat them as fatal.
      if (ev && ev.type === 'error' && typeof ev.text === 'string' && /^memory:/.test(ev.text)) {
        send('agent-event', { ...ev, type: 'info' });
        return;
      }
      // Desktop notifications (Antigravity pattern): surface approval requests
      // and turn completion when the window is unfocused/minimized.
      if (ev && ev.type === 'done') notify('Muse finished', 'Turn complete.');
      send('agent-event', ev);
    },
  });
  a.projectId = currentProjectId;
  // Restore project scope + grants from previous agent (settings/scope rebuilds).
  if (opts.projectDir) a.setProjectScope(opts.projectDir);
  if (opts.history) a.history = opts.history;
  if (opts.sessionId) a.sessionId = opts.sessionId;
  if (opts.tainted) a.tainted = opts.tainted;
  if (opts.memoryTurnId) a.lastMemoryTurnId = opts.memoryTurnId;
  // Approval expiry: surface it, clear UI state, unblock composer.
  a.sentinel.onExpiry((request) => {
    // Sentinel passes the original request object. Remove only its matching
    // entries so stale timeouts cannot block model changes after a turn ends.
    for (const [id, pending] of pendingApprovals) {
      if (pending.request !== request) continue;
      pendingApprovals.delete(id);
      pending.resolve(false);
    }
    send('approval-expired', {});
  });
  // memory layer (R-49 host contract) — only when enabled; failures degrade to memoryless
  if (cfg.memory && cfg.memory.enabled && !opts.skipMemory) {
    try {
      const { MemoryLayer } = require('../memory/layer');
      const mem = new MemoryLayer(cfg, {
        dataDir: path.join(configDir(), 'memory'),
        cwd: opts.projectDir || null,
        allowFolderScope: true,
      });
      a.attachMemory(mem);
    } catch (e) {
      memoryError = e.message;
      console.error('memory layer disabled:', e.message);
      send('agent-event', { type: 'error', text: `memory layer disabled: ${e.message}` });
    }
  }
  return a;
}

const menu = Menu.buildFromTemplate([
  {
    label: 'Muse',
    submenu: [
      { label: 'New session', accelerator: 'CmdOrCtrl+N', click: () => { if(agentBusy)return; agent && agent.reset(); send('session-reset', {}); } },
      { type: 'separator' },
      { role: 'quit' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  },
  {
    label: 'Help',
    submenu: [
      {
        label: 'Open config folder',
        click: () => { ensureConfigFile(); shell.openPath(configDir()); },
      },
      { label: 'About', click: () => dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'Muse Agent',
        message: 'Muse Agent 0.1.0', detail: 'Personal AI agent. Tools are approval-gated by Sentinel.',
      }) },
    ],
  },
]);

// ---- host bridge: loopback HTTP API into the running agent ----
// Antigravity-style: external local tools/scripts drive the SAME live agent.
// Bearer-token gated; bind 127.0.0.1 only; off-by-default port (config) or
// ephemeral. Started with the app; failure logs, never blocks startup.
let bridge = null;
async function startBridgeIfConfigured() {
  const cfg = loadConfig();
  const bp = cfg.bridge || {};
  if (bp.enabled === false) return null;          // explicit opt-out
  try {
    const { startBridge } = require('../harness/bridge');
    bridge = await startBridge({
      port: Number(bp.port) || 0,
      deps: {
        getStatus: () => ({
          busy: agentBusy,
          version: app.getVersion ? app.getVersion() : '0.1.3',
          sessionId: agent ? agent.sessionId : null,
          projectDir: currentProjectDir,
          tools: agent ? agent.tools.map(t => t.name) : [],
        }),
        send: async (text) => {
          // Reuse the same IPC path logic minus the IPC layer: guard busy twice.
          if (agentBusy) return { ok: false, error: 'Agent busy; wait for current turn.' };
          if (!agent) agent = await mkAgent({ projectDir: currentProjectDir });
          const raw = String(text).slice(0, 100000);
          setBusyState(true);
          try {
            const res = await agent.run(raw, {});
            await agent.ingestUserTurn(raw);
            return { ok: true, text: res.text, turns: res.turns };
          } catch (e) {
            send('agent-event', { type: 'error', text: String(e && e.message || e) });
            return { ok: false, error: String(e && e.message || e) };
          } finally { setBusyState(false); }
        },
        cancel: async () => {
          if (agent && agentBusy) agent.requestCancel();
          return { ok: true };
        },
        reset: async () => {
          if (agent) {
            const events = (agent._sourceEvents || []).slice();
            agent._sourceEvents = [];
            if (agent.memory && events.length) agent.memory.extractSession(events).catch(() => {});
            agent.reset();
            agent.sentinel.clearGrants();
            agent.setProjectScope(currentProjectDir);
          }
          return { ok: true };
        },
        listSessions: async () => sessionStore.list(),
      },
    });
    console.log(`[bridge] host bridge listening on 127.0.0.1:${bridge.port} (token: ${bridge.tokenFile})`);
    return bridge;
  } catch (e) {
    console.error('[bridge] failed to start:', e.message);
    bridge = null;
    return null;
  }
}

app.whenReady().then(async () => {
  ensureConfigFile();
  Menu.setApplicationMenu(menu);
  createWindow();
  buildTray();
  startBridgeIfConfigured();
  startUpdateChecks();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// ---- update checks (notify-only; portable exe cannot hot-swap itself) ----
function startUpdateChecks() {
  const { checkUpdate } = require('../harness/updater');
  const CHECK_MS = 6 * 60 * 60 * 1000;   // every 6h
  const run = async () => {
    const cur = app.getVersion ? app.getVersion() : '0.1.3';
    const res = await checkUpdate(cur);
    if (!res.update) return;
    send('agent-event', { type: 'info', text: `update available: v${res.latest} — click the notification or see ${res.url}` });
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: `Muse Agent ${res.latest} available`, body: 'Click to open the download page.' });
        n.on('click', () => shell.openExternal(res.url));
        n.show();
      }
    } catch {}
  };
  setTimeout(run, 15 * 1000).unref?.();   // shortly after boot, off the startup path
  setInterval(run, CHECK_MS).unref?.();
}

let shutdownDrain = null;
let shutdownReady = false;
app.on('before-quit', event => {
  if (shutdownReady) return;
  if (bridge) { try { bridge.close(); } catch {} }
  if (shutdownDrain) { event.preventDefault(); return; }
  // Start the buffered session extraction before close takes its drain
  // snapshot; endSessionExtract registers it synchronously before awaiting.
  if (agent && agent.memory) agent.endSessionExtract().catch(error => console.error('memory shutdown extraction failed:', error.message));
  const result = agent && agent.memory ? agent.memory.close() : null;
  if (result && typeof result.then === 'function') {
    event.preventDefault();
    setBusyState(true);
    shutdownDrain = result.catch(error => console.error('memory shutdown drain failed:', error.message))
      .finally(() => { shutdownReady = true; app.quit(); });
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- ipc surface (registered in preload) ----
const { ipcMain } = require('electron');

ipcMain.handle('agent:send', async (e, text) => {
  requireTrusted(e);
  if (agentBusy) return {ok:false,error:'Agent busy; wait for current turn.'};
  if (!agent) agent = await mkAgent({ projectDir: currentProjectDir });
  const raw = String(text || '').slice(0, 100000);
  try {
    // /good /bad — grade the most recent graded-eligible turn (R-49 obligation 6)
    const gradeMatch = /^(\/good|\/bad)\s*$/i.exec(raw.trim());
    if (gradeMatch && agent.lastMemoryTurnId) {
      const r = /^\/good$/i.test(gradeMatch[1]) ? 1 : 0;
      const res = agent.memory
        ? agent.memory.grade(agent.lastMemoryTurnId, r)
        : { ok: false, reason: 'memory_disabled' };
      const note = res.ok
        ? `memory: grade r=${r} recorded${res.applied === false ? ' (baseline: recorded, not applied)' : ''}`
        : `memory: grade not accepted (${res.reason})`;
      send('agent-event', { type: 'info', text: note });
      return { ok: true, text: note, turns: 0 };
    }
    if (gradeMatch && !agent.lastMemoryTurnId) {
      const note = 'memory: no gradeable turn in this session yet';
      send('agent-event', { type: 'info', text: note });
      return { ok: true, text: note, turns: 0 };
    }
    // /compact — force context compaction now (summarize old turns via LLM)
    if (/^\/compact\s*$/i.test(raw.trim())) {
      const compacted = await agent.compactHistory(true);
      const note = compacted
        ? `context compacted (${agent.estimateHistoryTokens()} tokens in context now)`
        : 'context already small; nothing to compact';
      send('agent-event', { type: 'info', text: note });
      return { ok: true, text: note, turns: 0 };
    }
    setBusyState(true);
    const project = currentProjectId ? projectStore.get(currentProjectId) : null;
    const projectInstructions = project && project.instructions ? `User project instructions (do not override tool approval or safety rules):\n${project.instructions}` : '';
    const res = await agent.run(raw, { systemExtra: projectInstructions });
    // remember the turn id for /good /bad grading
    agent.lastMemoryTurnId = res.memory_turn_id || agent.lastMemoryTurnId;
    await agent.ingestUserTurn(raw);   // fire-and-forget ingestion (obligation 1)
    return { ok: true, text: res.text, turns: res.turns };
  } catch (e) {
    send('agent-event', { type: 'error', text: String(e && e.message || e) });
    return { ok: false, error: String(e && e.message || e) };
  } finally { setBusyState(false); }
});

ipcMain.handle('agent:reset', async (e) => {
  requireTrusted(e);
  if (agentBusy) return {ok:false,error:'Agent busy'};
  if (agent) {
    // Session-end extraction must not block the UI reset: on slow/reasoning
    // extraction models the LLM call alone can take ~30-90s (30s timeout x
    // retries). Snapshot events, reset immediately, extract in the background
    // (extraction is fire-and-forget by contract — failures log, never throw).
    const events = (agent._sourceEvents || []).slice();
    agent._sourceEvents = [];
    if (agent.memory && events.length) {
      agent.memory.extractSession(events).catch(() => {});   // self-logs failures
    }
    agent.reset();
    agent.sentinel.clearGrants();
    agent.setProjectScope(currentProjectDir);
  }
  if (!agent) agent = await mkAgent({ projectDir: currentProjectDir });
  agent.projectId = currentProjectId;
  sessionStore.save({ id: agent.sessionId, projectId: currentProjectId, title: 'New session', history: agent.history, created: agent.sessionCreated });
  return { ok: true };
});

// Cancel the running turn: aborts the LLM call and unwinds the tool loop.
ipcMain.handle('agent:cancel', async (e) => {
  requireTrusted(e);
  if (agent && agentBusy) agent.requestCancel();
  return { ok: true };
});

ipcMain.handle('approval:respond', async (e, { id, approved }) => {
  requireTrusted(e);
  const p = pendingApprovals.get(String(id || ''));
  if (!p) return { ok: false, error: 'stale approval' };
  pendingApprovals.delete(String(id));
  p.resolve(!!approved);
  return { ok: true };
});

ipcMain.handle('question:respond', async (e, { id, answer, cancelled }) => {
  requireTrusted(e);
  const p = pendingQuestions.get(String(id || ''));
  if (!p) return { ok: false, error: 'stale question' };
  pendingQuestions.delete(String(id));
  p.resolve(cancelled ? { cancelled: true } : { answer: String(answer || '') });
  return { ok: true };
});

// Project / no-project scope. '' or null = no-project mode (chat works, reads
// ask per path). A folder path grants automatic reads/listing inside it.
function activateProject(id) {
  const p = id ? projectStore.get(id) : null;
  if (id && !p) throw Error('Project not found');
  if (agent) agent.persist();
  currentProjectId = p ? p.id : null;
  currentProjectDir = p ? p.folder : null;
  if (agent) { agent.reset(); agent.projectId = currentProjectId; agent.setProjectScope(currentProjectDir); }
  return { ok: true, project: currentProjectDir, projectId: currentProjectId, name: p ? p.name : null };
}
ipcMain.handle('projects:list', async e => { requireTrusted(e); return projectStore.list(); });
ipcMain.handle('projects:update', async (e,id,patch) => {
  requireTrusted(e);
  if(agentBusy)return {ok:false,error:'Agent busy'};
  try{return {ok:true,record:projectStore.update(id,patch || {})};}catch(err){return {ok:false,error:err.message};}
});
ipcMain.handle('projects:create', async (e, name) => {
  requireTrusted(e);
  if (agentBusy) return {ok:false,error:'Agent busy'};
  try { const p=projectStore.create(name); return {...activateProject(p.id),record:p}; }
  catch(err){return {ok:false,error:err.message};}
});
ipcMain.handle('projects:select', async (e,id) => {
  requireTrusted(e);
  if(agentBusy)return {ok:false,error:'Agent busy'};
  try{return activateProject(id || null);}catch(err){return {ok:false,error:err.message};}
});

ipcMain.handle('project:browse', async (e) => {
  requireTrusted(e);
  if (agentBusy) return { ok: false, error: 'Agent busy' };
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose project folder',
    properties: ['openDirectory', 'dontAddToRecent'],
    defaultPath: currentProjectDir || undefined,
  });
  if (agentBusy) return { ok: false, error: 'Agent busy' };
  if (res.canceled || !res.filePaths.length) return { ok: false, error: 'cancelled' };
  const p = path.resolve(res.filePaths[0]);
  currentProjectDir = p;
  if (currentProjectId) projectStore.setFolder(currentProjectId,p);
  if (agent) agent.setProjectScope(p);
  return { ok: true, project: p };
});

ipcMain.handle('project:set', async (e, dir) => {
  requireTrusted(e);
  if (agentBusy) return { ok: false, error: 'Agent busy' };
  if (dir == null || dir === '') {
    currentProjectDir = null;
    if (currentProjectId) projectStore.setFolder(currentProjectId,null);
    if (agent) agent.setProjectScope(null);
    return { ok: true, project: null };
  }
  const p = path.resolve(String(dir));
  let st;
  try { st = await fs.promises.stat(p); } catch { return { ok: false, error: 'folder not found' }; }
  if (!st.isDirectory()) return { ok: false, error: 'not a folder' };
  currentProjectDir = p;
  if (currentProjectId) projectStore.setFolder(currentProjectId,p);
  if (agent) agent.setProjectScope(p);
  return { ok: true, project: p };
});

ipcMain.handle('project:get', async (e) => {
  requireTrusted(e);
  return { ok: true, project: currentProjectDir, projectId: currentProjectId, name: currentProjectId ? projectStore.get(currentProjectId)?.name : null };
});

ipcMain.handle('config:get', async (e) => {
  requireTrusted(e);
  ensureConfigFile();
  const cfg = loadConfig();
  return {
    configFile: cfg._configFile || userConfigFile(),
    llm: {
      provider: cfg.llm.provider,
      base_url: cfg.llm.base_url,
      model: cfg.llm.model,
      visible_models: require('./connection-settings.ts').visibleModels(cfg),
      has_key: !!(cfg.llm.api_key || process.env[cfg.llm.api_key_env]),
    },
    sentinel: { mode: cfg.sentinel.mode, deny_rules: cfg.sentinel.deny_rules },
  };
});

ipcMain.handle('sessions:list', async (e) => { requireTrusted(e); return sessionStore.list(); });

// ---- MCP servers (settings UI CRUD) ----
// Config shape (already read by harness/mcp.js startMcpServers):
//   [mcp] servers = ["docs"] ; [mcp.server.docs] command/args/env/timeout_s/enabled
// Saves rewrite config via writeSections, then hot-restart MCP clients and
// rebuild the agent so the new tools are registered for the next turn.
ipcMain.handle('mcp:list', async (e) => {
  requireTrusted(e);
  const cfg = secureConfig();
  const servers = (cfg.mcp && cfg.mcp.server) || {};
  const enabled = (cfg.mcp && cfg.mcp.servers) || [];
  return Object.entries(servers).map(([name, s]) => ({
    name,
    command: s.command || '',
    args: Array.isArray(s.args) ? s.args : [],
    env: Array.isArray(s.env) ? s.env : [],
    timeout_s: s.timeout_s || 60,
    enabled: enabled.includes(name),
    // live status from the registry if this run already connected it
    running: !!(mcpRegistry().get(name) && !mcpRegistry().get(name).dead),
    tools: (mcpRegistry().get(name) || { tools: [] }).tools.length,
  }));
});

function _sanitizeMcpServer(s) {
  const out = {};
  if (typeof s.command !== 'string' || !s.command.trim()) throw new Error('MCP server: command required');
  out.command = s.command.trim();
  out.args = (Array.isArray(s.args) ? s.args : []).map(String).filter(a => a.length);
  out.env = (Array.isArray(s.env) ? s.env : []).map(String).filter(x => /^[^=]+=.+/.test(x));
  const t = Number(s.timeout_s);
  if (Number.isFinite(t) && t > 0) out.timeout_s = t;
  return out;
}

ipcMain.handle('mcp:save', async (e, { name, server, enabled } = {}) => {
  try {
    requireTrusted(e);
    if (agentBusy) throw new Error('Agent busy');
    const cfg = secureConfig();
    cfg.mcp = cfg.mcp || { servers: [], server: {} };
    cfg.mcp.server = cfg.mcp.server || {};
    cfg.mcp.servers = Array.isArray(cfg.mcp.servers) ? [...cfg.mcp.servers] : [];
    const n = String(name || '').trim();
    if (!/^[\w.-]{1,32}$/.test(n)) throw new Error('MCP server name: letters/digits/./-/_, max 32 chars');
    cfg.mcp.server[n] = _sanitizeMcpServer(server || {});
    if (enabled !== false && !cfg.mcp.servers.includes(n)) cfg.mcp.servers.push(n);
    if (enabled === false) cfg.mcp.servers = cfg.mcp.servers.filter(x => x !== n);
    const { writeSections } = require('../harness/configWrite');
    writeSections(cfg, ensureConfigFile());
    await _restartMcpAndRebuildAgent();
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('mcp:remove', async (e, { name } = {}) => {
  try {
    requireTrusted(e);
    if (agentBusy) throw new Error('Agent busy');
    const cfg = secureConfig();
    if (!cfg.mcp || !cfg.mcp.server || !(name in cfg.mcp.server)) return { ok: true };
    delete cfg.mcp.server[name];
    cfg.mcp.servers = (cfg.mcp.servers || []).filter(x => x !== name);
    const { writeSections } = require('../harness/configWrite');
    writeSections(cfg, ensureConfigFile());
    await _restartMcpAndRebuildAgent();
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

function mcpRegistry() { return require('../harness/mcp').registry; }

// Restart MCP clients from the CURRENT config, then rebuild the agent so its
// tool registry picks up new MCP tools. Preserves session/history/taint.
async function _restartMcpAndRebuildAgent() {
  mcpStarted = true;                    // neutralize ensureMcp's idempotency guard
  mcpPromise = null;
  mcpRegistry().clear();
  const cfg = secureConfig();
  if (cfg.mcp && Array.isArray(cfg.mcp.servers) && cfg.mcp.servers.length) {
    mcpPromise = require('../harness/mcp').startMcpServers(cfg, (msg) => {
      console.log(msg);
      send('agent-event', { type: 'info', text: msg });
    }).catch(() => []);
  } else {
    mcpPromise = Promise.resolve([]);
  }
  await mcpPromise;
  if (agent) {
    const keepId = agent.sessionId;
    const keepHist = agent.history;
    const keepTaint = agent.tainted;
    const keepMemTurn = agent.lastMemoryTurnId;
    setBusyState(true);
    try {
      agent.endSessionExtract().catch(() => {});
      if (agent.memory) await agent.memory.close();
      agent = await mkAgent({ projectDir: currentProjectDir, skipMemory: false, history: keepHist && keepHist.length ? keepHist : undefined, sessionId: keepId, tainted: keepTaint, memoryTurnId: keepMemTurn });
    } finally { setBusyState(false); }
  }
  send('agent-event', { type: 'info', text: 'mcp servers updated' });
}

ipcMain.handle('sessions:load', async (e, id) => {
  requireTrusted(e);
  if(agentBusy)return {ok:false,error:'Agent busy'};
  if (!agent) agent = await mkAgent({ projectDir: currentProjectDir });
  try {
    const stored = sessionStore.load(String(id));
    if (!stored) throw Error('Session not found');
    const project = stored.projectId ? projectStore.get(stored.projectId) : null;
    currentProjectId = project ? project.id : null;
    currentProjectDir = project ? project.folder : null;
    agent.setProjectScope(currentProjectDir);
    const s = await agent.restore(String(id));
    // replay the restored transcript into the renderer
    for (const m of s.history || []) {
      if (m.role === 'user') send('agent-event', { type: 'restored_user', text: m.content });
      else if (m.role === 'assistant' && m.content) send('agent-event', { type: 'restored_assistant', text: m.content });
      else if (m.role === 'tool') {
        let result;
        try { result = JSON.parse(m.content); } catch { result = undefined; }
        send('agent-event', { type: 'restored_tool', name: m.name || 'tool', result });
      }
    }
    return { ok: true, title: s.title, turns: (s.history || []).length };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('sessions:delete', async (e, id) => {
  requireTrusted(e);
  if (agent && agent.sessionId === id) { agent.reset(); agent.sessionId = null; }
  return { ok: sessionStore.remove(String(id)) };
});

// Permission mode (Claude Code-style): ask | accept_edits | plan | auto.
// Persists to config AND flips the live agent's sentinel mid-session; the
// pending approvals are re-evaluated against the successfully persisted mode.
ipcMain.handle('sentinel:setMode', async (e, mode) => {
  requireTrusted(e);
  if (!['ask', 'accept_edits', 'plan', 'auto'].includes(mode)) return { ok: false, error: 'invalid mode' };
  const cfg = loadConfig();
  cfg.sentinel = cfg.sentinel || {};
  cfg.sentinel.mode = mode;
  const { writeSections } = require('../harness/configWrite');
  writeSections(cfg, cfg._configFile || ensureConfigFile());
  if (agent) {
    agent.sentinel.setMode(mode);
    for (const [id, pending] of pendingApprovals) {
      const verdict = agent.sentinel.decide(pending.request);
      if (verdict.decision === 'ask') continue;
      pendingApprovals.delete(id);
      pending.resolve(verdict.decision === 'allow');
      send('approval-resolved', { id, decision: verdict.decision, reason: 'mode_changed' });
    }
  }
  send('agent-event', { type: 'info', text: `sentinel mode → ${cfg.sentinel.mode}` });
  return { ok: true, mode: cfg.sentinel.mode };
});

// ---- settings ----
const { fetchModels, originOf } = require('../harness/models');
const { apiKey: apiKeyOf } = require('../harness/config');

ipcMain.handle('settings:get', async (e) => {
  requireTrusted(e);
  const cfg = secureConfig();
  return {
    base_url: cfg.llm.base_url,
    model: cfg.llm.model,
    visible_models: require('./connection-settings.ts').visibleModels(cfg),
    api_key: '',      // renderer masks display; key lives in config
    has_key: !!apiKeyOf(cfg),
    api_key_env: cfg.llm.api_key_env,
    temperature: cfg.llm.temperature,
    max_tokens: cfg.llm.max_tokens,
    context_tokens: cfg.llm.context_tokens,
    // embeddings: endpoint + model are user-visible; the key never leaves the vault
    embed_base_url: cfg.memory.embed_base_url || '',
    embed_model: cfg.memory.embed_model || '',
    embed_api_key: '',   // masked like api_key; presence signaled by embed_key_set
    embed_key_set: !!(cfg.memory.embed_api_key || cfg._embedKeyFromVault),
    embed_dims: cfg.memory.embed_dims,
    configFile: cfg._configFile || userConfigFile(),
  };
});

ipcMain.handle('settings:save', async (e, patch) => {
  try {
    requireTrusted(e);
    if (agentBusy) throw new Error('Agent busy');
    const { validateSettingsPatch, assertConnectionKeyOrigins, embeddingSettingsChanged, visibleModels, applyChatSettings } = require('./connection-settings.ts');
    const p = validateSettingsPatch(patch);
    const cfg = secureConfig();
    assertConnectionKeyOrigins(cfg, p);
    if (p.base_url?.trim() && p.base_url.trim().replace(/\/+$/, '') !== String(cfg.llm.base_url).replace(/\/+$/, '') && p.visible_models === undefined) {
      throw new Error('Select visible models explicitly when changing the model endpoint');
    }
    const keyPatch = {};
    if (typeof p.base_url === 'string' && p.base_url.trim()) cfg.llm.base_url = p.base_url.trim();
    if (typeof p.model === 'string' && p.model.trim()) cfg.llm.model = p.model.trim();
    cfg.llm.visible_models = p.visible_models === undefined ? visibleModels(cfg) : p.visible_models;
    if (typeof p.api_key === 'string' && p.api_key.trim()) {
      keyPatch.llm = p.api_key.trim();
      keyPatch.llm_origin = originOf(cfg.llm.base_url) || '';
      cfg.llm.api_key = p.api_key.trim();
      cfg.llm.key_origin = originOf(cfg.llm.base_url) || '';
    }
    if (typeof p.temperature === 'number') cfg.llm.temperature = p.temperature;
    if (typeof p.max_tokens === 'number') cfg.llm.max_tokens = p.max_tokens;
    if (typeof p.context_tokens === 'number') cfg.llm.context_tokens = p.context_tokens;
    // embeddings (optional overrides; '' clears back to chat-endpoint fallback)
    if (typeof p.embed_base_url === 'string') cfg.memory.embed_base_url = p.embed_base_url.trim();
    if (typeof p.embed_model === 'string' && p.embed_model.trim()) cfg.memory.embed_model = p.embed_model.trim();
    if (typeof p.embed_api_key === 'string' && p.embed_api_key.trim()) {
      keyPatch.embed = p.embed_api_key.trim();
      cfg.memory.embed_api_key = p.embed_api_key.trim();
    }
    const rebuildMemory = !!agent && (agent.memory
      ? embeddingSettingsChanged(agent.memory, cfg)
      : !!cfg.memory.enabled);
    const { writeSections } = require('../harness/configWrite');
    const credentialVault = Object.keys(keyPatch).length
      ? require('../harness/credentials').vault(safeStorage, configDir()) : null;
    const previousCredentials = credentialVault ? credentialVault.read() : null;
    if (credentialVault) credentialVault.write({ ...previousCredentials, ...keyPatch });
    try { writeSections(cfg, cfg._configFile || ensureConfigFile()); }
    catch (error) {
      if (credentialVault) {
        try { credentialVault.write(previousCredentials); }
        catch { throw new Error('Settings write failed and saved credentials could not be restored; retry saving the connection'); }
      }
      throw error;
    }
    if (!rebuildMemory) {
      // A connection save is not a session boundary. Chat-only updates retain
      // the exact agent, memory store, approval grants and extraction window.
      applyChatSettings(agent, cfg);
      return { ok: true, base_url: cfg.llm.base_url, model: cfg.llm.model, visible_models: cfg.llm.visible_models, has_key: !!apiKeyOf(cfg), embed_model: cfg.memory.embed_model || '', embed_base_url: cfg.memory.embed_base_url || '', memory_reinitialized: false };
    }
    // rebuild agent with new config; preserve session, history AND taint so a
    // rebuild can't silently launder tainted state
    const keepId = agent ? agent.sessionId : null;
    const keepHist = agent ? agent.history : null;
    const keepTaint = agent ? agent.tainted : false;
    const keepMemTurn = agent ? agent.lastMemoryTurnId : null;
    const keepSentinel = agent ? agent.sentinel : null;
    const keepNetPolicy = agent ? agent.netPolicy : null;
    setBusyState(true);
    try {
      if (agent) agent.endSessionExtract().catch(() => {});
      if (agent && agent.memory) await agent.memory.close();
      agent = await mkAgent({ projectDir: currentProjectDir, skipMemory: false, history: keepHist && keepHist.length ? keepHist : undefined, sessionId: keepId, tainted: keepTaint, memoryTurnId: keepMemTurn });
      if (keepSentinel) agent.sentinel = keepSentinel;
      if (keepNetPolicy) agent.netPolicy = keepNetPolicy;
    } finally { setBusyState(false); }
    return { ok: true, base_url: cfg.llm.base_url, model: cfg.llm.model, visible_models: cfg.llm.visible_models, has_key: !!apiKeyOf(cfg), embed_model: cfg.memory.embed_model || '', embed_base_url: cfg.memory.embed_base_url || '', memory_reinitialized: !!agent.memory };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('model:select', async (e, requestedModel) => {
  try {
    requireTrusted(e);
    if (agentBusy || pendingApprovals.size) throw new Error('Agent busy; wait for the current turn or approval');
    const { modelId, visibleModels, applyChatSettings } = require('./connection-settings.ts');
    const model = modelId(requestedModel);
    const cfg = secureConfig();
    const allowed = visibleModels(cfg);
    if (!allowed.includes(model)) throw new Error('Choose a model from your visible models in Connection settings');
    cfg.llm.model = model;
    cfg.llm.visible_models = allowed;
    require('../harness/configWrite').writeSections(cfg, cfg._configFile || ensureConfigFile());
    applyChatSettings(agent, cfg);
    return { ok: true, model, visible_models: allowed };
  } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
});

ipcMain.handle('settings:fetchModels', async (e, { base_url, api_key } = {}) => {
  try {
    requireTrusted(e);
    const cfg = secureConfig();
    const url = (base_url && String(base_url).trim()) || cfg.llm.base_url;
    const savedOrigin = (cfg.llm.key_origin || '').toLowerCase();
    const here = originOf(url) || '';
    const originChanged = savedOrigin && here && here !== savedOrigin;
    // Origin-bound credentials: the saved key only travels to the endpoint it
    // was saved for. On a different origin the caller must supply the key.
    const key = api_key || (originChanged ? '' : apiKeyOf(cfg) || '');
    const ids = await fetchModels(url, key, {
      expectedOrigin: savedOrigin || here,
      keyIsExplicit: !!api_key,
    });
    return { ok: true, models: ids, origin_changed: !!originChanged && !api_key ? true : undefined };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---- memory surface (renderer: grade, status, delete) ----

ipcMain.handle('memory:status', async (e) => {
  requireTrusted(e);
  const cfg = loadConfig();
  if (!cfg.memory || !cfg.memory.enabled) return { enabled: false };
  if (!agent) { try { agent=await mkAgent({ projectDir: currentProjectDir }); } catch(e) { memoryError=e.message; } }
  if (!agent || !agent.memory) return { enabled: true, ready: false, error: memoryError };
  const h = agent.memory.healthMetrics();
  return {
    enabled: true, ready: !!agent.memory.projectId,
    project_id: agent.memory.projectId,
    task_id: agent.memory.taskId,
    evidence_version: agent.memory.evidenceVersion,
    flags: agent.memory.flags,
    last_turn_id: agent.lastMemoryTurnId || null,
    health: h,
    error: agent.memory.lastError || (!agent.memory.projectId ? 'MEMORY_SCOPE_REQUIRED: select a project folder or an explicit personal scope' : null),
    scopes: agent.memory.scopes(),
  };
});

ipcMain.handle('memory:list', async (e) => {
  requireTrusted(e);
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  try {
    const rows = agent.memory.listMemories()
      .map(m => ({
        id: m.id, type: m.type, provenance: m.provenance, trust_tier: m.trust_tier,
        status: m.status, injection_risk: m.injection_risk,
        created_at: m.created_at, text: String(m.text || '').slice(0, 200),
      }));
    return { ok: true, memories: rows };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('memory:delete', async (e, id) => {
  requireTrusted(e);
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  return agent.memory.deleteMemory(String(id), 'user-requested');
});

ipcMain.handle('memory:quarantine-review', async (e, { id, verdict }) => {
  requireTrusted(e);
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  // spec §7: quarantined rows resolve only through explicit user review
  if (verdict === 'safe') {
    try { return {ok:true,...await agent.memory.review(String(id))}; }
    catch(e) { return {ok:false,error:e.message}; }
  }
  return agent.memory.deleteMemory(String(id), 'quarantine-rejected');
});

ipcMain.handle('memory:scope', async (e, {strategy,project_id} = {}) => {
  try {
    requireTrusted(e);
    if(agentBusy)throw new Error('Agent busy');
    if(!['auto','manual','_default'].includes(strategy))throw new Error('Invalid scope strategy');
    if(strategy!=='auto' && (typeof project_id!=='string' || !project_id.trim()))throw new Error('Explicit project ID required');
    const cfg=secureConfig();
    cfg.memory.project_id_strategy=strategy;cfg.memory.project_id=project_id && project_id.trim() || '';
    require('../harness/configWrite').writeSections(cfg,cfg._configFile);
    if (!agent) agent = await mkAgent({ projectDir: currentProjectDir });
    if (agent && agent.memory) {
      // Flush the old window while its scope is still selected. extractSession
      // captures that scope synchronously before its first provider await.
      agent.endSessionExtract().catch(() => {});
      const result = agent.memory.setScope(strategy, cfg.memory.project_id, currentProjectDir);
      if (result.changed) { agent._sourceEvents = []; agent.lastMemoryTurnId = null; }
    }
    if(!agent.memory)throw new Error(memoryError);
    return {ok:true};
  } catch(err) {return {ok:false,error:String(err && err.message || err)};}
});

ipcMain.handle('memory:flags', async (e, patch) => {
  requireTrusted(e);
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  try { return agent.memory.setFlags(patch || {}); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('memory:deleted', async (e) => {
  requireTrusted(e);
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  try { return { ok: true, deletions: agent.memory.listDeleted() }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('memory:export', async (e) => {
  requireTrusted(e);
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  try {
    const os = require('os');
    const file = path.join(configDir(), 'memory', `export-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    const r = agent.memory.exportJsonl(file);
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('memory:extract-now', async (e) => {
  requireTrusted(e);
  if (agentBusy || !agent || !agent.memory) return { ok: false, error: 'memory disabled or agent busy' };
  try { return { ok: true, ...(await agent.endSessionExtract()) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
