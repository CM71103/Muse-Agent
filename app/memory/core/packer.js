'use strict';
// memory/core/packer.js — greedy whole-record fill with deterministic tie-break.
// Invariants (R-13, R-14, R-18):
//  - whole records only: a record fits or is omitted, never truncated
//  - deterministic tie-break by record id (lexicographic)
//  - omitted ids carry a reason: budget | near_miss | status | oversized | scope
//  - position{} = insertion order in the pack (1-based)

// records: [{id, tokens, score, status}]  tokens estimated by caller (adapters/tokenizer)
// budgetTokens: the requested memory allowance for this turn (ladder level or fixed)
function pack(records, budgetTokens, cutoff, nearMissDelta = 0.05) {
  const eligible = records.filter(r => r.status === 'active');          // R-15 hard filter
  const sorted = eligible
    .filter(r => r.score >= cutoff)
    .slice()
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

  const packed = [];
  const omitted = [];
  let used = 0;
  const inPack = new Set();

  for (const r of sorted) {
    if (r.tokens > budgetTokens) {
      // single record bigger than whole budget: oversized regardless of fill state
      omitted.push({ id: r.id, reason: 'oversized' });
      continue;
    }
    if (used + r.tokens <= budgetTokens) {
      packed.push(r);
      inPack.add(r.id);
      used += r.tokens;
    } else {
      omitted.push({ id: r.id, reason: 'budget' });
    }
  }

  // near-miss diagnostics (never eligible for updates, R-16(ii) reads only
  // above-cutoff budget-omitted candidates, not these)
  for (const r of eligible) {
    if (inPack.has(r.id)) continue;
    if (r.score < cutoff && r.score >= cutoff - nearMissDelta) {
      omitted.push({ id: r.id, reason: 'near_miss' });
    }
  }
  for (const r of records) {
    if (r.status !== 'active' && !inPack.has(r.id) && !omitted.some(o => o.id === r.id)) {
      omitted.push({ id: r.id, reason: r.status === 'quarantined' ? 'status' : 'scope' });
    }
  }

  const position = {};
  packed.forEach((r, i) => { position[r.id] = i + 1; });

  return { packed, omitted, usedTokens: used, position };
}

module.exports = { pack };
