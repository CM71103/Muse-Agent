'use strict';
// voice-sources.js — find and parse the user's EXISTING AI conversation
// history on this machine (the "vibe calibration" sources). Each source
// yields normalized {role:'user'|'assistant', text} pairs. Nothing leaves the
// machine, and downstream analysis keeps metrics only — never message text.
//
// Sources, by confidence:
//   chatgpt-export   (high)   conversations.json from a ChatGPT data export
//   claude-projects  (high)   ~/.claude/projects/**/*.jsonl transcripts
//   muse-sessions    (high)   this app's own session rollouts
//   web-cache        (low)    chatgpt.com IndexedDB/LevelDB string fragments
//                             (best-effort: roles inferred by length)

const fs = require('fs');
const path = require('path');
const os = require('os');

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

function parseChatgptExport(file) {
  const out = [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return out; }
  const convs = Array.isArray(data) ? data : [];
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
  // 1. ChatGPT data export: conversations.json sitting in Downloads & friends
  const docDirs = ['Downloads', 'Documents', 'Desktop'].map(d => path.join(home, d));
  for (const dir of docDirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name === 'conversations.json') roots.push({ kind: 'chatgpt-export', path: path.join(dir, e.name), confidence: 'high' });
    }
  }
  // 2. Claude Code transcripts
  const claudeDir = path.join(home, '.claude', 'projects');
  if (fs.existsSync(claudeDir)) roots.push({ kind: 'claude-projects', path: claudeDir, confidence: 'high' });
  // 3. Muse's own sessions
  if (configDir) {
    const sess = path.join(configDir, 'sessions');
    if (fs.existsSync(sess)) roots.push({ kind: 'muse-sessions', path: sess, confidence: 'high' });
  }
  // 4. chatgpt.com web caches (browser profiles + the desktop app package)
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
    case 'claude-projects': return parseClaudeProjects(root.path);
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

module.exports = { discoverRoots, parseRoot, collectMessages, parseChatgptExport, parseClaudeProjects, parseMuseSessions, parseWebCache };
