'use strict';
// sentinel.js - gatekeeper. Deny-rules -> approval policy -> scope grants.
// Policy model (approved 2026-10-24):
//   - SIDE-EFFECT tools (write_file, web_fetch, shell, hands) ALWAYS ask.
//     The `mode: 'auto'` escape hatch is removed: auto never bypasses approval.
//   - READ tools (read_file, list_dir) are allowed inside granted scopes
//     without approval; anything outside a granted scope asks.
//   - Deny rules short-circuit everything.
// A grant is { root } (absolute path). Grants live for the session and are
// cleared on reset. `handsRevoked` flips live: the hands tool re-checks this
// gate right before every action, so disabling hands in the UI takes effect
// for a running agent.

class Sentinel {
  constructor(cfg, opts = {}) {
    this.cfg = cfg.sentinel || {};
    this.agentCfg = cfg.agent || {};
    this.timeoutMs = (this.agentCfg.approval_timeout_s || 3600) * 1000;
    this.denyRules = this.cfg.deny_rules || [];
    // Central policy. Tool registry `alwaysAsk` is advisory; this is the law.
    this.sideEffectTools = new Set(['write_file', 'web_fetch', 'shell', 'hands']);
    this.readTools = new Set(['read_file', 'list_dir']);
    // MCP tools are dynamic: server-provided names get the mcp__ prefix at
    // registration and are side-effect by default (fail-safe; a server that
    // only reads still asks — we cannot prove it reads-only from the outside).
    this.mcpSideEffects = true;
    this.approver = opts.approver || null;
    this.grants = [];            // [{root}] absolute normalized paths
    this.handsRevoked = false;   // live switch, flipped by host on toggle-off
    this.expiryListeners = new Set();
  }

  addGrant(root) {
    const p = String(root || '').trim();
    if (!p) return false;
    this.grants.push(p);
    return true;
  }

  clearGrants() { this.grants = []; }

  revokeHands() { this.handsRevoked = true; }

  // Path containment: real fs paths only (tools resolve before calling).
  // Case-insensitive on Windows, exact elsewhere.
  inGrantedScope(resolvedPath) {
    const p = String(resolvedPath || '');
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
    const rendered = this.renderForRules(request);
    for (const rule of this.denyRules) {
      if (this.matchesRule(rendered, rule.toLowerCase())) {
        return { decision: 'deny', reason: `matched deny rule: ${rule}` };
      }
    }
    // Side effects always ask — no mode escape hatch.
    if (this.sideEffectTools.has(request.tool)) {
      if (request.tool === 'hands' && this.handsRevoked) {
        return { decision: 'deny', reason: 'hands revoked (disabled while agent running)' };
      }
      return { decision: 'ask', reason: `side-effect tool "${request.tool}" requires approval` };
    }
    // Read tools: allowed inside granted scopes, ask outside.
    if (this.readTools.has(request.tool)) {
      if (this.inGrantedScope(request.resolvedPath)) {
        return { decision: 'allow', reason: 'read inside granted scope' };
      }
      return { decision: 'ask', reason: 'read outside granted scope' };
    }
    // MCP tools (mcp__server__tool): side-effect by default when registered.
    if (this.mcpSideEffects && typeof request.tool === 'string' && request.tool.startsWith('mcp__')) {
      return { decision: 'ask', reason: 'MCP tool requires approval (dynamic server tool — conservative default)' };
    }
    // Subagent delegation spawns LLM turns under the user's key: ask once per
    // spawn, then the child's own tool calls gate normally.
    if (request.tool === 'spawn_agent') {
      return { decision: 'ask', reason: 'subagent spawn consumes LLM turns under your key; child tool calls gate separately' };
    }
    // Unknown tool names: fail closed.
    return { decision: 'deny', reason: `unknown tool "${request.tool}" (fail closed)` };
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
    return ok && ok.v
      ? { decision: 'allow', reason: 'user approved' }
      : { decision: 'deny', reason: 'user denied or approval timed out' };
  }
}

module.exports = { Sentinel };
