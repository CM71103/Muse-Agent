'use strict';
// session.js - session persistence. Conversations saved as JSON under
// ~/.muse-agent/sessions/<id>.json. History = OpenAI-format messages, replayable.
// Sessions survive app restarts; deleting a session removes its file only.
// Contract used by agent.js: newId(), save({id, created, title, history, tainted}),
// load(id) -> session | throws, titleFromHistory(history), list(), remove(id).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configDir } = require('./config');

function sessionsDir() {
  return path.join(configDir(), 'sessions');
}

function sessionFile(id) {
  // id comes from disk/IPA - keep it strictly safe (uuid chars only)
  if (!/^[\w-]+$/.test(String(id))) throw new Error('bad session id');
  return path.join(sessionsDir(), `${id}.json`);
}

function newId() {
  return crypto.randomUUID();
}

function list() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        id: s.id,
        title: s.title || 'untitled',
        created: s.created || null,
        updatedAt: s.updatedAt || null,
        turns: (s.history || []).length,
        projectId: s.projectId || null,
      });
    } catch { /* skip corrupt file */ }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

function load(id) {
  const file = sessionFile(id);
  if (!fs.existsSync(file)) return null;   // agent.js checks falsy; index.js also handles
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(session) {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const id = session.id || newId();
  const prev = load(id);                    // keep original created/title on update
  const s = {
    id,
    title: session.title || (prev && prev.title) || 'untitled',
    created: session.created || (prev && prev.created) || now,
    updatedAt: now,
    projectId: session.projectId === undefined ? ((prev && prev.projectId) || null) : (session.projectId || null),
    tainted: !!session.tainted,
    history: session.history || [],
  };
  const file = sessionFile(s.id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file); // atomic replace: never leaves a half-written session
  return s;
}

function remove(id) {
  const file = sessionFile(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function titleFromText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : (t || 'untitled');
}

function titleFromHistory(history) {
  const first = (history || []).find(m => m.role === 'user');
  return titleFromText(first && typeof first.content === 'string' ? first.content : '');
}

module.exports = { list, load, save, remove, newId, titleFromText, titleFromHistory, sessionsDir };
