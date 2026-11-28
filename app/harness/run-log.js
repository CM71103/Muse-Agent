'use strict';
// run-log.js — what one run touched, kept long enough to inspect later.
// The harness tracks file tools here (read_file / write_file); the checkpoint
// pins the hash each written file was left in, so a detail pane can say
// whether the file still holds that state. Shell commands are not tracked —
// their edits have no pre-image hook (same limit as undo), so the pane says so
// instead of guessing.
// Facts land in the session's durable run receipts and in the `done` event,
// so a row survives a restart and is read from disk, never reconstructed.

const path = require('path');
const MAX_PATHS = 200;

function fresh() {
  return { read: [], written: [], truncated: false };
}

function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Paths inside the project folder read as project-relative; anything else
// keeps its absolute path so it is obvious that the run reached outside.
function displayPath(cwd, abs) {
  if (!cwd || !abs) return String(abs || '');
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

function recordFile(touched, name, cwd, resolvedPath) {
  if (!touched || !resolvedPath) return;
  const bucket = name === 'write_file' || name === 'edit_file' ? touched.written
    : name === 'read_file' || name === 'grep' || name === 'glob' ? touched.read
    : null;
  if (!bucket) return;
  const p = displayPath(cwd, resolvedPath);
  if (bucket.some(entry => (typeof entry === 'string' ? entry : entry.path) === p)) return;
  if (bucket.length >= MAX_PATHS) { touched.truncated = true; return; }
  bucket.push(name === 'write_file' || name === 'edit_file' ? { path: p, hash: null } : p);
}

// Merge the checkpoint's post-run hashes into the written list. The
// checkpoint sees every write_file path, so it also fills in a write the
// tracker missed.
function mergeCheckpoint(touched, entries, cwd) {
  if (!touched || !Array.isArray(entries)) return;
  for (const entry of entries) {
    const p = displayPath(cwd, entry.path);
    const existing = touched.written.find(item => item.path === p);
    if (existing) { existing.hash = entry.afterHash || null; existing.existed = !!entry.existed; continue; }
    if (touched.written.length >= MAX_PATHS) { touched.truncated = true; continue; }
    touched.written.push({ path: p, hash: entry.afterHash || null, existed: !!entry.existed });
  }
}

function snapshot(touched) {
  const t = touched || fresh();
  return {
    read: t.read.slice(),
    written: t.written.map(item => ({ path: item.path, hash: item.hash || null, existed: item.existed !== false })),
    truncated: !!t.truncated,
  };
}

// One run's facts, as written into the run_finished receipt and the done event.
function runRecord(fields) {
  const started = fields.startedAt ? Date.parse(fields.startedAt) : NaN;
  const ended = fields.endedAt ? Date.parse(fields.endedAt) : NaN;
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
  const usage = fields.usage && Object.keys(fields.usage).length ? fields.usage : null;
  return {
    runId: String(fields.runId || ''),
    request: clip(fields.request, 160),
    startedAt: fields.startedAt || null,
    endedAt: fields.endedAt || null,
    durationMs,
    outcome: fields.outcome || 'complete',
    ...(fields.error ? { error: clip(fields.error, 200) } : {}),
    turns: Number.isFinite(fields.turns) ? fields.turns : null,
    usage,
    tokensMissing: !!fields.tokensMissing,
    toolErrors: Number(fields.toolErrors) || 0,
    files: snapshot(fields.touched),
  };
}

// Replay receipts into runs, newest first. An accept with no finish is an
// interrupted run (crash or quit), not a run that quietly succeeded.
function runsFromReceipts(receipts) {
  const byId = new Map();
  for (const rec of receipts || []) {
    if (!rec || rec.kind !== 'receipt' || !rec.runId) continue;
    if (rec.status !== 'run_accepted' && rec.status !== 'run_finished') continue;
    const run = byId.get(rec.runId) || {
      runId: rec.runId, request: '', startedAt: rec.ts || null, endedAt: null, durationMs: null,
      outcome: 'interrupted', interrupted: true, usage: null, tokensMissing: false,
      toolErrors: 0, turns: null, files: { read: [], written: [], truncated: false },
    };
    if (rec.status === 'run_accepted') {
      run.startedAt = rec.ts || run.startedAt;
      if (rec.request) run.request = clipless(rec.request);
    } else {
      run.interrupted = false;
      run.outcome = rec.outcome || 'complete';
      run.endedAt = rec.ts || null;
      run.durationMs = rec.durationMs === undefined ? null : rec.durationMs;
      run.usage = rec.usage || null;
      run.tokensMissing = !!rec.tokensMissing;
      run.toolErrors = Number(rec.toolErrors) || 0;
      run.turns = Number.isFinite(rec.turns) ? rec.turns : null;
      if (rec.error) run.error = clipless(rec.error);
      if (rec.files) run.files = snapshotFromStored(rec.files);
      if (rec.request) run.request = clipless(rec.request);
    }
    byId.set(rec.runId, run);
  }
  return [...byId.values()].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

function clipless(text) { return clip(text, 160); }

// The request line for a row: plain text, or the text parts of a multimodal
// message. Images count as "[image]" so the line never reads empty.
function clipRequest(userText, content) {
  if (typeof userText === 'string' && userText.trim()) return clip(userText, 160);
  if (Array.isArray(content)) {
    const parts = content.map(part => (typeof part === 'string' ? part : part && part.type === 'image' ? '[image]' : part && typeof part.text === 'string' ? part.text : '')).filter(Boolean);
    if (parts.length) return clip(parts.join(' '), 160);
  }
  return '';
}

function snapshotFromStored(files) {
  return {
    read: Array.isArray(files.read) ? files.read.slice(0, MAX_PATHS) : [],
    written: Array.isArray(files.written)
      ? files.written.slice(0, MAX_PATHS).map(item => (typeof item === 'string'
        ? { path: item, hash: null, existed: true }
        : { path: item.path, hash: item.hash || null, existed: item.existed !== false }))
      : [],
    truncated: !!files.truncated,
  };
}

module.exports = { fresh, recordFile, mergeCheckpoint, snapshot, runRecord, runsFromReceipts, displayPath, clipRequest, MAX_PATHS };
