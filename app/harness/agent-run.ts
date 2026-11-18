async function run(this: any, userText: string | null, opts: any = {}) {
  const { Agent, systemPrompt } = require('./agent');
  const { designContext } = require('./design.ts');
  this._cancelRequested = false;
  this.lastMemoryTurnId = null;
  if (!this.history.length) {
    const design = this.cwdOverride ? designContext(this.cwdOverride) : null;
    const systemExtra = [opts.systemExtra || '', design?.text || ''].filter(Boolean).join('\n\n');
    this.history.push({ role: 'system', content:
      systemPrompt(this.cfg, systemExtra, this.cwdOverride, this.toolMap.has('spawn_agent'), this.sentinel.mode, this.hasViking) });
  }
  if (userText !== null) this.history.push({ role: 'user', content: userText });
  this._title ||= require('./session').titleFromHistory(this.history);
  this._runEventId = require('node:crypto').randomUUID();
  // Durable run receipts: accept is written before the run moves, every
  // terminal outcome closes it. A dangling accept (crash/quit mid-run) is
  // detected on restore so interrupted work is surfaced, never silently lost.
  const session = require('./session');
  const receipt = (status: string, extra: any = {}) => {
    try { session.appendReceipt(this.sessionId, { runId: this._runEventId, commandId: opts.commandId || null, status, ...extra }); } catch { /* receipts never break a run */ }
  };
  receipt('run_accepted');
  this.stripMemory();
  let memoryContext: any = null;
  const memBudget = () => ({
    contextLimit: this.ctxBudget,
    otherInputTokens: this.estimateHistoryTokens() + Agent.estimateTokens({ content: JSON.stringify(this.toolSchemas()) }),
    outputReserve: this.cfg.llm.max_tokens || 8192,
  });
  if (this.memory && userText !== null) {
    try {
      memoryContext = await this.memory.requestContext(userText, memBudget());
      const reason = memoryContext.clamp_reason;
      if (reason && (reason.startsWith('embed_failed') || reason.startsWith('embed_disabled'))) {
        if (this._lastEmbedNotice !== reason) {
          this._lastEmbedNotice = reason;
          this.events({ type: 'error', text: reason });
        }
      } else if (!reason) this._lastEmbedNotice = null;
    } catch (error) {
      memoryContext = null;
      this.events({ type: 'error', text: `memory: requestContext failed — proceeding without memory (${(error as Error).message})` });
    }
  }
  const restoreMemory = () => {
    this.stripMemory();
    if (memoryContext?.turn_id) {
      const block = this.memoryBlock(memoryContext);
      if (block) this.appendMemorySection(block);
    }
  };
  const usage: Record<string, number> = {};
  let missingUsage = false;
  let finalText = '';
  const send = async (tools: any = this.toolSchemas()) => {
    if (this._cancelRequested) throw Object.assign(new Error('User cancelled'), { name: 'AbortError' });
    restoreMemory();
    const controller = this._beginAbort();
    try {
      let response: any = null;
      for (let repack = 0; ; repack++) {
        try {
          response = await this.sendWithMemory(memoryContext, controller.signal, tools, {
            onDelta: (text: string) => this.events({ type: 'delta', text }),
            onStreamReset: () => this.events({ type: 'stream_reset' }),
          });
          break;
        } catch (error) {
          // MEMORY_REPACK_REQUIRED / "retry turn to repack": the packed records
          // changed between prepare and send (edited, deleted or revoked). The
          // stale turn is already failed with a reason — repack a fresh context
          // and retry instead of surfacing a raw protocol error. Bounded: after
          // 2 repacks (or without memory/user text to repack) rethrow.
          const message = String((error as Error).message || error);
          if (!/MEMORY_REPACK_REQUIRED|retry turn to repack/.test(message) || repack >= 2
              || this._cancelRequested || !this.memory || userText === null) throw error;
          this.events({ type: 'info', text: 'memory: context changed before send — repacking and retrying' });
          if (memoryContext?.turn_id) {
            try { this.memory.failTurn(memoryContext.turn_id, 'unknown', 'memory_repack_required'); } catch { /* stale turn cleanup is best-effort */ }
          }
          memoryContext = await this.memory.requestContext(userText, memBudget());
          restoreMemory();
        }
      }
      if (!response.usage) missingUsage = true;
      else for (const [key, value] of Object.entries(response.usage)) {
        if (typeof value === 'number' && Number.isFinite(value)) usage[key] = (usage[key] || 0) + value;
      }
      return response;
    } finally { this._endAbort(); this.stripMemory(); }
  };
  const finishMemory = async (reason: string | null) => {
    if (memoryContext?.turn_id) {
      await this.memory.completeTurn(memoryContext.turn_id, {
        response: finalText, usage: missingUsage ? null : usage,
        outcome: { status: reason ? 'unknown' : 'completed', reason },
      });
      this.lastMemoryTurnId = memoryContext.turn_id;
    }
  };
  const clean = (message: any) => {
    for (const key of ['reasoning_content', 'reasoning', 'matched_stop', 'refusal']) delete message[key];
    return message;
  };
  try {
    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (this._cancelRequested) throw Object.assign(new Error('User cancelled'), { name: 'AbortError' });
      this.events({ type: 'turn', turn });
      restoreMemory();
      await this.compactHistory();
      let response = await send();
      const message = clean(response.message);
      if (!message.tool_calls?.length) {
        finalText = message.content || '';
        let continuations = 0;
        while (response.finish_reason === 'length' && continuations < 5) {
          continuations++;
          this.history.push({ role: 'assistant', content: finalText });
          // name:'synthetic' marks live-loop scaffolding; agent.restore() drops
          // these so a restored session never shows them as real user turns.
          this.history.push({ role: 'user', name: 'synthetic', content: 'Continue exactly where you stopped. Do not repeat any part of your previous output, do not restate the task, just continue the code/text seamlessly from the exact cut point.' });
          this.events({ type: 'info', text: `output hit the token limit — continuing (${continuations}/5)` });
          response = await send();
          const next = clean(response.message);
          if (!next.content) break;
          finalText += (finalText.endsWith('\n') ? '' : '\n') + next.content;
        }
        if (this._cancelRequested) throw Object.assign(new Error('User cancelled'), { name: 'AbortError' });
        await finishMemory(response.finish_reason === 'stop' ? null : 'partial_response');
        this.history.push({ role: 'assistant', content: finalText });
        this.persist();
        receipt('run_finished', { outcome: 'complete', turns: turn + 1 });
        this.events({ type: 'message', text: finalText });
        this.events({ type: 'done', reason: 'complete', usage, tokensMissing: missingUsage, runId: this._runEventId });
        return { text: finalText, turns: turn + 1, memory_turn_id: memoryContext?.turn_id, usage, tokensMissing: missingUsage };
      }
      this.history.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
      if (message.content) this.events({ type: 'message', text: message.content });
      for (const call of message.tool_calls) {
        const content = await this.executeToolCall(call);
        this.history.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    this.history.push({ role: 'user', name: 'synthetic', content: 'Turn limit reached. Please summarize progress so far and stop.' });
    const response = await send(null);
    finalText = response.message.content || '(no reply)';
    await finishMemory('turn_limit');
    this.history.push({ role: 'assistant', content: finalText });
    this.persist();
    receipt('run_finished', { outcome: 'max_turns', turns: this.maxTurns });
    this.events({ type: 'message', text: finalText });
    this.events({ type: 'done', reason: 'max_turns', usage, tokensMissing: missingUsage, runId: this._runEventId });
    return { text: finalText, turns: this.maxTurns, memory_turn_id: memoryContext?.turn_id, usage, tokensMissing: missingUsage };
  } catch (error) {
    const cancelled = this._cancelRequested || (error as Error).name === 'AbortError';
    if (memoryContext?.turn_id) this.memory.failTurn(memoryContext.turn_id, 'unknown',
      cancelled ? 'user_cancelled' : 'provider_or_transport_failure');
    if (cancelled) {
      this.persist();   // partial progress is context worth keeping
      receipt('run_finished', { outcome: 'cancelled' });
      this.events({ type: 'done', reason: 'cancelled', usage, tokensMissing: missingUsage, runId: this._runEventId });
      return { text: finalText || '(cancelled)', turns: 0, cancelled: true, memory_turn_id: memoryContext?.turn_id, usage, tokensMissing: missingUsage };
    }
    this.persist();   // a failed run still leaves resumable context behind
    receipt('run_finished', { outcome: 'error', error: String((error as Error).message || error).slice(0, 200) });
    throw error;
  } finally { this.stripMemory(); }
}
module.exports = { run };
