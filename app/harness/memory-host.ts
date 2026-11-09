const { classifyUserMemory } = require('../memory/core/capture.ts');

function hashText(text: string) {
  return 'sha256:' + require('node:crypto').createHash('sha256').update(text || '').digest('hex');
}
module.exports = {
  async sendWithMemory(this: any, ctx: any, signal?: AbortSignal, tools: any = this.toolSchemas()) {
    const { Agent } = require('./agent');
    this.refreshPermissionMode();
    if (ctx?.turn_id) {
      this.memory.commitPrepared(ctx); // Revalidate deleted/revoked records at every send.
      if (this.memorySection() !== this.memoryBlock(ctx)) {
        this.memory.failTurn(ctx.turn_id, 'unknown', 'payload_changed_before_send');
        throw new Error('Memory payload changed before send; retry turn to repack.');
      }
    }
    const messages = structuredClone(this.history);
    const input = messages.reduce((n: number, message: any) => n + Agent.estimateTokens(message), 0)
      + Agent.estimateTokens({ content: JSON.stringify(tools) });
    if (input + (this.cfg.llm.max_tokens || 8192) + 256 > this.ctxBudget) {
      if (ctx?.turn_id) this.memory.failTurn(ctx.turn_id, 'unknown', 'request_budget_overflow');
      throw new Error('Request exceeds context limit; shorten conversation or raise context limit.');
    }
    const result = await this.llm.chat(messages, tools, { signal });
    if (ctx?.turn_id && !ctx._acknowledged) {
      this.memory.acknowledgeSent(ctx.turn_id, ctx.packed_ids,
        hashText(Agent.memorySectionOf(messages)), ctx.citation_map);
      ctx._acknowledged = true;
    }
    return result;
  },
  async ingestUserTurn(this: any, userText: string) {
    if (!this.memory || this.memory.projectId === null || !userText) return;
    const id = `user:${this.sessionId}:${this._runEventId}`;
    this._collectSourceEvent({ source_event_id: id, text: String(userText).slice(0, 2000), provenance: 'user', type: 'fact' });
    try {
      const durable = classifyUserMemory(userText);
      if (durable) await this.memory.ingest([{ source_event_id: id,
        text: durable.text, provenance: 'user', type: durable.type }]);
      // The answer is already complete. Keep capture durable as pending_embed
      // without holding the composer on provider latency. requestContext()
      // flushes these rows before the next turn's retrieval; no detached job.
    } catch (error) {
      this.events({ type: 'error', text: `memory: capture deferred (${(error as Error).message})` });
    }
  },
  async ingestToolResult(this: any, name: string, resultText: string, callId: string) {
    if (!this.memory || this.memory.projectId === null || !resultText) return;
    this._collectSourceEvent({ source_event_id: `tool:${this.sessionId}:${this._runEventId}:${callId}`,
      text: `${name}: ${resultText}`.slice(0, 2000), provenance: 'tool', type: 'fact' });
  },
  _collectSourceEvent(this: any, event: any) {
    this._sourceEvents ||= [];
    if (this._sourceEvents.length >= 200) return;
    this._sourceEvents.push(event);
    this._sourceSeq++;
  },
  async endSessionExtract(this: any) {
    if (!this.memory) return null;
    const memory = this.memory;
    const events = (this._sourceEvents || []).slice();
    this._sourceEvents = [];
    if (!events.length) return { skipped: 'no_events' };
    try {
      const result = await memory.extractSession(events);
      this.events({ type: 'info', text: result.ok
        ? `memory: extraction ${result.extracted} new, ${result.deduped || 0} dup`
        : `memory: extraction skipped (${result.reason})` });
      return result;
    } catch (error) {
      this.events({ type: 'error', text: `memory: extraction failed (${(error as Error).message})` });
      return { ok: false, reason: String((error as Error).message || error) };
    }
  },
};
