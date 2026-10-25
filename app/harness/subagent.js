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
      'still require user approval. Cannot be nested (child cannot spawn children).',
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

      // Child config: same LLM, tighter turn budget. Separate history. Same sentinel.
      const childCfg = JSON.parse(JSON.stringify(parent.cfg));  // plain-data config
      const childMaxTurns = Math.min(
        Math.max(1, Math.floor(args.max_turns || 12)),
        opts.maxTurnsCap || 24
      );
      childCfg.agent = { ...(childCfg.agent || {}), max_turns: childMaxTurns };

      const child = new Agent(childCfg, {
        disableSubagent: true,    // no nesting — child tool registry lacks spawn_agent
        approver: (request) => new Promise(async (resolve) => {
          // Route child approvals through the PARENT sentinel's approver with a
          // child tag so the UI can label it. Same gate, same user.
          try {
            const tagged = { ...request, subagent: true };
            const v = await parent.sentinel.approver(tagged);
            resolve(v);
          } catch { resolve(false); }
        }),
        onEvent: (ev) => {
          // Tag + forward child events so the transcript shows nested work.
          try { parent.events({ ...ev, subagent: true }); } catch {}
        },
        questionAsker: (q) => {
          // Child questions flow to the same user, tagged.
          if (!parent.questionAsker) return Promise.resolve(null);
          return parent.questionAsker({ ...q, subagent: true });
        },
      });

      // Inherit project scope + taint, mirroring the parent's working state.
      if (parent.cwdOverride) child.setProjectScope(parent.cwdOverride);
      child.tainted = parent.tainted;
      child.netPolicy = { ...(parent.netPolicy || {}) };

      // Child cancel: parent cancel flips the child's flag at the next hop.
      if (parent._cancelRequested) {
        return { ok: false, error: 'parent cancelled before child start' };
      }
      const cancelWatcher = setInterval(() => {
        if (parent._cancelRequested) { try { child.requestCancel(); } catch {} }
      }, 250);
      children.add(child);

      try {
        const res = await child.run(task);
        const text = String(res.text || '').slice(0, SUBAGENT_RESULT_CAP);
        return {
          ok: true,
          cancelled: !!res.cancelled,
          turns: res.turns,
          result: text,
          ...(text.length >= SUBAGENT_RESULT_CAP ? { truncated: true } : {}),
        };
      } catch (e) {
        return { ok: false, error: `subagent failed: ${e && e.message || e}` };
      } finally {
        clearInterval(cancelWatcher);
        children.delete(child);
      }
    },
  };
}

module.exports = { mkSubagentTool, SUBAGENT_MAX_DEPTH, SUBAGENT_MAX_CONCURRENT, SUBAGENT_RESULT_CAP };
