'use strict';
// checkpoint.js — per-run file-change checkpoints with safe undo
// (the checkpoint.capture|rollback pattern, file-pre-image flavored).
// Before a run's write_file mutates a file, its pre-image is snapshotted once
// (first touch wins). finalize() records the hash of the state the run left
// each file in. undo() restores ONLY files still in exactly that state —
// anything the user (or a later run) touched afterwards is skipped, never
// clobbered. Shell commands are not tracked (no pre-image hook); the undo
// chip says "file edits" for that reason.
// Storage: ~/.muse-agent/checkpoints/<runId>/ — pre-images + manifest.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configDir } = require('./config');

const MAX_PREIMAGE_BYTES = 2 * 1024 * 1024;   // monsters are reported, not snapshotted

function checkpointsDir() { return path.join(configDir(), 'checkpoints'); }
function hashOf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function checkId(id) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error('bad checkpoint id');
  return String(id);
}

class Checkpoint {
  constructor(runId, sessionId) {
    this.runId = runId;
    this.sessionId = sessionId;
    this.dir = path.join(checkpointsDir(), checkId(runId));
    this.files = new Map();   // absPath -> { beforePath, existed, skipped, size }
    this.finalized = false;
  }

  // Called from write_file BEFORE the write mutates the file. First touch per
  // run wins: that pre-image is what undo must restore.
  async recordFile(absPath) {
    if (this.finalized || this.files.has(absPath)) return;
    let existed = true;
    let stat;
    try { stat = await fs.promises.stat(absPath); } catch { existed = false; }
    if (existed && stat.size > MAX_PREIMAGE_BYTES) {
      this.files.set(absPath, { skipped: true, existed: true, size: stat.size });
      return;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const beforePath = path.join(this.dir, `${this.files.size}-${path.basename(absPath)}`);
    if (existed) fs.copyFileSync(absPath, beforePath);
    this.files.set(absPath, { beforePath, existed, skipped: false, size: existed ? stat.size : 0 });
  }

  // Called at run end: pin the state the run left each file in, so undo can
  // tell "untouched since the run" apart from later edits.
  finalize() {
    if (this.finalized) return [];
    this.finalized = true;
    const entries = [];
    for (const [absPath, rec] of this.files) {
      let afterHash = null;
      try { afterHash = hashOf(fs.readFileSync(absPath)); } catch { /* gone since the write */ }
      const entry = { path: absPath, existed: rec.existed, skipped: !!rec.skipped, afterHash };
      if (!rec.skipped && rec.existed) {
        entry.beforeFile = path.basename(rec.beforePath);
        try { entry.beforeHash = hashOf(fs.readFileSync(rec.beforePath)); } catch { /* pre-image lost */ }
      }
      entries.push(entry);
    }
    if (entries.length) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'manifest.json'),
        JSON.stringify({ runId: this.runId, sessionId: this.sessionId, finalized: new Date().toISOString(), entries }));
    }
    return entries;
  }
}

function begin(runId, sessionId) {
  try { return new Checkpoint(runId, sessionId); }
  catch { return { recordFile: async () => {}, finalize: () => [] }; }   // never break a run
}

// Restore-safety rule: only files whose current content hash equals the
// after-hash (i.e. untouched since the run ended) are restored. Everything
// else is skipped and reported — undo never clobbers later work.
function undo(runId) {
  const dir = path.join(checkpointsDir(), checkId(runId));
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return { ok: false, error: 'no finalized checkpoint for this run' }; }
  const restored = [];
  const skipped = [];
  for (const e of manifest.entries || []) {
    let cur = null;
    try { cur = hashOf(fs.readFileSync(e.path)); } catch { /* currently missing */ }
    const untouched = e.afterHash === null ? cur === null : cur === e.afterHash;
    if (!untouched) { skipped.push({ path: e.path, reason: 'modified after the run — left as is' }); continue; }
    if (e.skipped) { skipped.push({ path: e.path, reason: 'too large to snapshot — left as is' }); continue; }
    if (!e.existed) {
      if (cur !== null) { fs.unlinkSync(e.path); restored.push({ path: e.path, action: 'deleted (created by the run)' }); }
      continue;
    }
    fs.copyFileSync(path.join(dir, e.beforeFile), e.path);
    restored.push({ path: e.path, action: 'restored' });
  }
  return { ok: true, restored, skipped };
}

module.exports = { begin, undo, checkpointsDir };
