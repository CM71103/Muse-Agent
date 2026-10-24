'use strict';
// llm.js - OpenAI-compatible chat client. Works with DeepSeek, OpenAI, OpenRouter,
// vLLM, LM Studio, Ollama (they all expose /v1/chat/completions).
// One dependency: Node 18+ global fetch. No SDK.

const { apiKey } = require('./config');

class LlmClient {
  constructor(cfg) {
    this.fullCfg = cfg;      // whole config, apiKey() expects it
    this.cfg = cfg.llm;
    this.base = String(this.cfg.base_url || '').replace(/\/+$/, '');
  }

  get key() { return apiKey(this.fullCfg); }

  // messages: [{role:'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id?}]
  // tools: OpenAI function-tool schema array
  // opts.signal: optional AbortSignal — cancellation propagates to the wire.
  async chat(messages, tools, opts = {}) {
    if (!this.key && !/localhost|127\.0\.0\.1/.test(this.base)) {
      throw new Error('No API key. Set MUSE_LLM_API_KEY or llm.api_key in config.toml');
    }
    const body = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 0.3,
      max_tokens: this.cfg.max_tokens ?? 8192,
    };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    // retry transient failures (5xx / network / stalls). Endpoint observed flaky.
    // LENGTH_NO_OUTPUT gets one special retry with doubled max_tokens — that's
    // the typical fix when a model burns its budget on hidden reasoning and
    // returns nothing (common with reasoning-tuned chat models on big prompts).
    let lastErr = null;
    const maxAttempts = this.cfg.retry_attempts || 5;
    let doubledOnce = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted by user'), { name: 'AbortError' });
      try {
        return await this._post(body, opts.signal);
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted by user'), { name: 'AbortError' });
        lastErr = e;
        if (e.code === 'LENGTH_NO_OUTPUT' && !doubledOnce) {
          doubledOnce = true;
          const hard = Number(this.cfg.max_tokens) || 8192;
          if (hard < 65536) {
            body.max_tokens = Math.min(hard * 2, 65536);
            continue;   // immediate retry at doubled budget (not counted as network attempt)
          }
        }
        const retryable = /HTTP 5\d\d/.test(e.message) || /network|fetch failed|timeout|aborted|socket/i.test(e.message);
        if (!retryable) throw e;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (lastErr && lastErr.code === 'LENGTH_NO_OUTPUT') {
      throw new Error(`LLM hit max_tokens (${this.cfg.max_tokens} and doubled ${body.max_tokens}) with no output — ` +
        `reasoning model likely consumed the whole budget. Raise llm.max_tokens or use a non-reasoning model (model: ${this.cfg.model})`);
    }
    throw lastErr;
  }

  async _post(body, outerSignal) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), (this.cfg.timeout_s || 120) * 1000);
    // caller cancellation also aborts the wire
    if (outerSignal) {
      if (outerSignal.aborted) ac.abort();
      else outerSignal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    try {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      if (!choice) throw new Error('LLM returned no choices');
      const msg = choice.message || {};
      const hasContent = typeof msg.content === 'string' && msg.content.trim().length > 0;
      const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (choice.finish_reason === 'length' && !hasContent && !hasTools) {
        const err = new Error('LENGTH_NO_OUTPUT');
        err.code = 'LENGTH_NO_OUTPUT';
        err.detail = `max_tokens=${body.max_tokens} model=${this.cfg.model}`;
        throw err;
      }
      if (!hasContent && !hasTools) {
        const err = new Error(`LLM returned empty response (finish_reason: ${choice.finish_reason})`);
        err.code = 'EMPTY_RESPONSE';
        throw err;
      }
      return {
        message: choice.message,          // {role:'assistant', content, tool_calls?}
        finish_reason: choice.finish_reason,
        usage: data.usage || null,
      };
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`LLM timeout after ${this.cfg.timeout_s || 120}s`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
}

module.exports = { LlmClient };
