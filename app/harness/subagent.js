'use strict';
// subagent.js - spawn_agent tool. Antigravity-style: parent agent delegates a
// subtask to a child agent loop with its own isolated history + turn budget.
// Security model:
//   - Child inherits the SAME Sentinel (grants, deny rules, approver chain) —
//     approvals from the child surface in the UI like any other tool call.
//   - Child inherits project scope (cwdOverride) and taint state from parent.
//   - Child cannot spawn its own children (no recursion) — prevents run-away
//     fan-out and approval floods.
//   - Child cannot outlive parent: parent cancel propagates; child events are
//     tagged so the UI can show nested activity.

const { Agent } = require('./agent');
const { randomUUID } = require('node:crypto');

const SUBAGENT_MAX_DEPTH = 1;        // parent (depth 0) may spawn depth-1 children only
const SUBAGENT_MAX_CONCURRENT = 2;   // children running at once per parent
const SUBAGENT_RESULT_CAP = 60000;   // chars returned to parent

function mkSubagentTool(opts = {}) {
  const depth = opts.depth || 0;
  const children = opts.children || new Set();    // shared per-parent live set

  return {
    name: 'spawn_agent',
    description:
      'Run a focused subtask in a fresh child agent loop with its own context window. ' +
      'Use for parallelizable/independent subtasks (research, file surveys, multi-file analysis) ' +
      'to keep your own context small. The child returns a final summary text to you. ' +
      'The child shares your tools, project folder, and approval gates — side-effect tools ' +
      'follow the active permission mode and run without approval in Auto. Cannot be nested (child cannot spawn children).',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, self-contained instructions for the child agent. The child sees ONLY this text — include all paths/context it needs.' },
        max_turns: { type: 'number', description: `Optional child turn budget, default 12, cap ${opts.maxTurnsCap || 24}` },
      },
      required: ['task'],
    },
    async run(args, ctx) {
      if (depth >= SUBAGENT_MAX_DEPTH) {
        return { ok: false, error: 'spawn_agent is not available to child agents (no nesting)' };
      }
      if (children.size >= SUBAGENT_MAX_CONCURRENT) {
        return { ok: false, error: `too many concurrent subagents (${SUBAGENT_MAX_CONCURRENT}); wait for one to finish` };
      }
      const task = String(args.task || '').slice(0, 20000);
      if (!task.trim()) return { ok: false, error: 'empty task' };

      const parent = ctx.agent;
      if (!parent || !(parent instanceof Agent)) {
        return { ok: false, error: 'spawn_agent requires a parent agent context' };
      }
      if (parent._cancelRequested) {
        return { ok: false, error: 'parent cancelled before child start' };
      }

      const subagentId = randomUUID();
      const emit = event => {
        try { parent.events({ ...event, subagent: true, subagentId }); } catch {}
      };
      let child = null;
      let cancelWatcher = null;
      let terminal = { cancelled: false, result: '', turns: 0 };
      emit({ type: 'subagent_start', task });

      try {

        // Child config: same LLM, tighter turn budget. Separate history. Same sentinel.
        const childCfg = JSON.parse(JSON.stringify(parent.cfg));  // plain-data config
        const childMaxTurns = Math.min(
          Math.max(1, Math.floor(args.max_turns || 12)),
          opts.maxTurnsCap || 24
        );
        childCfg.agent = { ...(childCfg.agent || {}), max_turns: childMaxTurns };

        child = new Agent(childCfg, {
          disableSubagent: true,    // no nesting — child tool registry lacks spawn_agent
          onEvent: (ev) => {
            // Tag + forward child events so the transcript shows nested work.
            if (ev.type === 'turn' && Number.isFinite(ev.turn)) terminal.turns = ev.turn + 1;
            emit(ev);
          },
          questionAsker: (q) => {
            // Child questions flow to the same user, tagged.
            if (!parent.questionAsker) return Promise.resolve(null);
            return parent.questionAsker({ ...q, subagent: true, subagentId });
          },
        });
        child.subagentId = subagentId;

        // Share the live policy rather than reconstructing a stale config copy.
        // Do not call setProjectScope: it would clear the parent's shared grants.
        child.sentinel = parent.sentinel;
        child.cwdOverride = parent.cwdOverride;
        Object.defineProperty(child, 'tainted', {
          get: () => parent.tainted,
          set: value => { if (value) parent.markTainted('subagent private read'); },
        });
        Object.defineProperty(child, 'netPolicy', { get: () => parent.netPolicy });
        // Read the parent flag synchronously at each tool boundary; the timer
        // below still aborts a child's in-flight provider request.
        let childCancelled = false;
        Object.defineProperty(child, '_cancelRequested', {
          get: () => childCancelled || parent._cancelRequested,
          set: value => { childCancelled = !!value; },
        });

        // Child cancel: parent cancel flips the child's flag at the next hop.
        cancelWatcher = setInterval(() => {
          if (parent._cancelRequested) { try { child.requestCancel(); } catch {} }
        }, 250);
        children.add(child);

        const res = await child.run(task);
        const text = String(res.text || '').slice(0, SUBAGENT_RESULT_CAP);
        terminal = {
          cancelled: !!res.cancelled,
          result: text,
          turns: Number.isFinite(res.turns) ? res.turns : terminal.turns,
        };
        return {
          ok: true,
          subagentId,
          ...terminal,
          ...(text.length >= SUBAGENT_RESULT_CAP ? { truncated: true } : {}),
        };
      } catch (e) {
        const error = `subagent failed: ${e && e.message || e}`;
        terminal = { ...terminal, cancelled: !!(parent._cancelRequested || child && child._cancelRequested), error };
        return { ok: false, subagentId, ...terminal };
      } finally {
        clearInterval(cancelWatcher);
        if (child) children.delete(child);
        emit({ type: 'subagent_done', ...terminal });
      }
    },
  };
}

module.exports = { mkSubagentTool, SUBAGENT_MAX_DEPTH, SUBAGENT_MAX_CONCURRENT, SUBAGENT_RESULT_CAP };
