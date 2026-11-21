'use strict';
// turns.js — the one turn/reset path shared by every entry point into the live
// agent (IPC composer and host bridge). Explicit dependencies on purpose:
// callers pass their live agent and scope state, so nothing here closes over
// Electron main-process globals and the logic stays source-extractable by tests.

// Run one user turn with identical prompting, memory turn handling and
// ingestion regardless of who called in. commandId (optional) is recorded in
// the run receipt so a retried dispatch can be deduplicated. Returns the
// agent.run() result.
async function runTurn({ agent, raw, project, commandId }) {
  const projectInstructions = project && project.instructions
    ? `User project instructions (do not override tool approval or safety rules):\n${project.instructions}`
    : '';
  // Attachments staged by the composer (PDF/image). Their text is always
  // available; the pixels only go out when the SELECTED model can see.
  const assembled = assembleAttachments(agent, raw, commandId);
  const res = await agent.run(raw, {
    systemExtra: projectInstructions,
    commandId,
    ...(assembled.content ? { content: assembled.content } : {}),
  });
  // remember the turn id for /good /bad grading
  agent.lastMemoryTurnId = res.memory_turn_id || agent.lastMemoryTurnId;
  // Awaited on purpose: capture is a synchronous store write with the embedding
  // deferred to pending_embed — no provider latency on the composer here.
  await agent.ingestUserTurn(raw);
  return res;
}

// Turn staged attachments into the user message content.
//   • text of every attachment (PDF text layer or OCR) is always included
//   • image pixels are included ONLY when the active model is vision-capable
//   • when images are dropped, the user is told once, plainly
function assembleAttachments(agent, raw, commandId) {
  let ids = [];
  try { ids = require('./attachments').takeStaged(commandId || 'default'); } catch { return { content: null }; }
  if (!ids.length) return { content: null };

  const att = require('./attachments');
  const caps = require('./model-caps');
  const cfg = agent && agent.cfg ? agent.cfg : null;
  const modelId = cfg && cfg.llm ? String(cfg.llm.model || '') : '';
  const vision = caps.modelIsVisionCapable(modelId, cfg || {});
  const metas = ids.map(id => att.loadMeta(id)).filter(Boolean);
  const parts = [];
  const textBits = [];

  const imageParts = [];
  const dropped = [];
  for (const meta of metas) {
    if (meta.kind === 'image') {
      if (vision) {
        const img = att.imageData(meta.id);
        if (img) {
          imageParts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: 'auto' } });
          // The pixels go to the model AND the local OCR transcript comes
          // along: exact strings (numbers, IDs) survive even when the model
          // reads them imperfectly.
          textBits.push(`[attached image: ${img.name}${meta.text ? ': local text extraction follows': ''}]${meta.text ? `\n${meta.text}`: ''}`);
          continue;
        }
      }
      dropped.push(meta.name);
      if (meta.text) textBits.push(`[attached image (text extracted locally): ${meta.name}]\n${meta.text}`);
    } else if (meta.text) {
      textBits.push(`[attached file: ${meta.name}${meta.pages ? ` (${meta.pages} page${meta.pages === 1 ? '' : 's'})`: ''}]\n${meta.text}`);
    }
  }

  // No pixels needed (model is text-only): the extracted text carries it.
  const body = [String(raw || ''), ...textBits].filter(Boolean).join('\n\n');
  parts.push({ type: 'text', text: body });
  parts.push(...imageParts);

  if (dropped.length) {
    try {
      agent.events({ type: 'info', text:
        `image${dropped.length === 1 ? '': 's'} not sent as pixels: the selected model (${modelId || 'unknown'}) is not vision-capable; locally extracted text was used instead` +
        (metas.some(m => m.kind === 'image' && !m.text) ? ', and no text could be extracted from them' : '') });
    } catch { /* events are best-effort */ }
  }
  return { content: parts };
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
