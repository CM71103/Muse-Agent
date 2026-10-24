'use strict';
// memory/adapters/vector.js — vector adapter abstraction (spec §2 adapters list).
// Two implementations behind one interface:
//   memory   : vectors live on the memory row itself in SQLite (current Phase-0
//              shape; fine for personal scale).
//   provider : an external vector service would own ANN search; the store stays
//              the source of truth and this adapter is where a provider-backed
//              search would slot in. Ships as an explicit stub that reports
//              unavailable rather than silently degrading — swapping providers
//              must never silently change recall semantics (do-not #8 spirit).
//
// Interface (both must honor):
//   search({queryVector, rows, topK}) -> [{id, similarity}]
//   cosine similarity only; no learned distance (R-08 discipline).
//
// The row-pin check (adapters/embeddings.js checkRowPin) is applied by the
// CALLER before rows enter search — a vector adapter never trusts unpinned
// rows on its own.

function memorySearch({ queryVector, rows, topK }) {
  const { cosine } = require('./embeddings');
  const scored = [];
  for (const row of rows) {
    if (!Array.isArray(row.embedding)) continue;
    const sim = cosine(queryVector, row.embedding);
    if (!(sim > 0)) continue;                 // orthogonal or negative: skip
    scored.push({ id: row.id, similarity: sim });
  }
  scored.sort((a, b) => b.similarity - a.similarity || String(a.id).localeCompare(String(b.id)));
  return typeof topK === 'number' && topK > 0 ? scored.slice(0, topK) : scored;
}

// provider-backed: intentionally not implemented in this build. Returns an
// explicit unsupported result instead of pretending to search.
function providerSearch() {
  const e = new Error('provider vector adapter not implemented in this build; use in-memory mode');
  e.code = 'VECTOR_ADAPTER_UNSUPPORTED';
  throw e;
}

function search(kind, args) {
  if (kind === 'provider') return providerSearch(args);
  return memorySearch(args);
}

module.exports = { search, memorySearch, providerSearch };
