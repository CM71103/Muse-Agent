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
    // Reasoning models can spend their entire completion budget before emitting
    // visible text. Escalate the budget gradually, with a hard provider-safe cap.
    let lastErr = null;
    const maxAttempts = this.cfg.retry_attempts || 5;
    let lengthBudgetRetries = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted by user'), { name: 'AbortError' });
      try {
        return await this._post(body, opts.signal, opts);
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted by user'), { name: 'AbortError' });
        lastErr = e;
        if (e.code === 'STREAM_UNSUPPORTED') {
          opts.onStreamReset?.();
          return await this._post(body, opts.signal, { ...opts, onDelta: null, onStreamReset: null });
        }
        if (e.code === 'LENGTH_NO_OUTPUT') {
          const nextBudget = Math.min(body.max_tokens * 2, 65536);
          if (nextBudget > body.max_tokens && lengthBudgetRetries < 3 && attempt + 1 < maxAttempts) {
            lengthBudgetRetries++;
            body.max_tokens = nextBudget;
            opts.onStreamReset?.();
            continue;
          }
          throw new Error(`The model returned no text after using its ${body.max_tokens}-token response limit. ` +
            `Try a non-reasoning model or increase llm.max_tokens if your provider supports it (model: ${this.cfg.model}).`);
        }
        const retryable = /HTTP 5\d\d/.test(e.message) || /network|fetch failed|timeout|aborted|socket/i.test(e.message);
        if (!retryable) throw e;
        opts.onStreamReset?.();
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async _post(body, outerSignal, opts = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), (this.cfg.timeout_s || 120) * 1000);
    // caller cancellation also aborts the wire
    if (outerSignal) {
      if (outerSignal.aborted) ac.abort();
      else outerSignal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    try {
      const requestBody = opts.onDelta ? { ...body, stream: true } : body;
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
        if (requestBody.stream && [400, 422].includes(res.status) && /stream(?:ing)?/i.test(text)) err.code = 'STREAM_UNSUPPORTED';
        throw err;
      }
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      const data = opts.onDelta && contentType.includes('text/event-stream')
        ? await this._readStream(res, opts.onDelta)
        : await res.json();
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

  async _readStream(res, onDelta) {
    if (!res.body || typeof res.body.getReader !== 'function') throw new Error('LLM streaming response has no readable body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const message = { role: 'assistant', content: '', tool_calls: [] };
    const calls = new Map();
    let finishReason = null;
    let usage = null;
    let buffer = '';
    let dataLines = [];
    const consume = raw => {
      if (!raw || raw === '[DONE]') return raw === '[DONE]';
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error('LLM returned invalid streaming data'); }
      if (data.error) throw new Error(data.error.message || 'LLM streaming request failed');
      if (data.usage) usage = data.usage;
      for (const choice of data.choices || []) {
        const delta = choice.delta || {};
        if (delta.role) message.role = delta.role;
        if (typeof delta.content === 'string' && delta.content) {
          message.content += delta.content;
          onDelta(delta.content);
        }
        for (const part of delta.tool_calls || []) {
          const index = Number.isInteger(part.index) ? part.index : calls.size;
          let call = calls.get(index);
          if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(index, call); }
          if (part.id) call.id += part.id;
          if (part.type) call.type = part.type;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments) call.function.arguments += part.function.arguments;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      return false;
    };
    const flushLine = line => {
      if (!line) {
        const done = consume(dataLines.join('\n'));
        dataLines = [];
        return done;
      }
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      return false;
    };
    let ended = false;
    while (!ended) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) if (flushLine(line)) { ended = true; break; }
      if (done) {
        if (buffer) flushLine(buffer);
        if (dataLines.length) consume(dataLines.join('\n'));
        ended = true;
      }
    }
    message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    if (!message.tool_calls.length) delete message.tool_calls;
    return { choices: [{ message, finish_reason: finishReason }], usage };
  }
}

module.exports = { LlmClient };
