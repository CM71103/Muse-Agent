'use strict';
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
let pendingApproval = null; // {id, resolve, request}
let pendingQuestion = null; // {id, resolve, q}
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

  // Navigation/popup policy: this is a single-page local app. Deny everything
  // that is not our own page; hand real http(s) links to the system browser.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (String(url).replace(/\\/g, '/').toLowerCase() === RENDERER_URL.toLowerCase()) return;
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
function requireTrusted(e) { if (!trustedSender(e)) throw new Error('untrusted IPC caller'); }

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
      pendingApproval = { id, resolve, request };
      notify('Muse needs approval', `Tool "${request.tool}" is waiting for you${request.subagent ? ' (subagent)' : ''}`);
      send('approval-request', { id, tool: request.tool, args: request.args, subagent: !!request.subagent });
    }),
    questionAsker: (q) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      pendingQuestion = { id, resolve, q };
      send('agent-question', { id, question: q.question, options: q.options || [] });
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
  a.sentinel.onExpiry(() => {
    if (pendingApproval) { pendingApproval = null; }
    send('approval-expired', {});
  });
  // memory layer (R-49 host contract) — only when enabled; failures degrade to memoryless
  if (cfg.memory && cfg.memory.enabled && !opts.skipMemory) {
    try {
      const { MemoryLayer } = require('../memory/layer');
      const mem = new MemoryLayer(cfg, {
        dataDir: path.join(configDir(), 'memory'),
        cwd: process.cwd(),
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
  // Hands sidecar supervision notes -> UI info events (crash/restart events)
  try {
    require('../harness/hands_client').supervisor.onSupervision = (msg) => {
      send('agent-event', { type: 'info', text: `hands: ${msg}` });
    };
  } catch {}
  startBridgeIfConfigured();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  if (agent && agent.memory) agent.memory.close();
  if (bridge) { try { bridge.close(); } catch {} }
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
  if (!pendingApproval || pendingApproval.id !== id) return { ok: false, error: 'stale approval' };
  const p = pendingApproval;
  pendingApproval = null;
  p.resolve(!!approved);
  return { ok: true };
});

ipcMain.handle('question:respond', async (e, { id, answer, cancelled }) => {
  requireTrusted(e);
  if (!pendingQuestion || pendingQuestion.id !== id) return { ok: false, error: 'stale question' };
  const p = pendingQuestion;
  pendingQuestion = null;
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

ipcMain.handle('config:get', async () => {
  ensureConfigFile();
  const cfg = loadConfig();
  return {
    configFile: cfg._configFile || userConfigFile(),
    llm: {
      provider: cfg.llm.provider,
      base_url: cfg.llm.base_url,
      model: cfg.llm.model,
      has_key: !!(cfg.llm.api_key || process.env[cfg.llm.api_key_env]),
    },
    hands: { enabled: !!cfg.hands.enabled, host: cfg.hands.host, port: cfg.hands.port },
    sentinel: { mode: cfg.sentinel.mode, deny_rules: cfg.sentinel.deny_rules },
  };
});

ipcMain.handle('sessions:list', async () => sessionStore.list());

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
    const s = agent.restore(String(id));
    // replay the restored transcript into the renderer
    for (const m of s.history || []) {
      if (m.role === 'user') send('agent-event', { type: 'restored_user', text: m.content });
      else if (m.role === 'assistant' && m.content) send('agent-event', { type: 'restored_assistant', text: m.content });
      else if (m.role === 'tool') send('agent-event', { type: 'restored_tool', name: m.name || 'tool' });
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

ipcMain.handle('config:toggleHands', async (e, enabled) => {
  requireTrusted(e);
  const cfg = loadConfig();
  cfg.hands.enabled = !!enabled;
  const { writeSections } = require('../harness/configWrite');
  writeSections(cfg, ensureConfigFile());
  // Live revocation: a running agent's sentinel flips immediately. Turning
  // hands back on does NOT re-arm a running agent — new agents only.
  if (agent && !enabled) agent.sentinel.revokeHands();
  return { ok: true, enabled: !!enabled };
});

// ---- settings ----
const { fetchModels, originOf } = require('../harness/models');
const { apiKey: apiKeyOf } = require('../harness/config');

ipcMain.handle('settings:get', async () => {
  const cfg = loadConfig();
  return {
    base_url: cfg.llm.base_url,
    model: cfg.llm.model,
    api_key: '',      // renderer masks display; key lives in config
    api_key_env: cfg.llm.api_key_env,
    temperature: cfg.llm.temperature,
    max_tokens: cfg.llm.max_tokens,
    context_tokens: cfg.llm.context_tokens,
    configFile: cfg._configFile || userConfigFile(),
  };
});

ipcMain.handle('settings:save', async (e, patch) => {
  try {
    requireTrusted(e);
    if (agentBusy) throw new Error('Agent busy');
    const cfg = secureConfig();
    const p = patch || {};
    if (typeof p.base_url === 'string' && p.base_url.trim()) cfg.llm.base_url = p.base_url.trim();
    if (typeof p.model === 'string' && p.model.trim()) cfg.llm.model = p.model.trim();
    if (typeof p.api_key === 'string' && p.api_key.trim()) {
      const v=require('../harness/credentials').vault(safeStorage,configDir());
      v.write({...v.read(),llm:p.api_key.trim(), llm_origin: originOf(cfg.llm.base_url) || ''});
    }
    cfg.llm.api_key=''; // '' clears -> env var takes over
    if (typeof p.temperature === 'number') cfg.llm.temperature = p.temperature;
    if (typeof p.max_tokens === 'number') cfg.llm.max_tokens = p.max_tokens;
    const { writeSections } = require('../harness/configWrite');
    writeSections(cfg, ensureConfigFile());
    // rebuild agent with new config; preserve session, history AND taint so a
    // rebuild can't silently launder tainted state
    const keepId = agent ? agent.sessionId : null;
    const keepHist = agent ? agent.history : null;
    const keepTaint = agent ? agent.tainted : false;
    const keepMemTurn = agent ? agent.lastMemoryTurnId : null;
    if (agent && agent.memory) agent.memory.close();
    agent = await mkAgent({ projectDir: currentProjectDir, skipMemory: false, history: keepHist && keepHist.length ? keepHist : undefined, sessionId: keepId, tainted: keepTaint, memoryTurnId: keepMemTurn });
    return { ok: true, base_url: cfg.llm.base_url, model: cfg.llm.model, has_key: !!(cfg.llm.api_key || process.env[cfg.llm.api_key_env]) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
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

ipcMain.handle('memory:status', async () => {
  const cfg = loadConfig();
  if (!cfg.memory || !cfg.memory.enabled) return { enabled: false };
  if (!agent) { try { agent=await mkAgent({ projectDir: currentProjectDir }); } catch(e) { memoryError=e.message; } }
  if (!agent || !agent.memory) return { enabled: true, ready: false, error: memoryError };
  const h = agent.memory.healthMetrics();
  return {
    enabled: true, ready: true,
    project_id: agent.memory.projectId,
    task_id: agent.memory.taskId,
    evidence_version: agent.memory.evidenceVersion,
    flags: agent.memory.flags,
    last_turn_id: agent.lastMemoryTurnId || null,
    health: h,
    error: agent.memory.lastError,
    scopes: agent.memory.scopes(),
  };
});

ipcMain.handle('memory:list', async () => {
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

ipcMain.handle('memory:delete', async (_e, id) => {
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  return agent.memory.deleteMemory(String(id), 'user-requested');
});

ipcMain.handle('memory:quarantine-review', async (_e, { id, verdict }) => {
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
    // Preserve the visible conversation across the memory rebuild.
    const keepId = agent ? agent.sessionId : null;
    const keepHist = agent ? agent.history : null;
    const keepTaint = agent ? agent.tainted : false;
    const keepMemTurn = agent ? agent.lastMemoryTurnId : null;
    if(agent && agent.memory)agent.memory.close();
    agent=await mkAgent({ projectDir: currentProjectDir, history: keepHist && keepHist.length ? keepHist : undefined, sessionId: keepId, tainted: keepTaint, memoryTurnId: keepMemTurn });
    if(!agent.memory)throw new Error(memoryError);
    return {ok:true};
  } catch(err) {return {ok:false,error:String(err && err.message || err)};}
});

ipcMain.handle('memory:flags', async (_e, patch) => {
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  try { return agent.memory.setFlags(patch || {}); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('memory:deleted', async () => {
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  try { return { ok: true, deletions: agent.memory.listDeleted() }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('memory:export', async () => {
  if (!agent || !agent.memory) return { ok: false, error: 'memory disabled' };
  try {
    const os = require('os');
    const file = path.join(configDir(), 'memory', `export-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    const r = agent.memory.exportJsonl(file);
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('memory:extract-now', async () => {
  if (agentBusy || !agent || !agent.memory) return { ok: false, error: 'memory disabled or agent busy' };
  try { return { ok: true, ...(await agent.endSessionExtract()) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
