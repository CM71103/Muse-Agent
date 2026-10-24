'use strict';
// models.js - fetch available models from an OpenAI-compatible endpoint.
// GET {base_url}/models with bearer auth; returns sorted id list.
// Credential rule: a saved provider key is only sent to the endpoint it was
// saved for. Callers pass the expected origin; on mismatch the call needs an
// explicitly supplied key (UI asks), never silently reuses the stored one.
// HTTPS required except loopback.

function originOf(urlStr) {
  try { return new URL(urlStr).origin.toLowerCase(); } catch { return null; }
}

function assertFetchableBase(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('base_url must start with http(s)://');
  const u = new URL(base);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol === 'http:' && !local) throw new Error('refusing to send credentials over plain HTTP (use https:// or a loopback URL)');
  return base;
}

async function fetchModels(baseUrl, apiKey, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  const expectedOrigin = opts.expectedOrigin || null;  // origin the saved key belongs to
  const keyIsExplicit = !!opts.keyIsExplicit;          // key came from this call's UI input
  const base = assertFetchableBase(baseUrl);
  let key = apiKey;
  if (key && !keyIsExplicit && expectedOrigin) {
    const here = originOf(base);
    if (here && here !== String(expectedOrigin).toLowerCase()) {
      throw new Error(`refusing to reuse the saved provider key for ${here}. Enter the key for this endpoint explicitly.`);
    }
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    const res = await fetch(`${base}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    const ids = (data.data || data.models || [])
      .map(m => m.id || m.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return ids;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchModels, assertFetchableBase, originOf };
