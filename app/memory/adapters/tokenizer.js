'use strict';
// memory/adapters/tokenizer.js — token ESTIMATOR only.
// The request-budget clamp (context.js) is authoritative; this never gates alone.

const CHARS_PER_TOKEN = 4;   // conservative for English + code

function countTokens(text) {
  const s = String(text || '');
  return Math.max(1, Math.ceil(s.length / CHARS_PER_TOKEN));
}

module.exports = { countTokens, CHARS_PER_TOKEN };
