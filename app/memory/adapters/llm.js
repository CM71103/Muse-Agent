'use strict';
// memory/adapters/llm.js — OpenAI-compatible chat client for EXTRACTION only.
// Same Depth-1 discipline as embeddings.js: 30 s timeout, ≤3 retries on
// 429/5xx honoring Retry-After. Every call is token-cap aware: the caller
// (core/extract.js) checks and reserves before invoking; usage returned here
// is recorded against the daily cap by the caller.
//
// This adapter is for the memory layer's own LLM use (extraction). The host's
// chat path (app/harness/llm.js) stays untouched — different concerns.

const TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

// cfg: { baseUrl, apiKey, model, temperature?, max_tokens? }
// Returns { text, model, usage: {prompt_tokens, completion_tokens, total_tokens} }
async function chat(cfg, { system, user, temperature, max_tokens }) {
  const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system || '' },
      { role: 'user', content: user || '' },
    ],
    temperature: temperature != null ? temperature : 0.1,
    max_tokens: max_tokens != null ? max_tokens : 2048,
  };
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
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      attempt++;
      if (attempt <= MAX_RETRIES) { await sleep(backoff(attempt)); continue; }
      throw new Error(`llm request failed after ${attempt} attempts: ${e.message}`);
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after') || 0);
      const wait = ra > 0 ? Math.min(ra, 60) * 1000 : backoff(attempt);
      attempt++;
      if (attempt <= MAX_RETRIES) { await sleep(wait); continue; }
      throw new Error(`llm HTTP ${res.status} after ${attempt} attempts`);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`llm HTTP ${res.status}: ${t.slice(0, 200)}`);
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error('llm returned no choices');
    const usage = data.usage || null;
    return { text: choice.message && choice.message.content || '', model: data.model || cfg.model, usage };
  }
}

function backoff(attempt) { return 500 * Math.pow(2, attempt - 1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { chat, TIMEOUT_MS, MAX_RETRIES };
