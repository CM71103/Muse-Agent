async function run(this: any, userText: string | null, opts: any = {}) {
  const { Agent, systemPrompt } = require('./agent');
  this._cancelRequested = false;
  this.lastMemoryTurnId = null;
  if (!this.history.length) this.history.push({ role: 'system', content:
    systemPrompt(this.cfg, opts.systemExtra, this.cwdOverride, this.toolMap.has('spawn_agent'), this.sentinel.mode, this.hasViking) });
  if (userText !== null) this.history.push({ role: 'user', content: userText });
  this._title ||= require('./session').titleFromHistory(this.history);
  this._runEventId = require('node:crypto').randomUUID();
  this.stripMemory();
  let memoryContext: any = null;
  if (this.memory && userText !== null) {
    try {
      memoryContext = await this.memory.requestContext(userText, {
        contextLimit: this.ctxBudget,
        otherInputTokens: this.estimateHistoryTokens() + Agent.estimateTokens({ content: JSON.stringify(this.toolSchemas()) }),
        outputReserve: this.cfg.llm.max_tokens || 8192,
      });
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
      const response = await this.sendWithMemory(memoryContext, controller.signal, tools);
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
          this.history.push({ role: 'user', content: 'Continue exactly where you stopped. Do not repeat any part of your previous output, do not restate the task, just continue the code/text seamlessly from the exact cut point.' });
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
        this.events({ type: 'message', text: finalText });
        this.events({ type: 'done', reason: 'complete' });
        return { text: finalText, turns: turn + 1, memory_turn_id: memoryContext?.turn_id };
      }
      this.history.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
      if (message.content) this.events({ type: 'message', text: message.content });
      for (const call of message.tool_calls) {
        const content = await this.executeToolCall(call);
        this.history.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    this.history.push({ role: 'user', content: 'Turn limit reached. Please summarize progress so far and stop.' });
    const response = await send(null);
    finalText = response.message.content || '(no reply)';
    await finishMemory('turn_limit');
    this.history.push({ role: 'assistant', content: finalText });
    this.events({ type: 'message', text: finalText });
    this.events({ type: 'done', reason: 'max_turns' });
    return { text: finalText, turns: this.maxTurns, memory_turn_id: memoryContext?.turn_id };
  } catch (error) {
    const cancelled = this._cancelRequested || (error as Error).name === 'AbortError';
    if (memoryContext?.turn_id) this.memory.failTurn(memoryContext.turn_id, 'unknown',
      cancelled ? 'user_cancelled' : 'provider_or_transport_failure');
    if (cancelled) {
      this.events({ type: 'done', reason: 'cancelled' });
      return { text: finalText || '(cancelled)', turns: 0, cancelled: true, memory_turn_id: memoryContext?.turn_id };
    }
    throw error;
  } finally { this.stripMemory(); }
}
module.exports = { run };
