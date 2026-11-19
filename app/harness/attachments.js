'use strict';
// attachments.js — user-attached files (PDF, images) and their local text.
//
// Pipeline per attachment:
//   image → Windows OCR (local, offline) → text
//   PDF   → digital text layer (exact) → else OCR of rendered pages
//
// Images are ALSO kept as pixels so they can be handed to a vision-capable
// model; that decision is made at send time by model-caps.js, not here.
//
// Storage: ~/.muse-agent/attachments/<id>/ — the original file plus a small
// meta.json. Nothing leaves the machine.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configDir } = require('./config');
const ocr = require('./ocr');

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_CHARS = 60000;        // per attachment
const MAX_TOTAL_CHARS = 120000;      // per message

function rootDir() { return path.join(configDir(), 'attachments'); }

function idFor(file) {
  return crypto.createHash('sha1').update(`${file}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
}

function kindOf(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_MIME[ext]) return 'image';
  return null;
}

function mimeOf(file, kind) {
  if (kind === 'pdf') return 'application/pdf';
  return IMAGE_MIME[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

// Trim text to a budget, keeping the head and a tail marker.
function clip(text, max = MAX_TEXT_CHARS) {
  const t = String(text || '');
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n[… ${t.length - max} more characters truncated …]`;
}

// Ingest one file → descriptor. Never throws.
async function ingestFile(file) {
  const source = path.resolve(String(file));
  const kind = kindOf(source);
  if (!kind) return { ok: false, error: `unsupported file type: ${path.extname(source) || 'unknown'}` };
  let stat;
  try { stat = fs.statSync(source); } catch { return { ok: false, error: 'file not found' }; }
  if (!stat.isFile()) return { ok: false, error: 'not a file' };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: `file is too large (${Math.round(stat.size / 1048576)} MB, limit ${MAX_FILE_BYTES / 1048576} MB)` };
  if (stat.size === 0) return { ok: false, error: 'file is empty' };

  const id = idFor(source);
  const dir = path.join(rootDir(), id);
  const name = path.basename(source);
  const stored = path.join(dir, name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, stored);
  } catch (err) { return { ok: false, error: `could not store file: ${err && err.message || err}` }; }

  const meta = {
    id, name, kind, mime: mimeOf(source, kind),
    bytes: stat.size, path: stored, created_at: new Date().toISOString(),
    text: '', text_method: 'none', pages: 0, engine: null, error: null,
  };

  try {
    if (kind === 'pdf') {
      const res = await ocr.extractPdfText(stored, { maxPages: 40 });
      if (res.ok) {
        meta.text = clip(res.text);
        meta.text_method = res.method;
        meta.pages = res.pages || 0;
        meta.engine = res.engine || null;
      } else {
        meta.error = res.error || 'no text extracted';
      }
    } else {
      const res = await ocr.ocrImage(stored);
      if (res.ok) {
        meta.text = clip(res.text);
        meta.text_method = 'ocr';
        meta.engine = res.engine || null;
        meta.pages = 1;
      } else {
        meta.error = res.error || 'ocr failed';
      }
    }
  } catch (err) {
    meta.error = String(err && err.message || err);
  }

  try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8'); } catch { /* meta is a cache */ }
  return { ok: true, attachment: publicMeta(meta) };
}

// The renderer only ever sees a safe subset — never a filesystem path.
function publicMeta(meta) {
  return {
    id: meta.id, name: meta.name, kind: meta.kind, mime: meta.mime,
    bytes: meta.bytes, pages: meta.pages || 0, has_text: !!meta.text,
    text_method: meta.text_method || 'none', engine: meta.engine || null,
    error: meta.error || null, created_at: meta.created_at,
    preview: meta.text ? meta.text.slice(0, 320) : '',
  };
}

function loadMeta(id) {
  try {
    const file = path.join(rootDir(), String(id), 'meta.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function list() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(rootDir()); } catch { return out; }
  for (const id of dirs) {
    const meta = loadMeta(id);
    if (meta) out.push(publicMeta(meta));
  }
  out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}

function remove(id) {
  const dir = path.join(rootDir(), String(id));
  try { fs.rmSync(dir, { recursive: true, force: true }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

function clear() {
  try { fs.rmSync(rootDir(), { recursive: true, force: true }); } catch { /* nothing to clear */ }
  return { ok: true };
}

// Text of one attachment, in the shape the model sees it.
function textBlock(meta) {
  if (!meta || !meta.text) return '';
  const label = meta.name + (meta.pages ? ` (${meta.pages} page${meta.pages === 1 ? '' : 's'})` : '');
  return `[attached file: ${label}]\n${meta.text}`;
}

// Combined text for a set of attachment ids, within a total budget.
function textFor(ids) {
  const parts = [];
  let used = 0;
  for (const id of ids || []) {
    const meta = loadMeta(id);
    if (!meta || !meta.text) continue;
    const block = textBlock(meta);
    const room = MAX_TOTAL_CHARS - used;
    if (room <= 0) break;
    const clipped = block.length > room ? `${block.slice(0, room)}\n[…truncated…]` : block;
    parts.push(clipped);
    used += clipped.length;
  }
  return parts.join('\n\n');
}

// Image bytes (base64) for vision-capable sends.
function imageData(id) {
  const meta = loadMeta(id);
  if (!meta || meta.kind !== 'image') return null;
  try {
    const buf = fs.readFileSync(meta.path);
    return { mimeType: meta.mime, data: buf.toString('base64'), name: meta.name };
  } catch { return null; }
}

// Attachments that carry no text at all (image with failed OCR, etc.).
function problems(ids) {
  const out = [];
  for (const id of ids || []) {
    const meta = loadMeta(id);
    if (!meta) continue;
    if (!meta.text && meta.error) out.push({ id, name: meta.name, error: meta.error });
  }
  return out;
}

// --- staging --------------------------------------------------------------
// The composer stages attachment ids before sending; the turn path picks them
// up. Staging lives here (not in the IPC handler) so the pinned agent:send
// handler body stays untouched. Staging is keyed by commandId so a queued
// message keeps its own files when another message is sent meanwhile.
const staged = new Map();   // commandId -> [attachmentId]

function stage(key, ids) {
  const k = String(key || 'default');
  const list = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  staged.set(k, list);
  return { ok: true, staged: list };
}

function takeStaged(key) {
  const k = String(key || 'default');
  const ids = staged.get(k) || [];
  staged.delete(k);
  return ids;
}

function stagedCount() { let n = 0; for (const v of staged.values()) n += v.length; return n; }

module.exports = { ingestFile, list, remove, clear, textFor, textBlock, imageData, loadMeta, publicMeta, problems, kindOf, rootDir, stage, takeStaged, stagedCount };
