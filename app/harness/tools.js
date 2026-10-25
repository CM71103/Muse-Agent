'use strict';
// tools.js - tool registry. Each tool: {name, description, parameters(json schema),
// run(args, ctx)}. ctx = {cwd, cfg, sentinel, log, onPrivateRead, netPolicy}
// Approval policy lives in sentinel.js (side effects ask; reads follow scope).
// Windows note: shell runs unsandboxed (nanoMuse parity - bubblewrap is Linux-only).

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');

const IS_WIN = process.platform === 'win32';
const MAXWebResponse = 24000;         // chars kept from any web response
const MAXWebResponseBytes = 2 * 1024 * 1024;  // hard byte cap before decode
const MAX_DIR_ENTRIES = 500;

function mkShellTool() {
  return {
    name: 'shell',
    description: 'Run a shell command. On Windows uses cmd.exe /c, elsewhere /bin/sh -c. ' +
      'Commands run unsandboxed with your user permissions. Destructive patterns are denied by Sentinel; every shell call requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to run' },
        timeout_s: { type: 'number', description: 'Optional timeout seconds, default 60' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const timeout = (args.timeout_s || 60) * 1000;
      return await new Promise((resolve) => {
        const file = IS_WIN ? 'cmd.exe' : '/bin/sh';
        const flag = IS_WIN ? '/c' : '-c';
        execFile(file, [flag, args.command], {
          cwd: ctx.cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        }, (err, stdout, stderr) => {
          const parts = [];
          if (stdout) parts.push(String(stdout));
          if (stderr) parts.push(`[stderr]\n${stderr}`);
          if (err && err.killed) parts.push(`[timed out after ${timeout / 1000}s]`);
          const out = parts.join('\n') || '(no output)';
          resolve({ ok: !err, output: out.slice(0, 65536) });
        });
      });
    },
  };
}

function mkFsTools() {
  const read = {
    name: 'read_file',
    description: 'Read a text file. Automatic inside the granted project scope; outside scope each read asks for approval. Reading private locations marks the session tainted; network egress then limited to the sentinel allowlist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or cwd-relative path' },
        max_bytes: { type: 'number', description: 'Optional cap, default 65536' },
      },
      required: ['path'],
    },
    async run(args, ctx) {
      const p = path.resolve(ctx.cwd, args.path);
      const stat = await fsp.stat(p);   // throws for missing -> tool error, not sentinel bypass
      const cap = Math.min(args.max_bytes || 24000, 24000); // ~6.5k tokens cap
      const fh = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(cap, stat.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const content = buf.slice(0, bytesRead).toString('utf8');
        if (ctx.onPrivateRead) {
          try { ctx.onPrivateRead(p); } catch {}
        }
        return {
          ok: true, path: p, size: stat.size, truncated: stat.size > bytesRead, content,
          ...(stat.size > bytesRead ? { note: `file is ${stat.size} bytes; showing first ${cap}. Use shell (grep/head) for more.` } : {}),
        };
      } finally { await fh.close(); }
    },
  };

  const write = {
    name: 'write_file',
    description: 'Write a text file (creates or overwrites). Every write requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async run(args, ctx) {
      const p = path.resolve(ctx.cwd, args.path);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, args.content, 'utf8');
      return { ok: true, path: p, bytes: Buffer.byteLength(args.content) };
    },
  };

  const list = {
    name: 'list_dir',
    description: 'List directory entries with type and size. Automatic inside the granted project scope; outside scope each listing asks for approval.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory, default cwd' } },
    },
    async run(args, ctx) {
      const p = path.resolve(ctx.cwd, args.path || '.');
      const names = await fsp.readdir(p, { withFileTypes: true });
      const entries = [];
      let truncated = false;
      for (const d of names) {
        if (entries.length >= MAX_DIR_ENTRIES) { truncated = true; break; }
        try {
          const st = d.isDirectory() ? null : await fsp.stat(path.join(p, d.name));
          entries.push({ name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other', size: st ? st.size : null });
        } catch { entries.push({ name: d.name, type: 'other', size: null }); }
      }
      return { ok: true, path: p, entries, ...(truncated ? { truncated: true, note: `showing first ${MAX_DIR_ENTRIES} entries` } : {}) };
    },
  };

  return [read, write, list];
}

// Private/looped-back address detection for outbound fetches.
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (net.isIP(host)) {
    if (net.isIPv4(host)) {
      const [a, b] = host.split('.').map(Number);
      if (a === 10 || a === 127 || a === 0) return true;
      if (a === 169 && b === 254) return true;      // link-local
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
      if (a >= 224) return true;                    // multicast/reserved
      return false;
    }
    // IPv6: loopback, link-local fe80::/10, unique-local fc00::/7, unspecified
    const low = host.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return true;   // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(low) || /^fe[89ab][0-9a-f]::/.test(low)) return true;
    return false;
  }
  return false; // public hostname; resolved-IP check happens per hop below
}

async function assertPublicAddress(hostname, netPolicy) {
  if (netPolicy && netPolicy.allowLocal) return;  // explicit local-services exception
  if (isPrivateHost(hostname)) throw new Error(`blocked: ${hostname} is a private/loopback address`);
  // Resolve DNS and verify every record is public — hostname-based checks
  // alone can be defeated by DNS rebinding to a private IP.
  const records = await new Promise((resolve) => {
    try { require('dns').lookup(hostname, { all: true }, (err, addrs) => resolve(err ? null : addrs)); }
    catch { resolve(null); }
  });
  if (!records || !records.length) throw new Error(`blocked: cannot verify address for ${hostname}`);
  for (const rec of records) {
    if (isPrivateHost(rec.address)) throw new Error(`blocked: ${hostname} resolves to private address ${rec.address}`);
  }
}

function mkWebTool() {
  return {
    name: 'web_fetch',
    description: 'Fetch a URL (HTTP GET, text only). Every fetch requires user approval. Private/loopback destinations are blocked; every redirect hop is revalidated. Output is byte-capped.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    async run(args, ctx) {
      const url = String(args.url);
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'http(s) URLs only' };
      if (!ctx.sentinel.egressAllowed(url, ctx.tainted)) {
        return { ok: false, error: `blocked: session is tainted (private file read) and ${url} not in egress allowlist` };
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 30000);
      try {
        // Validate the first hop ourselves, then follow redirects manually so
        // every hop gets the same destination policy.
        let current = new URL(url);
        for (let hop = 0; hop < 5; hop++) {
          if (current.protocol !== 'http:' && current.protocol !== 'https:') {
            return { ok: false, error: `blocked: ${current.protocol} URLs not allowed` };
          }
          const localOk = current.hostname === 'localhost' || current.hostname === '127.0.0.1' || current.hostname === '::1';
          if (!localOk) await assertPublicAddress(current.hostname, ctx.netPolicy);
          else if (!(ctx.netPolicy && ctx.netPolicy.allowLocal)) {
            return { ok: false, error: 'blocked: local network destinations require approval' };
          }
          if (hop > 0 && !ctx.sentinel.egressAllowed(current.toString(), ctx.tainted)) {
            return { ok: false, error: `blocked: redirect to ${current.host} not in egress allowlist` };
          }
          const res = await fetch(current, { signal: ac.signal, redirect: 'manual' });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) return { ok: false, error: `redirect ${res.status} without location`, status: res.status };
            try { res.body && res.body.cancel && res.body.cancel(); } catch {}
            current = new URL(loc, current);
            continue;
          }
          // Bound the body read BEFORE decoding: cap raw bytes, then decode.
          const reader = res.body && res.body.getReader ? res.body.getReader() : null;
          let text = '';
          let bytes = 0;
          let overCap = false;
          if (reader) {
            const decoder = new TextDecoder('utf-8', { stream: true });
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > MAXWebResponseBytes) { overCap = true; try { await reader.cancel(); } catch {} break; }
              text += decoder.decode(value, { stream: true });
              if (text.length > MAXWebResponse * 4) { overCap = true; try { await reader.cancel(); } catch {} break; }
            }
            text += decoder.decode();
          } else {
            text = await res.text();
          }
          return {
            ok: res.ok, status: res.status, url: current.toString(),
            content: text.slice(0, MAXWebResponse),
            truncated: text.length > MAXWebResponse || overCap,
            ...(text.length > MAXWebResponse ? { note: `page is ${text.length} chars; showing first ${MAXWebResponse}. Fetch again with a more specific target if needed.` } : {}),
          };
        }
        return { ok: false, error: 'too many redirects' };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      } finally { clearTimeout(t); }
    },
  };
}

function mkHandsTool(cfg) {
  return {
    name: 'hands',
    description: 'Computer control via the Python hands sidecar: screenshot, mouse, keyboard. ' +
      'Requires hands.enabled=true in config AND user approval for every action; disabling hands mid-session revokes it immediately.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'click', 'double_click', 'move', 'drag', 'scroll', 'type', 'hotkey', 'key_press'],
          description: 'Action to perform',
        },
        x: { type: 'number' }, y: { type: 'number' },
        to_x: { type: 'number' }, to_y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        text: { type: 'string', description: 'text to type (for "type")' },
        keys: { type: 'string', description: 'e.g. "ctrl+c" (for hotkey/key_press)' },
        amount: { type: 'number', description: 'scroll clicks, negative = down' },
      },
      required: ['action'],
    },
    async run(args, ctx) {
      const hands = ctx.cfg.hands || {};
      // Live re-check: revocation flips between gate and run must be honored.
      if (ctx.sentinel && ctx.sentinel.handsRevoked) {
        return { ok: false, error: 'hands revoked (disabled while agent running)' };
      }
      if (!hands.enabled) {
        return { ok: false, error: 'hands disabled in config (hands.enabled=false). Toggle in settings.' };
      }
      const client = require('./hands_client');
      const c = client(hands);
      try {
        return await c.request(args);
      } catch (e) {
        return { ok: false, error: `hands sidecar: ${e.message}` };
      }
    },
  };
}

function buildTools(cfg, opts = {}) {
  const tools = [...mkFsTools(), mkWebTool(), mkShellTool(), mkHandsTool(cfg)];
  // Subagent (Antigravity-style delegation). Not registered for child agents
  // — mkSubagentTool's own depth check also fails closed.
  if (!(opts.disableSubagent)) {
    tools.push(require('./subagent').mkSubagentTool(opts.subagent || {}));
    if (opts.mcp) tools.push(...require('./mcp').mkMcpTools(opts.mcp));
  }
  const map = new Map(tools.map(t => [t.name, t]));
  return { tools, map };
}

// OpenAI function-tool schema
function toSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

module.exports = { buildTools, toSchema, IS_WIN, isPrivateHost };
