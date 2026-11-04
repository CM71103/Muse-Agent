'use strict';
// session.js — append-only JSONL rollout: the transcript of record.
// File: ~/.muse-agent/sessions/<id>.jsonl
//   {kind:'meta', v:1, id, created, title, projectId, tainted}   (re-appended on change)
//   {kind:'m', seq, msg}                                          seq = index in history
//   {kind:'snapshot', seq, history}                               supersedes prior m/snapshot
//   {kind:'summary', turnKey, full, compact, revision, updated_at}
// Replay: meta latest-wins; m records deduped by seq; snapshot replaces; a torn
// final line (crash mid-append) is skipped. Legacy <id>.json still loads; first
// save migrates it to .jsonl. Contract used by agent.js is unchanged:
// newId(), save({id, created, title, history, tainted, projectId}), load(id),
// titleFromHistory(history), list(), remove(id) — plus saveSummary(id, s).
// ponytail: no SQLite catalog index — list()/load() replay JSONL directly
//   (same cost as the old full-JSON rewrite). Add a derived, rebuildable
//   thread-catalog table when list() slows at hundreds of sessions. Separate
//   event ledger skipped: m/snapshot records already carry seq for idempotent
//   ordering; add one when non-message events need durable sequencing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configDir } = require('./config');

const SUMMARY_FULL_MAX = 280;
const SUMMARY_COMPACT_MAX = 60;

// Writer state per session id: enables the append-only fast path. Lost on
// restart — first save after restart reconciles against the file (see save()).
const wstate = new Map();

function sessionsDir() {
  return path.join(configDir(), 'sessions');
}

function checkId(id) {
  // id comes from disk/IPC — keep it strictly safe (uuid chars only)
  if (!/^[\w-]+$/.test(String(id))) throw new Error('bad session id');
  return String(id);
}

function jsonlFile(id) { return path.join(sessionsDir(), `${checkId(id)}.jsonl`); }
function legacyFile(id) { return path.join(sessionsDir(), `${checkId(id)}.json`); }

function newId() { return crypto.randomUUID(); }

// --- read side ---

// Parse one .jsonl into a session object. Unparseable lines are skipped:
// only a torn tail is expected, and skipping it loses at most one append.
function readJsonl(file) {
  const s = { id: null, title: 'untitled', created: null, updatedAt: null, projectId: null, tainted: false, history: [], summaries: {} };
  let lastSeq = -1;
  const data = fs.readFileSync(file, 'utf8');
  for (const line of data.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    switch (rec.kind) {
      case 'meta':
        s.id = rec.id || s.id;
        if (rec.title) s.title = rec.title;
        if (rec.created) s.created = rec.created;
        if (rec.projectId !== undefined) s.projectId = rec.projectId;
        if (rec.tainted !== undefined) s.tainted = !!rec.tainted;
        break;
      case 'm':
        if (typeof rec.seq === 'number' && rec.seq > lastSeq && rec.msg) {
          s.history.push(rec.msg);
          lastSeq = rec.seq;
        }
        break;
      case 'snapshot':
        if (Array.isArray(rec.history) && typeof rec.seq === 'number' && rec.seq >= lastSeq) {
          s.history = rec.history;
          lastSeq = rec.seq;
        }
        break;
      case 'summary': {
        const key = String(rec.turnKey);
        const prev = s.summaries[key];
        if (!prev || (rec.revision || 0) >= prev.revision) s.summaries[key] = rec;
        break;
      }
      default: break; // unknown kinds ignored — forward compatible
    }
  }
  s.id = s.id || path.basename(file, '.jsonl');
  s.updatedAt = fs.statSync(file).mtime.toISOString();
  return s;
}

function readLegacy(file) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    id: s.id, title: s.title || 'untitled', created: s.created || null,
    updatedAt: s.updatedAt || fs.statSync(file).mtime.toISOString(),
    projectId: s.projectId || null, tainted: !!s.tainted,
    history: s.history || [], summaries: {},
  };
}

function load(id) {
  checkId(id);
  const jl = jsonlFile(id), lg = legacyFile(id);
  if (fs.existsSync(jl)) return readJsonl(jl);
  if (fs.existsSync(lg)) { try { return readLegacy(lg); } catch { return null; } }
  return null; // agent.js checks falsy
}

function list() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const seen = new Set();
  // .jsonl wins over a same-id legacy .json (post-migration both may exist)
  for (const f of fs.readdirSync(dir).sort((a, b) => (a.endsWith('.jsonl') ? -1 : 1) - (b.endsWith('.jsonl') ? -1 : 1))) {
    let id = null;
    if (f.endsWith('.jsonl')) id = f.slice(0, -6);
    else if (f.endsWith('.json')) id = f.slice(0, -5);
    else continue;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const s = load(id);
      if (!s) continue;
      out.push({ id: s.id, title: s.title, created: s.created, updatedAt: s.updatedAt, turns: s.history.length, projectId: s.projectId });
    } catch { /* skip corrupt file */ }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

// --- write side ---

function appendLine(file, rec) {
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

function metaOf(s) {
  return { kind: 'meta', v: 1, id: s.id, created: s.created, title: s.title, projectId: s.projectId || null, tainted: !!s.tainted };
}

function save(session) {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const id = checkId(session.id || newId());
  const file = jsonlFile(id);
  const history = session.history || [];
  const existed = fs.existsSync(file);

  // seed meta from prior state (jsonl meta line, legacy json, or caller)
  let prev = null;
  if (existed) { try { prev = readJsonl(file); } catch { prev = null; } }
  if (!prev && fs.existsSync(legacyFile(id))) { try { prev = readLegacy(legacyFile(id)); } catch { prev = null; } }

  const s = {
    id,
    title: session.title || (prev && prev.title) || 'untitled',
    created: session.created || (prev && prev.created) || now,
    projectId: session.projectId === undefined ? ((prev && prev.projectId) || null) : (session.projectId || null),
    tainted: !!session.tainted,
    history,
  };

  const st = wstate.get(id);
  // boundary compare by JSON, not identity: callers may rebuild message objects
  const boundary = (arr, n) => JSON.stringify(n > 0 ? arr[n - 1] : null);
  // Append fast path: this process wrote the tail and history only grew.
  const canAppend = st && history.length >= st.count && boundary(history, st.count) === st.lastJson;
  // Post-restart reconciliation: no writer state, but the file's messages are a
  // prefix of history and nothing was rewritten (no compaction block).
  const compacted = history.some(m => m && m.name === 'compacted');
  const fileMsgs = existed && prev ? prev.history.length : 0;
  const canResume = !st && existed && !compacted && fileMsgs <= history.length
    && boundary(history, fileMsgs) === boundary(prev.history, fileMsgs);

  if (!existed) {
    appendLine(file, metaOf(s));
    history.forEach((msg, seq) => appendLine(file, { kind: 'm', seq, msg }));
  } else {
    // meta line only when something user-visible changed
    if (!prev || prev.title !== s.title || prev.projectId !== s.projectId || prev.tainted !== s.tainted) {
      appendLine(file, metaOf(s));
    }
    if (canAppend) {
      for (let seq = st.count; seq < history.length; seq++) appendLine(file, { kind: 'm', seq, msg: history[seq] });
    } else if (canResume) {
      for (let seq = fileMsgs; seq < history.length; seq++) appendLine(file, { kind: 'm', seq, msg: history[seq] });
    } else {
      // history was rewritten (compaction) or diverged: snapshot supersedes
      appendLine(file, { kind: 'snapshot', seq: history.length, history });
    }
  }

  wstate.set(id, { count: history.length, lastJson: boundary(history, history.length) });
  return { ...s, updatedAt: now };
}

// Two-tier turn summary (codex thread_turn_summaries pattern): full <=280 for
// expanded view, compact <=60 keyed to a turn for collapsed labels, revision
// for optimistic concurrency. Appended, never rewritten; replay keeps max rev.
function saveSummary(id, { turnKey, full, compact }) {
  checkId(id);
  const file = jsonlFile(id);
  if (!fs.existsSync(file)) return null; // session not persisted yet; regenerated next compaction
  const f = String(full || '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_FULL_MAX);
  const c = String(compact || '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_COMPACT_MAX);
  if (!f && !c) return null;
  let revision = 0;
  try {
    const existing = readJsonl(file).summaries[String(turnKey)];
    if (existing) revision = (existing.revision || 0) + 1;
  } catch { /* corrupt file: revision 0 still appends */ }
  const rec = { kind: 'summary', turnKey: String(turnKey), full: f, compact: c, revision, updated_at: new Date().toISOString() };
  appendLine(file, rec);
  return rec;
}

function remove(id) {
  checkId(id);
  let removed = false;
  for (const f of [jsonlFile(id), legacyFile(id)]) {
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true; }
  }
  wstate.delete(id);
  return removed;
}

function titleFromText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : (t || 'untitled');
}

function titleFromHistory(history) {
  const first = (history || []).find(m => m.role === 'user');
  return titleFromText(first && typeof first.content === 'string' ? first.content : '');
}

module.exports = { list, load, save, remove, newId, saveSummary, titleFromText, titleFromHistory, sessionsDir, SUMMARY_FULL_MAX, SUMMARY_COMPACT_MAX };
