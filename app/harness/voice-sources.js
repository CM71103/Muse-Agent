'use strict';
// voice-sources.js — find and parse the user's EXISTING AI conversation
// history on this machine (the "vibe calibration" sources). Each source
// yields normalized {role:'user'|'assistant', text} pairs. Nothing leaves the
// machine, and downstream analysis keeps metrics only — never message text.
//
// Sources, by confidence:
//   chatgpt-export   (high)   conversations.json from a ChatGPT data export
//   claude-projects  (high)   ~/.claude/projects/**/*.jsonl transcripts
//   codex-sessions   (high)   ~/.codex/sessions/**/rollout-*.jsonl[.zst]
//   muse-sessions    (high)   this app's own session rollouts
//   web-cache        (low)    chatgpt.com IndexedDB/LevelDB string fragments
//                             (best-effort: roles inferred by length)

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const MAX_MESSAGES = 20000;          // analysis cap; plenty for statistics
const MIN_TEXT = 2;
const MAX_TEXT = 8000;

function cleanText(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length < MIN_TEXT || t.length > MAX_TEXT) return null;
  return t;
}

function pushPair(out, role, text) {
  const t = cleanText(text);
  if (!t) return;
  if (out.length < MAX_MESSAGES) out.push({ role, text: t });
}

// --- source parsers ---

// --- zip reading (minimal, stdlib-only) ---
// A ChatGPT data export downloads as a .zip whose only interesting member is
// conversations.json. Reading just that member takes the central directory
// (end-of-central-directory record), one local header, and inflateRaw.

function zipEntryData(zipPath, suffix) {
  let buf;
  try { buf = fs.readFileSync(zipPath); } catch { return null; }
  // EOCD: signature PK\x05\x06 within the last 66 KB of the file.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries && ptr + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localAt = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    if (name.endsWith(suffix)) {
      if (localAt + 30 > buf.length) return null;
      const start = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
      const raw = buf.slice(start, start + compSize);
      try {
        return method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
      } catch { return null; }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function parseChatgptData(data) {
  const out = [];
  // a full export is an array of conversations; a single shared/exported chat
  // is one object with a mapping
  const convs = Array.isArray(data) ? data : (data && data.mapping ? [data] : []);
  for (const conv of convs) {
    const mapping = conv && conv.mapping;
    if (!mapping || typeof mapping !== 'object') continue;
    // mapping is a tree; values arrive out of order — sort by create_time
    const nodes = Object.values(mapping)
      .filter(n => n && n.message && n.message.content && n.message.author)
      .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
    for (const n of nodes) {
      const role = n.message.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const parts = n.message.content.parts;
      const text = Array.isArray(parts) ? parts.filter(p => typeof p === 'string').join('\n') : n.message.content.text;
      pushPair(out, role, text);
    }
  }
  return out;
}

function parseChatgptExport(file) {
  try { return parseChatgptData(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return []; }
}

function parseChatgptZip(file) {
  const raw = zipEntryData(file, 'conversations.json');
  if (!raw) return [];
  try { return parseChatgptData(JSON.parse(raw.toString('utf8'))); } catch { return []; }
}

function parseClaudeProjects(dir) {
  const out = [];
  let files = [];
  try {
    const projects = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const p of projects) {
      let entries = [];
      try { entries = fs.readdirSync(path.join(dir, p.name)); } catch { continue; }
      for (const f of entries) {
        if (f.endsWith('.jsonl')) files.push(path.join(dir, p.name, f));
      }
    }
  } catch { return out; }
  for (const file of files.slice(0, 400)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (out.length >= MAX_MESSAGES) return out;
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const msg = rec && rec.message;
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      if (typeof msg.content === 'string') {
        pushPair(out, msg.role, msg.content);
      } else if (Array.isArray(msg.content)) {
        // text blocks only — tool results and tool use are not conversational voice
        const text = msg.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
        pushPair(out, msg.role, text);
      }
    }
  }
  return out;
}

// Codex (the OpenAI coding agent) keeps one rollout per session under
// ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl.zst. The payload is
// JSONL with response_item messages; zstd is provided by Node's own zlib.
const CODEX_SKIP_OPENERS = [
  '<environment_context>',
  '<user_instructions>',
  '<permissions instructions>',
  '<project_doc>',
];
function codexTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}
function codexIsNoise(text) {
  const t = text.trim();
  if (!t) return true;
  for (const opener of CODEX_SKIP_OPENERS) if (t.startsWith(opener)) return true;
  if (t.startsWith('PREVIOUS AI RESPONSE')) return true;      // replayed context, not the user's own words
  if (t.startsWith('[') && /^\[[^\]]*\]/.test(t)) return true; // "[Request interrupted by user...]"
  if (/^\[external_agent_tool_(call|result)/.test(t)) return true;
  return false;
}
function codexLines(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { return []; }
  if (file.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') return [];  // old Node: skip quietly
    try { raw = zlib.zstdDecompressSync(raw); } catch { return []; }
  }
  return raw.toString('utf8').split('\n');
}
function parseCodexSessions(dir) {
  const out = [];
  const files = [];
  const walk = (current, depth) => {
    if (depth > 4 || files.length >= 400) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^rollout-.*\.jsonl(\.zst)?$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir, 0);
  // newest first: recent turns describe how the user wants to be answered now
  files.sort((a, b) => {
    const ta = (() => { try { return fs.statSync(a).mtimeMs; } catch { return 0; } })();
    const tb = (() => { try { return fs.statSync(b).mtimeMs; } catch { return 0; } })();
    return tb - ta;
  });
  for (const file of files.slice(0, 200)) {
    for (const line of codexLines(file)) {
      if (out.length >= MAX_MESSAGES) return out;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || record.type !== 'response_item') continue;
      const payload = record.payload || {};
      if (payload.type !== 'message') continue;
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = codexTextOf(payload.content);
      if (codexIsNoise(text)) continue;
      // assistant turns marked as a tool call are machinery, not voice
      if (role === 'assistant' && payload.phase && payload.phase !== 'final_answer') continue;
      pushPair(out, role, text);
    }
  }
  return out;
}

// Cline (the VS Code agent) stores one JSON transcript per session under
// ~/.cline/data/sessions/<id>/<id>.messages.json. Tool traffic is skipped;
// only spoken text (user input, assistant answer) is voice.
function parseClineSessions(dir) {
  const out = [];
  const files = [];
  const walk = (current, depth) => {
    if (depth > 3 || files.length >= 400) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.messages.json')) files.push(full);
    }
  };
  walk(dir, 0);
  for (const file of files.slice(0, 200)) {
    if (out.length >= MAX_MESSAGES) return out;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const messages = Array.isArray(parsed) ? parsed : (parsed && parsed.messages);
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (out.length >= MAX_MESSAGES) return out;
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
      const parts = Array.isArray(message.content) ? message.content : [];
      const text = parts
        .filter(part => part && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n');
      if (!text) continue;
      if (message.role === 'user') {
        // "<user_input mode=\"plan\">the actual question</user_input>"
        const inner = text.match(/<user_input[^>]*>([\s\S]*?)<\/user_input>/i);
        pushPair(out, 'user', inner ? inner[1] : text);
      } else {
        pushPair(out, 'assistant', text);
      }
    }
  }
  return out;
}

function parseMuseSessions(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).slice(0, 400); } catch { return out; }
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (out.length >= MAX_MESSAGES) return out;
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec && rec.kind === 'm' && rec.msg && (rec.msg.role === 'user' || rec.msg.role === 'assistant')) {
        if (rec.msg.name === 'synthetic' || rec.msg.name === 'compacted') continue;
        pushPair(out, rec.msg.role, rec.msg.content);
      }
    }
  }
  return out;
}

// LevelDB string-fragment recovery (best effort): pull printable runs out of
// the chatgpt.com IndexedDB files. Long reads are attributed to the assistant,
// short ones to the user — crude but honest, and the analyzer weights this
// source 'low'.
function parseWebCache(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.ldb$|\.log$|\.sst$/.test(f)).slice(0, 40); } catch { return out; }
  const runRe = /[\t\n\r\x20-\x7e\u00a0-\uffff]{40,8000}/g;
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'latin1'); } catch { continue; }
    const seen = new Set();
    for (const m of raw.match(runRe) || []) {
      if (out.length >= MAX_MESSAGES) return out;
      const t = m.trim();
      if (seen.has(t)) continue;
      seen.add(t);
      // filter UI/serialization noise: markup, URLs-only, JSON skeletons
      if (/[<>]/.test(t) || /^https?:\/\//.test(t) || /\\u003[cg]/.test(t)) continue;
      if ((t.match(/[{}]/g) || []).length > 4) continue;
      if (!/[.!?]/.test(t)) continue;
      if (/[a-z]/.test(t.replace(/[^a-z]/gi, '')) === false) continue;
      pushPair(out, t.length >= 200 ? 'assistant' : 'user', t);
    }
  }
  return out;
}

// --- discovery ---

function discoverRoots({ home = os.homedir(), configDir } = {}) {
  const roots = [];
  // 1. ChatGPT data export: conversations.json — at the top level, nested in
  //    an extracted export folder, or still inside the export .zip itself
  //    (the way it downloads from OpenAI). Loose files win over zips.
  const docDirs = ['Downloads', 'Documents', 'Desktop'].map(d => path.join(home, d));
  const SKIP_DIR = /^(node_modules|\$recycle\.bin|system volume information|windows|appdata)$/i;
  const queue = docDirs.map(d => [d, 0]);
  let visited = 0, zips = 0;
  while (queue.length && visited < 300) {
    const [dir, depth] = queue.shift();
    visited++;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && !SKIP_DIR.test(e.name) && !e.name.startsWith('.')) queue.push([full, depth + 1]);
      } else if (e.isFile() && e.name === 'conversations.json') {
        roots.push({ kind: 'chatgpt-export', path: full, confidence: 'high' });
      } else if (e.isFile() && /\.zip$/i.test(e.name) && zips < 12) {
        // a random zip without conversations.json parses to [] and is dropped
        // by the min-messages rule downstream
        try {
          if (fs.statSync(full).size < 100 * 1024 * 1024) {
            roots.push({ kind: 'chatgpt-zip', path: full, confidence: 'high' });
            zips++;
          }
        } catch { /* unreadable */ }
      }
    }
  }
  // 2. Claude Code transcripts
  const claudeDir = path.join(home, '.claude', 'projects');
  if (fs.existsSync(claudeDir)) roots.push({ kind: 'claude-projects', path: claudeDir, confidence: 'high' });
  // 3. Codex (OpenAI coding agent) rollouts
  const codexDir = path.join(home, '.codex', 'sessions');
  if (fs.existsSync(codexDir)) roots.push({ kind: 'codex-sessions', path: codexDir, confidence: 'high' });
  // 4. Cline (the VS Code agent) transcripts
  const clineDir = path.join(home, '.cline', 'data', 'sessions');
  if (fs.existsSync(clineDir)) roots.push({ kind: 'cline-sessions', path: clineDir, confidence: 'high' });
  // 5. Muse's own sessions
  if (configDir) {
    const sess = path.join(configDir, 'sessions');
    if (fs.existsSync(sess)) roots.push({ kind: 'muse-sessions', path: sess, confidence: 'high' });
  }
  // 6. chatgpt.com web caches (browser profiles + the desktop app package)
  const cacheGlobs = [
    path.join(home, 'AppData', 'Local'),
    path.join(home, '.config'),
  ];
  for (const base of cacheGlobs) {
    if (!fs.existsSync(base)) continue;
    // depth-limited search for chatgpt.com IndexedDB LevelDB directories
    const stack = [[base, 0]];
    while (stack.length && roots.length < 40) {
      const [dir, depth] = stack.pop();
      if (depth > 6) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (/chatgpt\.com_0\.indexeddb\.leveldb$/i.test(e.name)) {
          roots.push({ kind: 'web-cache', path: full, confidence: 'low' });
        } else if (/^(IndexedDB|User Data|Local|Roaming|Packages|Microsoft|Google|BraveSoftware|chromium|ChatGPT|OpenAI)/i.test(e.name) || /ChatGPT-Desktop/i.test(e.name)) {
          stack.push([full, depth + 1]);
        }
      }
    }
  }
  return roots;
}

function parseRoot(root) {
  switch (root.kind) {
    case 'chatgpt-export': return parseChatgptExport(root.path);
    case 'chatgpt-zip': return parseChatgptZip(root.path);
    case 'claude-projects': return parseClaudeProjects(root.path);
    case 'codex-sessions': return parseCodexSessions(root.path);
    case 'cline-sessions': return parseClineSessions(root.path);
    case 'muse-sessions': return parseMuseSessions(root.path);
    case 'web-cache': return parseWebCache(root.path);
    default: return [];
  }
}

function collectMessages(opts = {}) {
  const roots = opts.roots || discoverRoots(opts);
  const messages = [];
  const usedRoots = [];
  for (const root of roots) {
    const found = parseRoot(root);
    if (found.length >= 5) {   // a source with under 5 messages tells us nothing
      usedRoots.push({ ...root, messages: found.length });
      messages.push(...found);
      if (messages.length >= MAX_MESSAGES) break;
    }
  }
  return { messages: messages.slice(0, MAX_MESSAGES), roots: usedRoots };
}

module.exports = { discoverRoots, parseRoot, collectMessages, parseChatgptExport, parseChatgptZip, parseChatgptData, parseClaudeProjects, parseCodexSessions, parseClineSessions, parseMuseSessions, parseWebCache };
