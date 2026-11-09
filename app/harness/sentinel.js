'use strict';
// sentinel.js - gatekeeper. Deny-rules -> mode policy -> scope grants.
// Policy model (rev 2026-10-26, Claude Code-style permission modes):
//   Modes: 'ask' | 'accept_edits' | 'plan' | 'auto'
//     ask          — side-effect tools ALWAYS ask (previous default)
//     accept_edits — file writes (write_file) inside granted scope auto-approve;
//                    shell/web/spawn_agent/mcp still ask
//     plan         — read-only: reads inside scope allowed, EVERY side effect
//                    (writes, shell, web, mcp, spawn) denied outright
//     auto         — known tools run without approval, including shell and
//                    file access outside project grants. Deny rules still apply.
//   HARD INVARIANTS in EVERY mode (no mode ever escapes these):
//     - deny_rules match -> deny, first, before anything else
//     - unknown tool names -> deny (fail closed)
//     - reads outside granted scope -> ask except in explicit auto mode
//   READ tools (read_file, list_dir) are allowed inside granted scopes
//   without approval in all modes; outside scope they ask.
// A grant is { root } (absolute path). Grants live for the session and are
// cleared on reset.

const MODES = ['ask', 'accept_edits', 'plan', 'auto'];
const fs = require('node:fs');
const path = require('node:path');

// Resolve links, including the existing ancestor of a not-yet-created file.
// Permission checks must describe the filesystem destination, not its alias.
function canonicalPath(value) {
  let candidate = path.resolve(value);
  const missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(candidate), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling link is not a new directory: its destination is unknown.
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('dangling link in tool path');
      } catch (linkError) {
        if (linkError.code !== 'ENOENT') throw linkError;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

class Sentinel {
  constructor(cfg, opts = {}) {
    this.cfg = cfg.sentinel || {};
    this.agentCfg = cfg.agent || {};
    this.timeoutMs = (this.agentCfg.approval_timeout_s || 3600) * 1000;
    this.denyRules = this.cfg.deny_rules || [];
    // Central policy. Tool registry `alwaysAsk` is advisory; this is the law.
    this.sideEffectTools = new Set(['write_file', 'web_fetch', 'shell']);
    this.readTools = new Set(['read_file', 'list_dir']);
    // Legacy always_ask_tools values are accepted in config but do not override Auto.
    // Modes live on the sentinel so a running agent picks up a switch
    // immediately (host calls setMode). Config value is the boot default.
    this.mode = MODES.includes(this.cfg.mode) ? this.cfg.mode : 'ask';
    // MCP tools are dynamic: server-provided names get the mcp__ prefix at
    // registration and are side-effect by default (fail-safe; a server that
    // only reads still asks — we cannot prove it reads-only from the outside).
    this.mcpSideEffects = true;
    this.approver = opts.approver || null;
    this.grants = [];            // [{root}] absolute normalized paths
    this.expiryListeners = new Set();
  }

  setMode(m) {
    if (!MODES.includes(m)) return false;
    this.mode = m;
    return true;
  }

  addGrant(root) {
    const p = String(root || '').trim();
    if (!p) return false;
    try { this.grants.push(canonicalPath(p)); }
    catch { return false; }
    return true;
  }

  clearGrants() { this.grants = []; }

  // Path containment: real fs paths only (tools resolve before calling).
  // Case-insensitive on Windows, exact elsewhere.
  inGrantedScope(resolvedPath) {
    if (!resolvedPath) return false;
    let p;
    try { p = canonicalPath(String(resolvedPath)); }
    catch { return false; }
    const norm = process.platform === 'win32' ? p.toLowerCase() : p;
    for (const root of this.grants) {
      let r = root;
      if (process.platform === 'win32') r = r.toLowerCase();
      if (norm === r || norm.startsWith(r.endsWith('\\') || r.endsWith('/') ? r : r + (process.platform === 'win32' ? '\\' : '/'))) {
        return true;
      }
    }
    return false;
  }

  onExpiry(fn) { this.expiryListeners.add(fn); return () => this.expiryListeners.delete(fn); }

  // Taint-lite: after agent reads a private file, egress URLs must be in allowlist.
  // Returns true if url host is allowed (or no taint active / no allowlist).
  egressAllowed(url, tainted) {
    if (!tainted) return true;
    const allow = this.cfg.egress_allowlist || [];
    if (!allow.length) return true;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return allow.some(a => host === a.toLowerCase() || host.endsWith('.' + a.toLowerCase()));
    } catch { return false; }
  }

  // glob-ish match: * is any-run. Case-insensitive, matches whole rendered call.
  matchesRule(haystack, rule) {
    const parts = rule.toLowerCase().split('*');
    let idx = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue;
      const found = haystack.indexOf(parts[i], idx);
      if (found === -1) return false;
      if (i === 0 && found !== 0) return false;     // rule starts with literal -> must anchor
      idx = found + parts[i].length;
      if (i === parts.length - 1 && idx !== haystack.length) return false; // trailing literal anchors end
    }
    return true;
  }

  // request: {tool, args, resolvedPath?} rendered to text for rule matching
  renderForRules(request) {
    try { return `${request.tool} ${JSON.stringify(request.args || {})}`.toLowerCase(); }
    catch { return String(request.tool).toLowerCase(); }
  }

  decide(request) {
    // -- INVARIANT 1: deny rules short-circuit every mode --
    const rendered = [this.renderForRules(request)];
    // Keep the original rendering for anchored rules; independently check
    // the real target so aliases cannot hide a denied destination.
    if (request.resolvedPath) rendered.push(this.renderForRules({
      ...request, args: { ...request.args, path: request.resolvedPath },
    }));
    for (const rule of this.denyRules) {
      if (rendered.some(value => this.matchesRule(value, rule.toLowerCase()))) {
        return { decision: 'deny', reason: `matched deny rule: ${rule}` };
      }
    }
    const isRead = this.readTools.has(request.tool);
    const sideEffect = this.sideEffectTools.has(request.tool);
    const isMcp = this.mcpSideEffects && typeof request.tool === 'string' && request.tool.startsWith('mcp__');
    const isSpawn = request.tool === 'spawn_agent';
    if (!isRead && !sideEffect && !isMcp && !isSpawn) {
      return { decision: 'deny', reason: `unknown tool "${request.tool}" (fail closed)` };
    }
    if (this.mode === 'auto') {
      return { decision: 'allow', reason: 'auto mode: tools are authorized without approval prompts' };
    }
    // Other modes retain project-scoped file approvals.
    if (this.readTools.has(request.tool)) {
      if (this.inGrantedScope(request.resolvedPath)) {
        return { decision: 'allow', reason: 'read inside granted scope' };
      }
      return { decision: 'ask', reason: 'read outside granted scope' };
    }
    const reason = sideEffect
      ? `side-effect tool "${request.tool}" requires approval`
      : isMcp
        ? 'MCP tool requires approval (dynamic server tool — conservative default)'
        : 'subagent spawn consumes LLM turns under your key; child tool calls gate separately';
    if (this.mode === 'plan') {
      // Plan mode: read-only. Every side effect denied outright (no prompt).
      return { decision: 'deny', reason: `plan mode is read-only: "${request.tool}" is blocked (switch out of plan mode to act)` };
    }
    if (this.mode === 'accept_edits') {
      // Accept-edits: file writes inside granted scope auto-approve.
      if (request.tool === 'write_file' && this.inGrantedScope(request.resolvedPath)) {
        return { decision: 'allow', reason: 'accept-edits mode: write inside granted scope' };
      }
      return { decision: 'ask', reason };
    }
    // ask mode (default) and everything else: side effects ask.
    return { decision: 'ask', reason };
  }

  // Full gate. Returns {decision:'allow'} | {decision:'deny', reason} after approval flow.
  async gate(request) {
    const d = this.decide(request);
    if (d.decision !== 'ask') return d;
    if (!this.approver) return { decision: 'deny', reason: 'no approver connected (safe default)' };
    let timer;
    let timedOut = false;
    const ok = await Promise.race([
      Promise.resolve(this.approver(request)).then(v => ({ v })),
      new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve({}); }, this.timeoutMs); }),
    ]).catch(() => ({})).finally(() => clearTimeout(timer));
    if (timedOut) {
      for (const fn of this.expiryListeners) { try { fn(request); } catch {} }
    }
    if (!ok || !ok.v) return { decision: 'deny', reason: 'user denied or approval timed out' };
    // A pending approval cannot override a newer plan mode or deny rule.
    const latest = this.decide(request);
    if (latest.decision === 'deny') return latest;
    return { decision: 'allow', reason: 'user approved' };
  }
}

module.exports = { Sentinel, canonicalPath };
