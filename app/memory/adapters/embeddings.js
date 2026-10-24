'use strict';
// memory/adapters/embeddings.js — OpenAI-compatible /v1/embeddings client.
// Spec §3 Depth-1 discipline: 30s timeout, ≤3 retries on 429/5xx honoring
// Retry-After, per-row pin check on insert AND query:
//   model + dims + generation + finite + nonzero norm.
//
// The pin check is a record-level gate: any row that fails must not be
// inserted or used for retrieval, even in a batch whose other rows pass.
// Providers silently swap models behind the same endpoint name — this is the
// only defense besides a human checking a manifest.

const crypto = require('crypto');

const TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// Provider namespace normalization for the model pin. Providers legitimately
// echo a canonical/prefixed model id behind the same endpoint — e.g. config
// "qwen3-embedding-0.6b" comes back as "@cf/qwen/qwen3-embedding-0.6b" or
// "openai/text-embedding-3-small". The pin's job (do-not #8) is to catch a
// provider SWAPPING MODELS behind the same name, not to reject the same model
// wearing its host's namespace. So identity = final path segment, exact case.
// A real swap ("text-embedding-3-large" behind a small config) still mismatches.
function canonicalModel(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// Per-row pin check. Returns {ok, reason} — reason is a short stable token.
function checkRowPin(row, expectModel, expectDims, expectGeneration) {
  if (!row || !Array.isArray(row.embedding)) return { ok: false, reason: 'no_embedding' };
  const v = row.embedding;
  if (v.length === 0) return { ok: false, reason: 'empty_vector' };
  if (expectDims != null && v.length !== expectDims) return { ok: false, reason: 'dim_mismatch' };
  if (expectModel && canonicalModel(row.model_pin) !== canonicalModel(expectModel)) {
    return { ok: false, reason: 'model_mismatch' };
  }
  if (expectGeneration != null && row.generation !== expectGeneration) {
    return { ok: false, reason: 'generation_mismatch' };
  }
  for (const x of v) {
    if (!Number.isFinite(x)) return { ok: false, reason: 'non_finite' };
  }
  const n = norm(v);
  if (!(n > 0) || !Number.isFinite(n)) return { ok: false, reason: 'zero_norm' };
  return { ok: true };
}

// Fresh pin for a just-embedded row.
function makePin(model, dims) {
  return { model: model, dims: dims };
}

// ---- provider client ----

// cfg: { baseUrl, apiKey, model, dims }
// Returns { vectors: [{id, vector, model, dims}], model, dims }
async function embed(cfg, texts) {
  if (!texts || texts.length === 0) return { vectors: [], model: cfg.model, dims: null };

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/embeddings';
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          input: texts,
          encoding_format: 'float',
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      attempt++;
      if (attempt <= MAX_RETRIES) { await sleep(backoff(attempt)); continue; }
      throw new Error(`embeddings request failed after ${attempt} attempts: ${e.message}`);
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after') || 0);
      const wait = ra > 0 ? Math.min(ra, 60) * 1000 : backoff(attempt);
      attempt++;
      if (attempt <= MAX_RETRIES) { await sleep(wait); continue; }
      throw new Error(`embeddings HTTP ${res.status} after ${attempt} attempts`);
    }

    if (!res.ok) {
      throw new Error(`embeddings HTTP ${res.status}`);
    }

    const data = await res.json();
    const items = Array.isArray(data.data) ? data.data : null;
    if (!items || items.length !== texts.length) {
      throw new Error(`embeddings response shape: expected ${texts.length} rows, got ${items ? items.length : 'none'}`);
    }
    // OpenAI returns rows possibly out of order when input is array; sort by index when present
    if (items.some(x => typeof x.index === 'number')) {
      items.sort((a, b) => a.index - b.index);
    }
    const model = data.model || cfg.model;
    const vectors = items.map(x => ({
      id: x.index != null ? texts[x.index] : null,
      vector: x.embedding,
      model,
    }));
    const dims = vectors[0] ? vectors[0].vector.length : null;
    // usage passthrough for daily token accounting (spec §3 caps); estimate
    // fallback lives in the caller when the provider omits it.
    return { vectors, model, dims, usage: data.usage || null };
  }
}

function backoff(attempt) {
  return 500 * Math.pow(2, attempt - 1);   // 500ms, 1s, 2s
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { embed, checkRowPin, canonicalModel, cosine, norm, makePin, TIMEOUT_MS, MAX_RETRIES };
