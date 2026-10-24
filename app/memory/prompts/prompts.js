'use strict';
// memory/prompts/prompts.js — frozen + hashed prompt registry (spec §2).
// Changing any prompt text starts a new evidence version: the hash is recorded
// per extraction run and per policy version, and a hash mismatch against the
// recorded frozen hash refuses to serve rather than silently switching semantics.
// Prompts are data of the memory layer; content extracted from events is never
// treated as instructions (do-not #5).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROMPTS_DIR = __dirname;

// Frozen baseline hashes. If you legitimately change a prompt file, you MUST
// update the recorded hash here AND bump the evidence version seed in layer.js
// (EVIDENCE_VERSION_SEED) — a new hash starts a new evidence lineage.
// These are the SHA-256 digests of the exact shipped prompt bytes.
const FROZEN = {
  'extract-prompt.md': 'sha256:ae2d9e454022ddb00dbea478287e2484bf101fb73a33be371c16d46fc4af0e3e',
};

function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Load a prompt by name, verify its bytes against the frozen hash. A mismatch
// is a hard error — the process must not serve extraction with drifted prompts
// (evidence versioning would silently fork).
function load(name) {
  const p = path.join(PROMPTS_DIR, name);
  const text = fs.readFileSync(p, 'utf8');
  const hash = sha256(text);
  const expect = FROZEN[name];
  if (expect && expect !== 'PROMPT_HASH_PLACEHOLDER' && expect !== hash) {
    throw new Error(`memory prompt ${name} changed after freeze (hash ${hash} != ${expect}); bump evidence version and update FROZEN`);
  }
  return { text, hash };
}

// All prompt hashes for recording into policy/evidence metadata.
function manifest() {
  const out = {};
  for (const name of Object.keys(FROZEN)) {
    try { out[name] = load(name).hash; } catch { out[name] = null; }
  }
  return out;
}

module.exports = { load, sha256, manifest, FROZEN };
