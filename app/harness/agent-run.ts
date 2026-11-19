async function run(this: any, userText: string | null, opts: any = {}) {
  const { Agent, systemPrompt } = require('./agent');
  const { designContext } = require('./design.ts');
  this._cancelRequested = false;
  Agent.repairHistory(this.history);   // cheap no-op; heals interrupted history before the request
  this._runToolErrors = 0;             // per-run tool error metric (surfaced on done)
  this.lastMemoryTurnId = null;
  if (!this.history.length) {
    const design = this.cwdOverride ? designContext(this.cwdOverride) : null;
    // Voice profile (vibe calibration): style-only guide learned locally from
    // the user's previous AI conversations — '' until calibrated or if reset.
    let voiceGuide = '';
    try { voiceGuide = require('./voice').voiceGuide(); } catch { /* voice module optional at runtime */ }
    const systemExtra = [opts.systemExtra || '', voiceGuide, design?.text || ''].filter(Boolean).join('\n\n');
    this.history.push({ role: 'system', content:
      systemPrompt(this.cfg, systemExtra, this.cwdOverride, this.toolMap.has('spawn_agent'), this.sentinel.mode, this.hasViking, this.toolMap.has('sqlite_run_sql'), this.toolMap.has('create_dashboard')) });
  }
  if (userText !== null) {
    // A user message may be multimodal (attachments): opts.content carries the
    // full part array [{type:'text'|'image_url', …}]; otherwise plain text.
    if (Array.isArray(opts.content) && opts.content.length) {
      this.history.push({ role: 'user', content: opts.content });
    } else {
      this.history.push({ role: 'user', content: userText });
    }
  }
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
  // File-change checkpoint (undo): write_file pre-images collected via
  // ctx.checkpoint land here; finalize pins post-run hashes for safe undo.
  const checkpoint = require('./checkpoint').begin(this._runEventId, this.sessionId);
  this._runCheckpoint = checkpoint;
  const ckpt = () => {
    try {
      const entries = checkpoint.finalize();
      return entries.length ? { runId: this._runEventId, files: entries.map((e: any) => e.path) } : undefined;
    } catch { return undefined; }
  };
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
  // Canonical envelope: provider-specific shapes stop at llm.js — the loop
  // consumes {text, toolCalls, reasoning} regardless of provider quirks.
  const { toWireAssistant, toCanonicalMessage } = require('./llm');
  const canonOf = (response: any) => response.canonical || toCanonicalMessage(response.message || {});
  try {
    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (this._cancelRequested) throw Object.assign(new Error('User cancelled'), { name: 'AbortError' });
      this.events({ type: 'turn', turn });
      restoreMemory();
      await this.compactHistory();
      let response = await send();
      const canon = canonOf(response);
      if (!canon.toolCalls.length) {
        finalText = canon.text;
        let continuations = 0;
        while (response.finish_reason === 'length' && continuations < 5) {
          continuations++;
          this.history.push({ role: 'assistant', content: finalText });
          // name:'synthetic' marks live-loop scaffolding; agent.restore() drops
          // these so a restored session never shows them as real user turns.
          this.history.push({ role: 'user', name: 'synthetic', content: 'Continue exactly where you stopped. Do not repeat any part of your previous output, do not restate the task, just continue the code/text seamlessly from the exact cut point.' });
          this.events({ type: 'info', text: `output hit the token limit — continuing (${continuations}/5)` });
          response = await send();
          const next = canonOf(response);
          if (!next.text) break;
          finalText += (finalText.endsWith('\n') ? '' : '\n') + next.text;
        }
        if (this._cancelRequested) throw Object.assign(new Error('User cancelled'), { name: 'AbortError' });
        await finishMemory(response.finish_reason === 'stop' ? null : 'partial_response');
        this.history.push({ role: 'assistant', content: finalText });
        this.persist();
        receipt('run_finished', { outcome: 'complete', turns: turn + 1 });
        const ckComplete = ckpt();
        this.events({ type: 'message', text: finalText });
        this.events({ type: 'done', reason: 'complete', usage, tokensMissing: missingUsage, toolErrors: this._runToolErrors || 0, runId: this._runEventId, checkpoint: ckComplete });
        return { text: finalText, turns: turn + 1, memory_turn_id: memoryContext?.turn_id, usage, tokensMissing: missingUsage, checkpoint: ckComplete };
      }
      this.history.push(toWireAssistant(canon));
      if (canon.text) this.events({ type: 'message', text: canon.text });
      for (const call of canon.toolCalls) {
        const content = await this.executeToolCall(call);
        this.history.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    this.history.push({ role: 'user', name: 'synthetic', content: 'Turn limit reached. Please summarize progress so far and stop.' });
    const response = await send(null);
    finalText = canonOf(response).text || '(no reply)';
    await finishMemory('turn_limit');
    this.history.push({ role: 'assistant', content: finalText });
    this.persist();
    receipt('run_finished', { outcome: 'max_turns', turns: this.maxTurns });
    const ckMax = ckpt();
    this.events({ type: 'message', text: finalText });
    this.events({ type: 'done', reason: 'max_turns', usage, tokensMissing: missingUsage, toolErrors: this._runToolErrors || 0, runId: this._runEventId, checkpoint: ckMax });
    return { text: finalText, turns: this.maxTurns, memory_turn_id: memoryContext?.turn_id, usage, tokensMissing: missingUsage, checkpoint: ckMax };
  } catch (error) {
    const cancelled = this._cancelRequested || (error as Error).name === 'AbortError';
    if (memoryContext?.turn_id) this.memory.failTurn(memoryContext.turn_id, 'unknown',
      cancelled ? 'user_cancelled' : 'provider_or_transport_failure');
    if (cancelled) {
      this.persist();   // partial progress is context worth keeping
      receipt('run_finished', { outcome: 'cancelled' });
      this.events({ type: 'done', reason: 'cancelled', usage, tokensMissing: missingUsage, toolErrors: this._runToolErrors || 0, runId: this._runEventId, checkpoint: ckpt() });
      return { text: finalText || '(cancelled)', turns: 0, cancelled: true, memory_turn_id: memoryContext?.turn_id, usage, tokensMissing: missingUsage };
    }
    this.persist();   // a failed run still leaves resumable context behind
    receipt('run_finished', { outcome: 'error', error: String((error as Error).message || error).slice(0, 200) });
    ckpt();   // partial writes on a failed run stay undoable on disk
    throw error;
  } finally { this.stripMemory(); }
}
module.exports = { run };
