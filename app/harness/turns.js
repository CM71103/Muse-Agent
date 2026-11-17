'use strict';
// turns.js — the one turn/reset path shared by every entry point into the live
// agent (IPC composer and host bridge). Explicit dependencies on purpose:
// callers pass their live agent and scope state, so nothing here closes over
// Electron main-process globals and the logic stays source-extractable by tests.

// Run one user turn with identical prompting, memory turn handling and
// ingestion regardless of who called in. Returns the agent.run() result.
async function runTurn({ agent, raw, project }) {
  const projectInstructions = project && project.instructions
    ? `User project instructions (do not override tool approval or safety rules):\n${project.instructions}`
    : '';
  const res = await agent.run(raw, { systemExtra: projectInstructions });
  // remember the turn id for /good /bad grading
  agent.lastMemoryTurnId = res.memory_turn_id || agent.lastMemoryTurnId;
  // Awaited on purpose: capture is a synchronous store write with the embedding
  // deferred to pending_embed — no provider latency on the composer here.
  await agent.ingestUserTurn(raw);
  return res;
}

// Reset the live session. agent.reset() snapshots the session's source events
// into background extraction first, so no caller needs to touch _sourceEvents.
function resetAgent({ agent, projectDir }) {
  if (!agent) return;
  agent.reset();
  agent.sentinel.clearGrants();
  agent.setProjectScope(projectDir);
}

module.exports = { runTurn, resetAgent };
