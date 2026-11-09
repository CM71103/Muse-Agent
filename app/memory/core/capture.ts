'use strict';

type CapturedMemory = { text: string; type: 'fact' | 'preference' | 'procedure' };

// This is a conservative fast path, not a replacement for session extraction.
// Unmatched messages remain source events so useful facts can be distilled later.
// Never truncate a message into a different claim just to make it eligible.
function classifyUserMemory(input: unknown): CapturedMemory | null {
  if (typeof input !== 'string') return null;
  const original = input.trim();
  if (!original || original.length > 2000 || original.includes('```')) return null;

  let text = original;
  let explicit = false;
  const directive = /^(?:please\s+)?(?:remember(?:\s+(?:that|this))?\s*[:,]?\s+|(?:save|store)(?:\s+this)?\s+(?:in|to)\s+memory\s*:?\s*)/i;
  const match = text.match(directive);
  if (match) {
    explicit = true;
    text = text.slice(match[0].length).trim();
  }
  if (!text || /[?？]/.test(text) || /\n\s*\n/.test(text)) return null;
  if (/(?:[.!]\s+|\n)(?:please\s+)?(?:can|could|would|fix|debug|run|install|open|delete|deploy|send|write|create|build|review|summarize)\b/i.test(text)) return null;

  // Do not automatically make policy overrides persistent trusted facts.
  // This does not change provenance or decide whether a live user action is allowed.
  const policyOverride = [
    /\b(?:ignore|disregard)\s+(?:all\s+|previous\s+|prior\s+)?instructions\b/i,
    /\b(?:ignore|bypass|disable|skip|override|turn\s+off)\b.{0,60}\b(?:safety|security|approvals?|permissions?|sentinel|sandbox|deny\s+rules)\b/i,
    /\b(?:never|do\s+not|don't)\s+(?:ask\s+(?:me\s+)?(?:for\s+)?|require\s+|request\s+)?(?:approvals?|permissions?)\b/i,
    /\byou\s+are\s+now\b|\b(?:new|updated)\s+(?:system\s+)?prompt\s*:/i,
  ];
  if (policyOverride.some(pattern => pattern.test(text))) return null;

  if (/^I\s+(?:prefer|like|dislike|favor|favour)\b\s+\S/i.test(text)) {
    return { text, type: 'preference' };
  }
  if (/^(?:My\s+(?:name|pronouns?|timezone|time\s+zone|native\s+language)\s+(?:is|are)\s+\S|My\s+(?:cat|dog|pet)\s+(?:is\s+named|is\s+called|name\s+is)\s+\S|I\s+(?:live\s+in|work\s+(?:at|for|as)|speak)\s+\S)/i.test(text)) {
    return { text, type: 'fact' };
  }
  if (!explicit) return null;

  // "Remember how..." is recall, while "save this file" is an ordinary task.
  // One-off commands also belong to task context, not durable memory.
  if (/^(?:what|when|where|who|why|how|whether|can|could|would|did|do|does)\b/i.test(text)) return null;
  if (/^(?:to\s+)?(?:fix|debug|run|install|open|delete|remove|deploy|send|write|create|build|review|summarize)\b/i.test(text)) return null;
  const type = /^(?:always|never|for\s+future\s+(?:tasks|sessions))\b/i.test(text) ? 'procedure' : 'fact';
  return { text, type };
}

module.exports = { classifyUserMemory };
