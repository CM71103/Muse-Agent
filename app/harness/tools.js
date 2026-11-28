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

const readline = require('readline');

const IS_WIN = process.platform === 'win32';
const MAXWebResponse = 24000;         // chars kept from any web response
const MAXWebResponseBytes = 2 * 1024 * 1024;  // hard byte cap before decode
const MAX_DIR_ENTRIES = 500;

// Search tools stay bounded: a runaway walk must not stall the turn.
const MAX_SCAN_FILES = 5000;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', 'venv', '__pycache__']);
const BINARY_SAMPLE = 8000;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Glob -> RegExp. * is one path segment, ** is any depth, ? is one character,
// {a,b} is alternation. Matching walks real files, so a pattern that escapes
// the base folder can never reach outside it.
function globToRegExp(glob) {
  const src = String(glob || '').replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') {
        i++;
        if (src[i + 1] === '/') { i++; re += '(?:.*/)?'; }
        else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = src.indexOf('}', i);
      if (end > i) {
        re += '(?:' + src.slice(i + 1, end).split(',').map(part => escapeRegExp(part)).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`, IS_WIN ? 'i' : '');
}

// Collect files under root without following symlinks or entering dependency
// and VCS folders. Depth-first with a hard file cap keeps worst cases bounded.
async function collectFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < MAX_SCAN_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
        if (out.length >= MAX_SCAN_FILES) break;
      }
    }
  }
  return out;
}

// Read a 1-based line range cheaply: the stream stops once the range or the
// byte cap is reached instead of loading the whole file.
async function readLineRange(p, start, count, cap) {
  const rl = readline.createInterface({ input: fs.createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  const lines = [];
  let number = 0;
  let bytes = 0;
  let byteCapped = false;
  try {
    for await (const line of rl) {
      number++;
      if (number < start) continue;
      if (bytes + line.length + 1 > cap) { byteCapped = true; break; }
      lines.push(line);
      bytes += line.length + 1;
      if (lines.length >= count) break;
    }
  } finally { rl.close(); }
  return { lines, lastLine: number, byteCapped };
}

function mkShellTool() {
  return {
    name: 'shell',
    description: 'Run a shell command. On Windows uses cmd.exe /d /s /c, elsewhere /bin/sh -c. ' +
      'For PowerShell syntax invoke powershell.exe -NoProfile -NonInteractive -Command. ' +
      'Commands run with your user permissions. Approval follows the active permission mode; Auto runs without prompts. Sentinel deny rules still apply.',
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
        // Match Node's Windows shell boundary: cmd /s removes one outer
        // quote pair, preserving inner PowerShell script/argument quotes.
        // Generic argv escaping otherwise turns the script into literal text.
        const shellArgs = IS_WIN ? ['/d', '/s', '/c', `"${args.command}"`] : ['-c', args.command];
        execFile(file, shellArgs, {
          cwd: ctx.cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          // Stop must kill the command: a shell that keeps running after the
          // user pressed Stop is exactly the "it does not stop" complaint.
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(IS_WIN ? { windowsVerbatimArguments: true } : {}),
        }, (err, stdout, stderr) => {
          const parts = [];
          if (stdout) parts.push(String(stdout));
          if (stderr) parts.push(`[stderr]\n${stderr}`);
          if (err && err.killed) parts.push(`[timed out after ${timeout / 1000}s]`);
          // The run was cancelled, not the command failing.
          if (err && (err.name === 'AbortError' || ctx.signal?.aborted)) {
            resolve({ ok: false, error: 'cancelled: the command was stopped', cancelled: true });
            return;
          }
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
    description: 'Read a text file. Pass offset and limit to page through a large file by line; without them it returns the first 24000 bytes. Approval follows the active permission mode; Auto reads without prompts, other modes ask outside the granted project scope. Reading private locations marks the session tainted; network egress then follows the sentinel allowlist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or cwd-relative path' },
        offset: { type: 'number', description: 'Optional 1-based first line to return' },
        limit: { type: 'number', description: 'Optional number of lines to return (default 400, max 2000)' },
        max_bytes: { type: 'number', description: 'Optional byte cap; default and maximum 24000' },
      },
      required: ['path'],
    },
    async run(args, ctx) {
      const p = path.resolve(ctx.cwd, args.path);
      const stat = await fsp.stat(p);   // throws for missing -> tool error, not sentinel bypass
      if (stat.isDirectory()) return { ok: false, error: 'path is a directory; use list_dir or glob' };
      if (ctx.onPrivateRead) {
        try { ctx.onPrivateRead(p); } catch {}
      }
      const cap = Math.min(args.max_bytes || 24000, 24000); // ~6.5k tokens cap
      if (args.offset != null || args.limit != null) {
        const start = Math.max(1, Math.floor(args.offset || 1));
        const count = Math.min(Math.max(1, Math.floor(args.limit || 400)), 2000);
        const { lines, lastLine, byteCapped } = await readLineRange(p, start, count, cap);
        const end = lines.length ? start + lines.length - 1 : start - 1;
        return {
          ok: true, path: p, size: stat.size, first_line: start, last_line: end,
          content: lines.join('\n'),
          ...(lines.length >= count ? { next_offset: start + lines.length, note: `showing lines ${start}-${end}; pass offset ${start + lines.length} to continue` } : {}),
          ...(byteCapped ? { truncated: true, note: `line range exceeded ${cap} bytes; read a smaller range` } : {}),
        };
      }
      const fh = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(cap, stat.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const content = buf.slice(0, bytesRead).toString('utf8');
        return {
          ok: true, path: p, size: stat.size, truncated: stat.size > bytesRead, content,
          ...(stat.size > bytesRead ? { note: `file is ${stat.size} bytes; showing first ${cap}. Use offset/limit to page, or grep to find a section.` } : {}),
        };
      } finally { await fh.close(); }
    },
  };

  const write = {
    name: 'write_file',
    description: 'Write a text file (creates or overwrites). Approval follows the active permission mode; Auto writes without prompts.',
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
      // checkpoint pre-image BEFORE the write so the run can be undone
      if (ctx.checkpoint) await ctx.checkpoint.recordFile(p);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, args.content, 'utf8');
      return { ok: true, path: p, bytes: Buffer.byteLength(args.content) };
    },
  };

  const list = {
    name: 'list_dir',
    description: 'List directory entries with type and size. Approval follows the active permission mode; Auto lists without prompts, other modes ask outside granted project scope.',
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

  const edit = {
    name: 'edit_file',
    description: 'Change part of an existing text file with an exact string replacement. old_string must match the file byte for byte, including indentation and line breaks; include surrounding lines so it is unique. Fails when old_string is missing or appears more than once (add context, or set replace_all). Use write_file only to create a file or replace all of it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace, copied from the file' },
        new_string: { type: 'string', description: 'Replacement text; empty string deletes' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run(args, ctx) {
      const p = path.resolve(ctx.cwd, args.path);
      const oldText = args.old_string;
      const newText = args.new_string;
      if (typeof oldText !== 'string' || !oldText.length) return { ok: false, error: 'old_string must be a non-empty string' };
      if (typeof newText !== 'string') return { ok: false, error: 'new_string must be a string (use "" to delete)' };
      if (oldText === newText) return { ok: false, error: 'old_string and new_string are identical; nothing to change' };
      const stat = await fsp.stat(p);
      if (stat.isDirectory()) return { ok: false, error: 'path is a directory; edit_file works on one file' };
      const text = await fsp.readFile(p, 'utf8');
      const hits = [];
      let at = text.indexOf(oldText);
      while (at !== -1) {
        hits.push(at);
        at = text.indexOf(oldText, at + oldText.length);
      }
      if (!hits.length) return { ok: false, error: 'old_string not found in the file; read the file again and copy the exact text' };
      if (hits.length > 1 && !args.replace_all) {
        const lines = hits.slice(0, 10).map(pos => text.slice(0, pos).split('\n').length);
        return {
          ok: false, error: `old_string matches ${hits.length} places (lines ${lines.join(', ')}); include more surrounding text to make it unique, or set replace_all to true`,
          matches: hits.length,
        };
      }
      const updated = args.replace_all
        ? text.split(oldText).join(newText)
        : text.slice(0, hits[0]) + newText + text.slice(hits[0] + oldText.length);
      // checkpoint pre-image BEFORE the write so the run can be undone
      if (ctx.checkpoint) await ctx.checkpoint.recordFile(p);
      await fsp.writeFile(p, updated, 'utf8');
      return {
        ok: true, path: p, replacements: args.replace_all ? hits.length : 1,
        first_line: text.slice(0, hits[0]).split('\n').length,
        bytes: Buffer.byteLength(updated),
      };
    },
  };

  const grep = {
    name: 'grep',
    description: 'Search file contents with a regular expression and return matching lines with their line numbers. Skips node_modules, .git and other dependency folders, binary files and files over 2 MB. Narrow with path and glob rather than reading whole trees.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', description: 'File or folder to search; default cwd' },
        glob: { type: 'string', description: 'Optional file filter, e.g. **/*.js or *.{ts,tsx}' },
        ignore_case: { type: 'boolean' },
        max_results: { type: 'number', description: 'Default 80, max 500' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const root = path.resolve(ctx.cwd, args.path || '.');
      const pattern = String(args.pattern || '');
      if (!pattern) return { ok: false, error: 'pattern must be a non-empty string' };
      let re;
      try { re = new RegExp(pattern, args.ignore_case ? 'i' : ''); }
      catch (e) { return { ok: false, error: `invalid regular expression: ${e.message}` }; }
      const max = Math.min(Math.max(1, Math.floor(args.max_results || 80)), 500);
      const rootStat = await fsp.stat(root);
      const base = rootStat.isDirectory() ? root : path.dirname(root);
      const globRe = args.glob ? globToRegExp(args.glob) : null;
      const files = rootStat.isFile() ? [root] : await collectFiles(root);
      if (ctx.onPrivateRead) { try { ctx.onPrivateRead(root); } catch {} }
      const matches = [];
      let scanned = 0;
      let skippedLarge = 0;
      let truncated = false;
      for (const file of files) {
        if (matches.length >= max) { truncated = true; break; }
        if (globRe) {
          const rel = path.relative(base, file).split(path.sep).join('/');
          if (!globRe.test(rel)) continue;
        }
        let stat;
        try { stat = await fsp.stat(file); } catch { continue; }
        if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) { skippedLarge++; continue; }
        let text;
        try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
        if (text.slice(0, BINARY_SAMPLE).includes('\u0000')) continue;
        scanned++;
        const lines = text.split(/\r?\n/);
        const shown = path.relative(base, file).split(path.sep).join('/');
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          matches.push({ path: shown, line: i + 1, text: lines[i].length > 300 ? lines[i].slice(0, 299) + '…' : lines[i] });
          if (matches.length >= max) { truncated = true; break; }
        }
      }
      return {
        ok: true, pattern, path: root, matches, files_scanned: scanned, files_searched: files.length,
        ...(truncated ? { truncated: true, note: `stopped at ${max} matches; narrow the pattern or path` } : {}),
        ...(skippedLarge ? { files_skipped: skippedLarge } : {}),
      };
    },
  };

  const glob = {
    name: 'glob',
    description: 'Find files by glob pattern relative to a folder: * matches one path segment, ** any depth, ? one character, {a,b} alternatives. Skips dependency and VCS folders. Use it to locate files before reading them.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'e.g. src/**/*.ts or **/*.test.js' },
        path: { type: 'string', description: 'Base folder; default cwd' },
        max_results: { type: 'number', description: 'Default 200, max 1000' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const root = path.resolve(ctx.cwd, args.path || '.');
      const pattern = String(args.pattern || '');
      if (!pattern) return { ok: false, error: 'pattern must be a non-empty string' };
      const re = globToRegExp(pattern);
      const max = Math.min(Math.max(1, Math.floor(args.max_results || 200)), 1000);
      const rootStat = await fsp.stat(root);
      const base = rootStat.isDirectory() ? root : path.dirname(root);
      const files = rootStat.isFile() ? [root] : await collectFiles(root);
      const matches = [];
      for (const file of files) {
        const rel = path.relative(base, file).split(path.sep).join('/');
        if (re.test(rel)) matches.push(rel);
        if (matches.length >= max) break;
      }
      matches.sort();
      return {
        ok: true, pattern, path: root, matches,
        ...(matches.length >= max ? { truncated: true, note: `stopped at ${max} files; tighten the pattern` } : {}),
      };
    },
  };

  return [read, write, list, edit, grep, glob];
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
    description: 'Fetch a URL (HTTP GET, text only). Approval follows the active permission mode; Auto fetches without prompts. Private/loopback destinations are blocked; every redirect hop is revalidated. Output is byte-capped.',
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
      let cancelled = false;
      const cancel = () => { cancelled = true; ac.abort(); };
      ctx.signal?.addEventListener('abort', cancel, { once: true });
      if (ctx.signal?.aborted) cancel();
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
            return { ok: false, error: 'blocked: local network destinations are not enabled for this session' };
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
        if (cancelled) return { ok: false, error: 'cancelled by user' };
        if (ac.signal.aborted) return { ok: false, error: 'web_fetch timed out after 30s' };
        return { ok: false, error: String(e && e.message || e) };
      } finally { clearTimeout(t); ctx.signal?.removeEventListener('abort', cancel); }
    },
  };
}

function buildTools(cfg, opts = {}) {
  const sandbox = require('./sandbox-tools.ts');
  if (sandbox.sandboxSelected()) {
    const tools = opts.disableSubagent ? [] : sandbox.mkSandboxTools();
    return { tools, map: new Map(tools.map(tool => [tool.name, tool])) };
  }
  const tools = [...mkFsTools(), mkWebTool(), mkShellTool(), ...require('./datasources').dataTools(), ...require('./dashboards').dashboardTools(), ...require('./visual-tools.ts').mkVisualTools(), ...require('./critic').critiqueTools(), ...require('./research').researchTools(), ...require('./preview-tools.ts').mkPreviewTools(), ...require('./astryx-tools.ts').mkAstryxTools(), require('./research-brief').mkResearchBriefTool()];
  // Subagent (Antigravity-style delegation). Not registered for child agents
  // — mkSubagentTool's own depth check also fails closed.
  if (!(opts.disableSubagent)) {
    tools.push(require('./subagent').mkSubagentTool(opts.subagent || {}));
    const mcp = require('./mcp');
    if (opts.mcp || mcp.registry._external.size) tools.push(...mcp.mkMcpTools(opts.mcp));
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

module.exports = { buildTools, toSchema, IS_WIN, isPrivateHost, mkWebTool, assertPublicAddress };
