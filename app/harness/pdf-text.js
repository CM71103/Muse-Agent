'use strict';
// pdf-text.js — dependency-free text extraction from digital PDFs.
//
// Born-digital PDFs carry a text layer that is exact; OCR of the same page is
// not (digits and punctuation get mangled). So Muse tries this first and
// only falls back to OCR when there is no usable text layer.
//
// Scope: a pragmatic subset of the PDF spec, tuned for the files people
// actually attach (invoices, reports, exports) —
//   • objects found by scanning `N 0 obj … endobj` (works with xref tables,
//     xref streams and broken/missing xrefs alike)
//   • FlateDecode (zlib) and uncompressed content streams
//   • text operators: Tj, TJ, ', " with line/word spacing heuristics
//   • literal ( … ) and hex < … > strings, including PDF escapes
//   • WinAnsi/ASCII text; identity-encoded hex strings are decoded as
//     UTF-16BE when they look like it
//   • ToUnicode CMaps (bfchar/bfrange) are parsed and applied per content
//     stream, which is what subset/CID fonts need
//
// A quality gate rejects garbage output so the caller can fall back to OCR.

const fs = require('fs');
const zlib = require('zlib');

const MAX_STREAM_BYTES = 24 * 1024 * 1024;

function latin1(buf) { return buf.toString('latin1'); }

function inflate(buf) {
  // PDF Flate streams are zlib-wrapped; some writers emit raw deflate.
  const attempts = [
    () => zlib.inflateSync(buf),
    () => zlib.inflateRawSync(buf),
    () => zlib.unzipSync(buf),
  ];
  for (const fn of attempts) {
    try {
      const out = fn();
      if (out && out.length) return out;
    } catch { /* try the next variant */ }
  }
  return null;
}

// --- PDF string primitives -------------------------------------------------

function decodeLiteralString(str) {
  // str excludes the surrounding parentheses.
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '\\') { out.push(ch.charCodeAt(0)); continue; }
    const next = str[++i];
    switch (next) {
      case 'n': out.push(10); break;
      case 'r': out.push(13); break;
      case 't': out.push(9); break;
      case 'b': out.push(8); break;
      case 'f': out.push(12); break;
      case '(': out.push(40); break;
      case ')': out.push(41); break;
      case '\\': out.push(92); break;
      case '\n': break;
      case '\r': if (str[i + 1] === '\n') i++; break;
      default:
        if (next >= '0' && next <= '7') {
          let oct = next;
          while (oct.length < 3 && str[i + 1] >= '0' && str[i + 1] <= '7') oct += str[++i];
          out.push(parseInt(oct, 8));
        } else if (next) { out.push(next.charCodeAt(0)); }
    }
  }
  return Buffer.from(out);
}

function decodeHexString(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 ? clean + '0' : clean;
  return Buffer.from(padded, 'hex');
}

// A decoded byte string → text. Identity/UTF-16 detection for hex strings.
function bytesToText(buf) {
  if (!buf.length) return '';
  // UTF-16BE heuristic: alternating zero bytes.
  if (buf.length >= 4 && buf.length % 2 === 0) {
    let zeros = 0;
    for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0) zeros++;
    if (zeros / (buf.length / 2) > 0.6) return buf.swap16().toString('utf16le');
  }
  return buf.toString('latin1');
}

// --- ToUnicode CMaps -------------------------------------------------------

function parseCMap(text) {
  const map = new Map();
  const toUni = text;
  // bfchar: <src> <dst>
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfchar.exec(toUni))) {
    const body = m[1];
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let entry;
    while ((entry = re.exec(body))) {
      const src = parseInt(entry[1], 16);
      const dstHex = entry[2];
      let dst = '';
      for (let i = 0; i + 3 < dstHex.length + 1; i += 4) {
        const code = parseInt(dstHex.substr(i, 4), 16);
        if (!Number.isNaN(code)) dst += String.fromCharCode(code);
      }
      if (dst) map.set(src, dst);
    }
  }
  // bfrange: <lo> <hi> <dstStart>  |  <lo> <hi> [ <d1> <d2> … ]
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(toUni))) {
    const body = m[1];
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[\s\S]*?\])/g;
    let entry;
    while ((entry = re.exec(body))) {
      const lo = parseInt(entry[1], 16);
      const hi = parseInt(entry[2], 16);
      const dest = entry[3];
      if (dest.startsWith('[')) {
        const items = dest.match(/<([0-9a-fA-F]*)>/g) || [];
        items.forEach((it, idx) => {
          const hex = it.slice(1, -1);
          let s = '';
          for (let i = 0; i + 3 < hex.length + 1; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
          if (s) map.set(lo + idx, s);
        });
      } else {
        const hex = dest.slice(1, -1);
        let start = '';
        for (let i = 0; i + 3 < hex.length + 1; i += 4) start += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
        if (!start) continue;
        const base = start.codePointAt(0);
        for (let code = lo; code <= hi && code - lo < 65536; code++) {
          map.set(code, String.fromCodePoint(base + (code - lo)));
        }
      }
    }
  }
  return map;
}

// --- object scanning --------------------------------------------------------

function findObjects(buf) {
  const raw = latin1(buf);
  const objects = new Map();     // number → { dict, streamStart, streamEnd }
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endIdx = raw.indexOf('endobj', bodyStart);
    const bodyEnd = endIdx === -1 ? raw.length : endIdx;
    const body = raw.slice(bodyStart, bodyEnd);
    const sIdx = body.indexOf('stream');
    if (sIdx === -1) { objects.set(num, { dict: body, stream: null }); continue; }
    const dict = body.slice(0, sIdx);
    let dataStart = bodyStart + sIdx + 'stream'.length;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;
    const sEndRel = body.indexOf('endstream', sIdx);
    const dataEnd = sEndRel === -1 ? bodyEnd : bodyStart + sEndRel;
    objects.set(num, { dict, streamStart: dataStart, streamEnd: dataEnd, stream: true });
  }
  return objects;
}

function streamBytes(buf, obj) {
  if (!obj || obj.stream == null) return null;
  let data = buf.slice(obj.streamStart, obj.streamEnd);
  if (data.length > MAX_STREAM_BYTES) data = data.slice(0, MAX_STREAM_BYTES);
  if (/\/FlateDecode/.test(obj.dict)) {
    const inflated = inflate(data);
    if (inflated) return inflated;
    return null;
  }
  if (/\/Filter\s*\/(?!Flate)/.test(obj.dict)) {
    // Unsupported filter (LZW, CCITT, …) — treat as binary image data.
    return null;
  }
  return data;
}

// --- content stream text extraction ----------------------------------------

function splitStringsAndOps(chunk) {
  // Yields tokens: {type:'str', value:Buffer} | {type:'name', value} | {type:'op', value} | {type:'num', value}
  const out = [];
  let i = 0;
  const n = chunk.length;
  while (i < n) {
    const ch = chunk[i];
    if (ch === '(') {
      let depth = 1, j = i + 1, body = '';
      while (j < n && depth > 0) {
        const c = chunk[j];
        if (c === '\\') { body += c + (chunk[j + 1] || ''); j += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
        body += c; j++;
      }
      out.push({ type: 'str', value: decodeLiteralString(body) });
      i = j + 1;
      continue;
    }
    if (ch === '<' && chunk[i + 1] !== '<') {
      const end = chunk.indexOf('>', i);
      if (end === -1) { i++; continue; }
      out.push({ type: 'str', value: decodeHexString(chunk.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9#+.\-]/.test(chunk[j])) j++;
      out.push({ type: 'name', value: chunk.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '<' && chunk[i + 1] === '<') {
      const end = chunk.indexOf('>>', i);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (/[0-9.+-]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.+-]/.test(chunk[j])) j++;
      const num = Number(chunk.slice(i, j));
      if (Number.isFinite(num)) out.push({ type: 'num', value: num });
      i = j;
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9*'"]/.test(chunk[j])) j++;
      out.push({ type: 'op', value: chunk.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

// Does this blob look like text we can trust?
function looksLikeText(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 12) return false;
  let printable = 0, letters = 0, replacement = 0;
  for (const ch of t) {
    const code = ch.codePointAt(0);
    if (code === 0xFFFD) { replacement++; continue; }
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 0x7f)) printable++;
    if (/[A-Za-zÀ-ɏ]/.test(ch)) letters++;
  }
  if (replacement > 0) return false;
  const ratio = printable / t.length;
  const letterRatio = letters / t.length;
  return ratio > 0.92 && letterRatio > 0.25;
}

// Extract text from a PDF file → { ok, text, pages, usable }
function extract(file, opts = {}) {
  const maxChars = opts.maxChars || 400000;
  let buf;
  try { buf = fs.readFileSync(file); } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  if (!buf.length) return { ok: false, error: 'empty file' };
  if (latin1(buf.slice(0, 5)) !== '%PDF-') return { ok: false, error: 'not a PDF file' };

  const objects = findObjects(buf);
  if (!objects.size) return { ok: false, error: 'no PDF objects found' };

  // ToUnicode CMaps, by object number.
  const cmaps = new Map();
  for (const [num, obj] of objects) {
    if (!/ToUnicode/.test(obj.dict)) continue;
    const data = streamBytes(buf, obj);
    if (!data) continue;
    const map = parseCMap(latin1(data));
    if (map.size) cmaps.set(num, map);
  }

  // Font resources: /Font << /F1 12 0 R >> and each font's /ToUnicode ref.
  const fontToUnicode = new Map();     // font object number → cmap
  for (const [, obj] of objects) {
    const m = obj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (m && cmaps.has(Number(m[1]))) fontToUnicode.set(Number(m[1]), cmaps.get(Number(m[1])));
  }

  // Content streams: objects whose dictionary is a content stream (no /Type
  // /Page) plus every page's /Contents reference. Using both keeps the
  // ordering roughly document order for the common case.
  const contentRefs = [];
  for (const [num, obj] of objects) {
    if (obj.stream == null) continue;
    if (/\/Type\s*\/Page\b/.test(obj.dict)) {
      const cm = obj.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
      if (cm) contentRefs.push(Number(cm[1]));
    } else if (!/\/Type\s*\/(Font|XObject|Image|Metadata|Catalog|Pages)\b/.test(obj.dict) && !/\/Subtype\s*\/(Image|Font|Type1C|TrueType|Form|Type0|CIDFontType0|CIDFontType2)\b/.test(obj.dict)) {
      contentRefs.push(num);
    }
  }

  const pieces = [];
  let fontStack = [];        // current font's cmap
  let lastWasText = false;

  for (const ref of contentRefs) {
    const obj = objects.get(ref);
    if (!obj) continue;
    const data = streamBytes(buf, obj);
    if (!data) continue;
    const chunk = latin1(data);
    if (!/(Tj|TJ|Td|TD|Tm|BT)/.test(chunk)) continue;
    const tokens = splitStringsAndOps(chunk);
    let line = [];
    const flush = () => { if (line.length) { pieces.push(line.join('')); line = []; } };

    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      if (tok.type === 'op') {
        const op = tok.value;
        if (op === 'Tf') {
          // /F1 12 Tf → the font resource name is the nearest name token
          // before the operator (the size number sits between them).
          let nameTok = null;
          for (let k = t - 1; k >= 0 && k >= t - 4; k--) {
            if (tokens[k].type === 'name') { nameTok = tokens[k]; break; }
            if (tokens[k].type === 'op') break;
          }
          const cmap = nameTok ? lookupFontCmap(objects, buf, fontToUnicode, nameTok.value) : null;
          fontStack = cmap ? [cmap] : [];
        } else if (op === 'Tj' || op === "'" || op === '"') {
          const s = tokens[t - 1];
          if (s && s.type === 'str') { line.push(decodeWith(s.value, fontStack)); lastWasText = true; }
          if (op !== 'Tj') flush();
        } else if (op === 'TJ') {
          // array: [ (a) -120 (b) ] TJ
          let j = t - 1;
          const items = [];
          while (j >= 0 && tokens[j].type !== 'op') { items.unshift(tokens[j]); j--; }
          let buf2 = '';
          for (const it of items) {
            if (it.type === 'str') buf2 += decodeWith(it.value, fontStack);
            else if (it.type === 'num' && it.value < -120) buf2 += ' ';
          }
          if (buf2) { line.push(buf2); lastWasText = true; }
        } else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'Tm' || op === 'ET') {
          if (lastWasText) { flush(); lastWasText = false; }
        }
        continue;
      }
    }
    flush();
  }

  let text = pieces.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n[… truncated …]';
  const pages = pieces.length ? countPages(objects, buf) : 0;
  return { ok: true, text, pages, usable: looksLikeText(text) };
}

function decodeWith(buf, fontStack) {
  if (!fontStack.length) return bytesToText(buf);
  let out = '';
  // 1-byte codes for simple fonts, 2-byte for CID fonts
  const wide = fontStack[0].wide !== false;
  if (!wide) {
    for (const byte of buf) out += fontStack[0].map.get(byte) || String.fromCharCode(byte);
    return out;
  }
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = (buf[i] << 8) | buf[i + 1];
    out += fontStack[0].map.get(code) || '';
  }
  return out;
}

// Resolve /F1 → font object → its ToUnicode cmap, via the nearest page's
// /Resources /Font dictionary.
function lookupFontCmap(objects, buf, fontToUnicode, resourceName) {
  if (objects.__fontCache === undefined) objects.__fontCache = new Map();
  const cacheKey = resourceName;
  const pageFontMaps = buildFontResourceMap(objects, buf);
  for (const map of pageFontMaps) {
    if (map.has(resourceName)) {
      const fontNum = map.get(resourceName);
      const cmap = fontToUnicode.get(fontNum);
      if (cmap) return [cmap];
    }
  }
  return null;
}

function buildFontResourceMap(objects, buf) {
  const maps = [];
  for (const [, obj] of objects) {
    if (!/\/Type\s*\/Page\b/.test(obj.dict)) continue;
    const fd = obj.dict.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (!fd) continue;
    const map = new Map();
    const re = /\/([A-Za-z0-9#._-]+)\s+(\d+)\s+\d+\s+R/g;
    let m;
    while ((m = re.exec(fd[1]))) map.set(m[1], Number(m[2]));
    if (map.size) maps.push(map);
  }
  return maps;
}

function countPages(objects, buf) {
  let count = 0;
  for (const [, obj] of objects) if (/\/Type\s*\/Page\b/.test(obj.dict)) count++;
  return count || 1;
}

module.exports = { extract, looksLikeText, parseCMap, decodeLiteralString, decodeHexString };
