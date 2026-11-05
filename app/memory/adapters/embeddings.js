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
// 429s from embedding providers are usually per-minute quota, not a blip: a
// 0.5/1/2s backoff cannot outlast one. Retry with Retry-After honored, and
// when the header is absent back off long enough to cross a minute boundary.
const MAX_RETRIES = 3;
// Longest wait worth absorbing inside a turn. A provider saying "retry in 90s"
// gets an immediate throw instead of a frozen composer.
const MAX_SHORT_WAIT_S = 5;

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
  let seg = s.slice(s.lastIndexOf('/') + 1);
  // Drop an OpenRouter-style routing variant suffix (`:free`, `:beta`, `:extended`).
  // These select a routing tier for the SAME weights, and relays commonly drop
  // them when echoing the model back — observed: asking for
  // nvidia/nemotron-3-embed-1b:free returns private/openrouter/nvidia/nemotron-3-embed-1b.
  // Keeping the suffix makes the pin reject every vector from a provider that
  // omits it, which is a false positive; a genuine model swap still differs in
  // the model segment ("text-embedding-3-large" vs "-3-small").
  const variant = seg.indexOf(':');
  if (variant > 0) seg = seg.slice(0, variant);
  return seg;
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

// Read a provider error body for the message we throw. Bounded, and never
// throws: the body is diagnostic text, not a contract.
// Without this, "HTTP 503" hides that the relay actually said
// model_not_found — which is a config error, not a transient one.
async function errorBody(res) {
  try {
    const t = await res.text();
    return t ? t.replace(/\s+/g, ' ').slice(0, 200) : '';
  } catch { return ''; }
}

// Permanent = retrying cannot help. Relays signal "this model isn't routable"
// as 503 model_not_found or 404/400/422, sometimes as 429, so match on the
// body too, not just the status.
function isPermanent(status, body) {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) return true;
  if (!body) return false;
  const b = body.toLowerCase();
  return b.includes('model_not_found') || b.includes('does not exist')
    || b.includes('invalid model') || b.includes('no available channel')
    || b.includes('invalid_api_key') || b.includes('incorrect api key');
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

    if (!res.ok) {
      const body = await errorBody(res);
      const detail = body ? ` — ${body}` : '';
      // A wrong embed_model/auth fails identically every turn; retrying it 4x
      // just stalls the composer and reports a misleading "after N attempts".
      if (isPermanent(res.status, body)) {
        const e = new Error(`embeddings HTTP ${res.status} (permanent)${detail}`);
        e.permanent = true;
        throw e;
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after') || 0);
        // A quota 429 with Retry-After=30 is a "come back later", not a stall
        // this turn should absorb. Fail immediately and leave rows pending; the
        // next turn retries. Only short waits are worth sitting through.
        if (ra > MAX_SHORT_WAIT_S) {
          const e = new Error(`embeddings HTTP ${res.status}; retry after ${ra}s (rows left pending)${detail}`);
          e.cooldown = ra * 1000;
          throw e;
        }
        const wait = ra > 0 ? ra * 1000 : backoff(attempt);
        attempt++;
        if (attempt <= MAX_RETRIES) { await sleep(wait); continue; }
        const e = new Error(`embeddings HTTP ${res.status} after ${attempt} attempts${detail}`);
        e.rateLimited = res.status === 429;
        throw e;
      }
      throw new Error(`embeddings HTTP ${res.status}${detail}`);
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
  // 2s, 4s, 8s, 16s — deliberately longer than the old 500ms start. A provider
  // answering 429 with no Retry-After is usually metering a rolling window;
  // sub-second retries just burn the remaining quota.
  return 2000 * Math.pow(2, attempt - 1);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { embed, checkRowPin, canonicalModel, cosine, norm, makePin, TIMEOUT_MS, MAX_RETRIES };
