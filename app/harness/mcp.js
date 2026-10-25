'use strict';
// mcp.js - MCP (Model Context Protocol) client support, Antigravity-style.
// Stdio transport only (spawn local servers from config). No network servers
// in v1 — web-based MCP is an egress surface we won't bless by default.
//
// Config (config.toml):
//   [mcp]
//   servers = ["docs", "browser"]
//   [mcp.server.docs]          # any name you like
//   command = "npx"
//   args = ["-y", "@modelcontextprotocol/server-filesystem", "D:/projects"]
//   env = ["EXTRA_VAR=value"]
//   timeout_s = 30
//
// Security: every MCP tool call goes through the Sentinel as a side-effect
// (ask) — MCP servers are third-party code and untrusted. Tool names exposed
// to the model are prefixed mcp__<server>__<tool> so they cannot collide with
// native tools or impersonate them.

const { spawn } = require('child_process');
const readline = require('readline');

const PROTOCOL_VERSION = '2025-06-18';
const INIT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_DEFAULT = 60000;
const RESULT_CAP = 60000;          // chars per tool result
const SERVERS_CAP = 4;             // registered servers max

// ---- one stdio client per configured server ----
class McpStdioClient {
  constructor(name, cfg) {
    this.name = name;
    this.command = cfg.command;
    this.args = Array.isArray(cfg.args) ? cfg.args : [];
    this.env = {};
    for (const e of (Array.isArray(cfg.env) ? cfg.env : [])) {
      const i = String(e).indexOf('=');
      if (i > 0) this.env[String(e).slice(0, i)] = String(e).slice(i + 1);
    }
    this.timeoutMs = (cfg.timeout_s || 60) * 1000;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();       // id -> {resolve, reject, timer}
    this.tools = [];
    this.dead = false;
  }

  _start() {
    if (this.proc) return;
    if (!this.command) throw new Error(`mcp server "${this.name}": no command`);
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this._onLine(line));
    this.proc.on('exit', (code) => this._onExit(code));
    this.proc.on('error', (e) => this._die(e));
    this.proc.stderr.on('data', (d) => {
      const s = String(d).slice(0, 2000);
      if (s.trim()) this._log(`stderr: ${s.trim()}`);
    });
  }

  _log(msg) { try { console.log(`[mcp:${this.name}] ${msg}`.slice(0, 500)); } catch {} }
  _die(e) {
    this.dead = true;
    const err = e || new Error('server exited');
    for (const [, p] of this.pending) { try { p.reject(new Error(`mcp "${this.name}" died: ${err.message || err}`)); } catch {} }
    this.pending.clear();
    if (this.rl) { try { this.rl.close(); } catch {} this.rl = null; }
  }

  _onExit(code) {
    if (!this.dead) this._die(new Error(`server exited (code ${code})`));
  }

  _onLine(line) {
    let msg = null;
    try { msg = JSON.parse(line); } catch { return; }   // non-JSON stdout: ignore
    if (!msg || msg.id == null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || 'mcp error'));
    else p.resolve(msg.result);
  }

  _request(method, params) {
    this._start();
    if (this.dead) return Promise.reject(new Error(`mcp "${this.name}" is down`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp "${this.name}" ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
      } catch (e) {
        this.pending.delete(id); clearTimeout(timer); reject(e);
      }
    });
  }

  async initialize() {
    const res = await Promise.race([
      this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'muse-agent', version: '0.1.3' },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`mcp "${this.name}" initialize timed out`)), INIT_TIMEOUT_MS)),
    ]);
    // tools/list (capability check: server may expose none)
    let tools = [];
    if (res && res.capabilities && res.capabilities.tools) {
      const list = await this._request('tools/list', {});
      tools = (list && list.tools) || [];
    }
    this.tools = tools.map(t => ({
      name: String(t.name || '').replace(/[^\w.-]/g, '_'),
      description: String(t.description || `MCP tool ${t.name} from server "${this.name}"`),
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    return this.tools;
  }

  call(tool, args) {
    return this._request('tools/call', { name: tool, arguments: args || {} });
  }

  close() {
    this.dead = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); try { p.reject(new Error('closed')); } catch {} }
    this.pending.clear();
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    if (this.rl) { try { this.rl.close(); } catch {} this.rl = null; }
  }
}

// ---- registry: build OpenAI-style tool wrappers for the agent ----
function mkMcpTools(mcpCfg) {
  // mcpCfg = cfg.mcp section; servers list resolved lazily by startMcpServers().
  // This module's mkMcpTools is called AFTER startMcpServers populated the
  // shared registry (see main index.js flow), so tools are already discovered.
  const tools = [];
  for (const client of registry.clients()) {
    for (const t of client.tools) {
      const tool = {
        name: `mcp__${client.name}__${t.name}`,
        description: `[MCP/${client.name}] ${t.description}`,
        parameters: t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} },
        async run(args) {
          try {
            const res = await client.call(t.name, args);
            // MCP result: {content:[{type,text,...}], isError?}
            let text = '';
            if (res && Array.isArray(res.content)) {
              text = res.content
                .filter(c => c.type === 'text')
                .map(c => c.text || '')
                .join('\n');
            } else if (res != null) {
              text = JSON.stringify(res);
            }
            const isError = !!(res && res.isError);
            return {
              ok: !isError,
              ...(isError ? { error: text.slice(0, 2000) || 'MCP tool reported an error' } : {}),
              ...(text ? { result: text.slice(0, RESULT_CAP) } : {}),
              truncated: text.length > RESULT_CAP,
            };
          } catch (e) {
            return { ok: false, error: `mcp ${client.name}/${t.name}: ${e && e.message || e}` };
          }
        },
      };
      tools.push(tool);
    }
  }
  return tools;
}

// Shared registry so main can start servers once at agent build time.
const registry = {
  _clients: new Map(),
  add(client) { this._clients.set(client.name, client); },
  get(name) { return this._clients.get(name); },
  clients() { return [...this._clients.values()]; },
  clear() { for (const c of this._clients.values()) { try { c.close(); } catch {} } this._clients.clear(); },
};

// Start configured servers, discover tools, populate registry. Called from main
// before Agent construction (when tools need the registry populated). Also
// usable from cli.js headless mode. Failures are logged and skipped — one bad
// server never blocks the agent.
async function startMcpServers(cfg, log = () => {}) {
  registry.clear();
  const mcp = cfg && cfg.mcp;
  if (!mcp || !Array.isArray(mcp.servers) || !mcp.servers.length) return [];
  const names = mcp.servers.slice(0, SERVERS_CAP);
  const servers = (mcp.server || {});
  for (const name of names) {
    const scfg = servers[name];
    if (!scfg || !scfg.command) { log(`mcp server "${name}" missing [mcp.server.${name}] command — skipped`); continue; }
    const client = new McpStdioClient(name, scfg);
    try {
      await client.initialize();
      registry.add(client);
      log(`mcp server "${name}" ready (${client.tools.length} tools)`);
    } catch (e) {
      try { client.close(); } catch {}
      log(`mcp server "${name}" failed to start: ${e && e.message || e}`);
    }
  }
  return registry.clients();
}

module.exports = { mkMcpTools, startMcpServers, registry, McpStdioClient };
