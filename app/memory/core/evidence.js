'use strict';
// memory/core/citations.js — [cN] marker template + parser.
// D5: markers are templated into the payload from day one, never retrofitted.
// R-19: malformed/duplicate citations are anomalies, not credited.

// payload: [{id, text}] in pack order (position 1..n) -> formatted memory block
function templatePayload(payload) {
  const parts = [];
  payload.forEach((m, i) => {
    parts.push(`[c${i + 1}] source=${m.provenance || 'unknown'} trust=${m.trust_tier || 'unknown'} ${String(m.text).replace(/\[c(\d+)\]/gi, '［c$1］').replace(/\[END PROJECT MEMORY\]/gi, '［END PROJECT MEMORY］')}`);
  });
  return parts.join('\n\n');
}

// Parse [cN] markers from an assistant message; map to memory ids via position map.
// Returns {citedIds, anomalies:[{marker, reason}]}
// positionMap: { '1': 'memory-id', ... } from packer position{}
function parseCitations(text, positionMap) {
  const citedIds = [];
  const seen = new Set();
  const anomalies = [];
  const re = /\[(c(\d+))\]/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const marker = m[1];
    const n = parseInt(m[2], 10);
    const id = positionMap ? positionMap[String(n)] : null;
    if (!id) {
      anomalies.push({ marker, reason: 'unknown_position' });
      continue;
    }
    if (seen.has(id)) {
      anomalies.push({ marker, reason: 'duplicate' });
      continue;
    }
    seen.add(id);
    citedIds.push(id);
  }
  return { citedIds, anomalies };
}

module.exports = { templatePayload, parseCitations };
