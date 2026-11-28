'use strict';
// approval-record.js - the signed record behind every permission gate.
// The card shows a request digest, its scope and its exit conditions before
// anything runs; the decision is written to the session as a receipt signed
// with a per-install key, so a later reader can tell that the record was not
// edited after the fact.
//
// Key: <config dir>/approval-signing.key (32 random bytes, mode 0600).
// The key never leaves the machine and is never part of a receipt.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_FILE = 'approval-signing.key';
const RECORD_VERSION = 1;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function hexKey(key) {
  return Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'hex');
}

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(hexKey(key)).digest('hex').slice(0, 8);
}

// Create the install key on first use. mkdir is idempotent; the file is
// written with mode 0600 so other users on the machine cannot read it.
function signingKey(dir) {
  const base = dir || path.join(require('node:os').homedir(), '.muse-agent');
  const file = path.join(base, KEY_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) return Buffer.from(existing, 'hex');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(base, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on filesystems without modes */ }
  return key;
}

function sign(payload, key) {
  return crypto.createHmac('sha256', hexKey(key)).update(canonicalJson(payload)).digest('hex');
}

function verify(payload, signature, key) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(sign(payload, key), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function insideRoot(target, root) {
  if (!target || !root) return false;
  const p = process.platform === 'win32' ? target.toLowerCase() : target;
  let r = process.platform === 'win32' ? root.toLowerCase() : root;
  if (!r.endsWith(path.sep)) r += path.sep;
  return p === r.slice(0, -1) || p.startsWith(r);
}

function displayPath(target, projectDir) {
  if (!projectDir) return target;
  try {
    const rel = path.relative(projectDir, target);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  } catch { /* fall through to absolute */ }
  return target;
}

const FILE_TOOLS = new Set(['read_file', 'write_file', 'list_dir', 'edit_file', 'apply_patch', 'glob', 'grep']);
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search', 'read_paper', 'search_papers', 'cite_source', 'download']);
const MODEL_TOOLS = new Set(['spawn_agent', 'critique', 'research', 'visual_render', 'visual_explain']);

// Scope answers "what does this request reach?" in terms the person can check
// without reading the raw arguments.
function scopeFor(request, ctx) {
  const args = (request && request.args) || {};
  const context = ctx || {};
  const projectDir = context.projectDir || null;
  const tool = String((request && request.tool) || 'tool');
  const resolved = request && request.resolvedPath ? String(request.resolvedPath) : '';

  if (tool === 'shell' || tool.startsWith('windows_') || tool.startsWith('sandbox_') || tool === 'powershell') {
    const cwd = args.cwd || projectDir || process.cwd();
    return { kind: 'device', label: 'This device', detail: `runs in ${displayPath(String(cwd), projectDir)}` };
  }
  if (FILE_TOOLS.has(tool) || resolved) {
    const target = resolved || (typeof args.path === 'string' ? path.resolve(String(args.path)) : '');
    if (!target) return { kind: 'tool', label: tool, detail: 'path not resolved' };
    if (projectDir && insideRoot(target, projectDir)) {
      return { kind: 'project', label: 'Your project folder', detail: displayPath(target, projectDir) };
    }
    return { kind: 'outside', label: 'Outside your project', detail: target };
  }
  if (NETWORK_TOOLS.has(tool)) {
    let host = '';
    try { host = new URL(String(args.url || '')).hostname; } catch { /* no url argument */ }
    return { kind: 'network', label: 'The network', detail: host || tool };
  }
  if (tool.startsWith('mcp__')) {
    const server = tool.slice(5).split('__')[0] || 'server';
    return { kind: 'tool', label: `MCP server “${server}”`, detail: tool };
  }
  if (MODEL_TOOLS.has(tool)) {
    return { kind: 'model', label: 'Your model key', detail: 'one billed model call' };
  }
  return { kind: 'tool', label: 'This app', detail: tool };
}

function humanDuration(seconds) {
  const s = Math.max(1, Math.round(Number(seconds) || 0));
  for (const [size, name] of [[3600, 'hour'], [60, 'minute'], [1, 'second']]) {
    if (s % size === 0) {
      const n = s / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${s} seconds`;
}

// What ends the gate. Stated on the card before the decision is taken.
function exitConditions(ctx) {
  const timeoutS = (ctx && ctx.timeoutS) || 3600;
  return [
    { when: 'allow', then: 'Runs once with exactly these arguments; the output returns to the agent.' },
    { when: 'deny', then: 'Nothing runs and the agent is told the request was denied.' },
    { when: 'timeout', then: `No answer for ${humanDuration(timeoutS)} → denied automatically.` },
    { when: 'drift', then: 'Target or permission mode changes before it starts → refused, no run.' },
  ];
}

function actionSummary(request) {
  const args = (request && request.args) || {};
  const tool = String((request && request.tool) || 'tool');
  if (tool === 'shell' || tool === 'powershell' || tool.startsWith('windows_')) {
    return String(args.command || args.script || '').split('\n')[0].slice(0, 160) || tool;
  }
  if (typeof args.path === 'string') return args.path;
  if (typeof args.url === 'string') return args.url;
  return tool;
}

function buildRequest(request, ctx) {
  const context = ctx || {};
  const now = Number(context.now) || Date.now();
  const timeoutS = context.timeoutS || 3600;
  const record = {
    v: RECORD_VERSION,
    id: String(context.id || crypto.randomUUID()),
    sessionId: context.sessionId || null,
    tool: String((request && request.tool) || 'tool'),
    action: actionSummary(request),
    args: (request && request.args) || {},
    resolvedPath: (request && request.resolvedPath) || null,
    scope: scopeFor(request, context),
    exit: exitConditions({ timeoutS }),
    mode: context.mode || null,
    reason: (request && request.reason) || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutS * 1000).toISOString(),
  };
  const digest = crypto.createHash('sha256').update(canonicalJson(record)).digest('hex');
  return { record, digest, short: digest.slice(0, 12), timeoutS };
}

// The fields the renderer gets before the decision; no arguments are copied.
function publicRecord(built, key) {
  const { record, digest, short } = built;
  return {
    id: record.id,
    digest,
    short,
    tool: record.tool,
    action: record.action,
    scope: record.scope,
    exit: record.exit,
    mode: record.mode,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    sig: sign(record, key),
    keyFingerprint: keyFingerprint(key),
  };
}

function makeReceipt(built, decision) {
  const opts = decision || {};
  const { record, digest } = built;
  const body = {
    type: 'approval',
    v: RECORD_VERSION,
    id: record.id,
    requestDigest: digest,
    tool: record.tool,
    action: record.action,
    scope: record.scope,
    decision: opts.decision === 'allow' ? 'allow' : 'deny',
    decidedBy: opts.decidedBy || 'user',
    reason: opts.reason || null,
    decidedAt: opts.decidedAt || new Date().toISOString(),
    keyFingerprint: keyFingerprint(opts.key),
  };
  return { ...body, sig: sign(body, opts.key) };
}

function verifyReceipt(receipt, key) {
  if (!receipt || receipt.type !== 'approval' || typeof receipt.sig !== 'string') return false;
  // kind/ts are the JSONL envelope added by the session writer, not the record.
  const { sig, kind, ts, ...body } = receipt;
  return verify(body, sig, key);
}

module.exports = {
  KEY_FILE,
  canonicalJson,
  signingKey,
  keyFingerprint,
  sign,
  verify,
  scopeFor,
  exitConditions,
  buildRequest,
  publicRecord,
  makeReceipt,
  verifyReceipt,
  humanDuration,
};
