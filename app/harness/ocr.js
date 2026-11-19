'use strict';
// ocr.js — local OCR and PDF text extraction for attachments.
//
// Engines, in order of preference:
//   1. Windows.Media.Ocr + Windows.Data.Pdf (built into Windows, offline,
//      no install, no network) — app/harness/windows-ocr.ps1, invoked via
//      PowerShell. The script is copied out of the asar to a temp file
//      because PowerShell cannot execute a file inside app.asar.
//   2. A digital PDF text layer is extracted first (pdf-text.js) because OCR
//      of a born-digital PDF loses exact numbers; OCR is the fallback for
//      scans and images.
//
// Everything runs locally. Nothing is uploaded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const pdfText = require('./pdf-text');

const PS = 'powershell.exe';
const SCRIPT = 'windows-ocr.ps1';
const TIMEOUT_MS = 120000;
const MAX_OUTPUT = 8 * 1024 * 1024;

let scriptCache = null;   // resolved temp copy of the .ps1

// The .ps1 lives in app/harness/ — readable inside app.asar, but PowerShell
// cannot run a script from inside the archive, so it is materialised in a
// temp dir once per process.
function scriptPath() {
  if (scriptCache) return scriptCache;
  const source = path.join(__dirname, SCRIPT);
  let body;
  try { body = fs.readFileSync(source, 'utf8'); }
  catch { return null; }
  const dir = path.join(os.tmpdir(), 'muse-ocr');
  const target = path.join(dir, SCRIPT);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Only rewrite when the content changed (keeps the temp copy stable).
    let same = false;
    try { same = fs.readFileSync(target, 'utf8') === body; } catch { }
    if (!same) fs.writeFileSync(target, body, 'utf8');
    scriptCache = target;
    return target;
  } catch { return null; }
}

function runScript(args, timeoutMs = TIMEOUT_MS) {
  const script = scriptPath();
  if (!script) return Promise.resolve({ ok: false, error: 'ocr helper missing' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { resolve({ ok: false, error: String(err && err.message || err) }); return; }
    let out = '', err = '';
    child.stdout.on('data', d => { if (out.length < MAX_OUTPUT) out += d; });
    child.stderr.on('data', d => { if (err.length < MAX_OUTPUT) err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e && e.message || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const raw = String(out || '').trim();
      if (!raw) {
        resolve({ ok: false, error: 'ocr helper produced no output' + (err ? `: ${err.trim().split('\n')[0]}` : '') });
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(raw.split('\n').filter(l => l.trim().startsWith('{')).pop() || raw); }
      catch { resolve({ ok: false, error: 'ocr helper returned unreadable output' }); return; }
      if (!parsed || parsed.ok !== true) {
        resolve({ ok: false, error: String(parsed && parsed.error || 'ocr failed') });
        return;
      }
      resolve(parsed);
    });
  });
}

// OCR a single image file → { ok, engine, text }
async function ocrImage(file) {
  const res = await runScript(['-Image', file]);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, engine: res.engine, text: String(res.text || '').trim(), pages: res.pages || [] };
}

// OCR every page of a PDF (rendered by Windows.Data.Pdf) → { ok, engine, text, pageCount }
async function ocrPdf(file, opts = {}) {
  const args = ['-Pdf', file, '-MaxPages', String(Math.min(Math.max(1, opts.maxPages || 40), 200))];
  const res = await runScript(args, opts.timeoutMs || TIMEOUT_MS * 2);
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    engine: res.engine,
    pageCount: Number(res.pageCount || (res.pages || []).length || 0),
    pages: res.pages || [],
    text: String(res.text || '').trim(),
  };
}

// Is any OCR engine reachable? Cheap probe: OCR helper script present.
function ocrAvailable() {
  return !!scriptPath();
}

// Extract text from a PDF, preferring the digital text layer and falling back
// to OCR when the PDF is a scan (or its text layer comes out as garbage).
// → { ok, text, method: 'text-layer'|'ocr'|'none', pages, engine? }
async function extractPdfText(file, opts = {}) {
  const digital = pdfText.extract(file, { maxChars: opts.maxChars || 400000 });
  if (digital.ok && digital.text && digital.usable) {
    return { ok: true, text: digital.text, method: 'text-layer', pages: digital.pages };
  }
  const ocr = await ocrPdf(file, opts);
  if (ocr.ok && ocr.text) {
    return { ok: true, text: ocr.text, method: 'ocr', pages: ocr.pageCount, engine: ocr.engine };
  }
  if (digital.ok && digital.text) {
    // Text layer existed but looked unusable; OCR failed too — keep the raw
    // text rather than losing the document entirely.
    return { ok: true, text: digital.text, method: 'text-layer-weak', pages: digital.pages };
  }
  return { ok: false, error: ocr.error || digital.error || 'no text could be extracted' };
}

module.exports = { ocrImage, ocrPdf, extractPdfText, ocrAvailable, scriptPath };
