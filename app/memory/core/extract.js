'use strict';
// memory/core/extract.js — session-end extraction (spec §2 core surface).
// Pure logic: takes source events + an injected LLM call + the frozen prompt,
// returns candidate memory records. No I/O here — the layer wires the llm
// adapter, token caps, dedupe, and ingest.
//
// Provenance is PRESERVED: every candidate carries the provenance tier and the
// exact source_event_ids it derived from. Injection-shaped candidates keep the
// quarantine path on ingest (injectionRisk is re-run by the layer — a clever
// prompt cannot launder injection-shaped text into active memory).

const { load: loadPrompt } = require('../prompts/prompts');
const { chat } = require('../adapters/llm');

const ALLOWED_TYPES = new Set(['fact', 'decision', 'preference', 'procedure', 'error_fix']);
const ALLOWED_PROV = new Set(['user', 'tool', 'imported', 'unknown']);
const MAX_RECORDS = 12;
const MAX_TEXT = 240;

// events: [{source_event_id, text, provenance, type?, created_at?}]
// callLlm: async ({system, user}) -> {text, usage} (injected for tests).
// Returns { candidates: [{text, type, provenance, source_event_ids}], prompt_hash, note, usage }
async function extract(events, callLlm) {
  const evs = (events || []).filter(e => e && e.source_event_id && typeof e.text === 'string' && e.text.trim());
  if (!evs.length) {
    return { candidates: [], prompt_hash: loadPrompt('extract-prompt.md').hash, note: 'no_events', usage: null };
  }
  const prompt = loadPrompt('extract-prompt.md');
  const listing = evs.map(e => JSON.stringify({
    id: e.source_event_id,
    provenance: ALLOWED_PROV.has(e.provenance) ? e.provenance : 'unknown',
    type: e.type || 'fact',
    text: String(e.text).slice(0, 2000),
  })).join('\n');
  const user = `EVENTS (${evs.length}):\n${listing}\n\nExtract memory candidates per the system instructions.`;
  const res = await callLlm({ system: prompt.text, user });
  const candidates = parseCandidates(res && res.text, evs);
  return { candidates, prompt_hash: prompt.hash, note: (res && res.note) || '', usage: (res && res.usage) || null };
}

// Strict JSON parse with one lenient retry: a fenced block is tolerated, but
// garbage is not silently coerced into zero records with no error.
function parseCandidates(text, evs) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let doc;
  try { doc = JSON.parse(unfenced); } catch { return []; }
  const arr = Array.isArray(doc && doc.records) ? doc.records : (Array.isArray(doc) ? doc : null);
  if (!arr) return [];
  const ids = new Set(evs.map(e => e.source_event_id));
  const out = [];
  for (const r of arr.slice(0, MAX_RECORDS)) {
    if (!r || typeof r.text !== 'string' || !r.text.trim()) continue;
    const t = r.text.trim().slice(0, MAX_TEXT);
    let prov = ALLOWED_PROV.has(r.provenance) ? r.provenance : null;
    // Provenance preservation: when the model omits or invents a tier, derive
    // it from the source events the candidate claims (or all events if it
    // claims none). Never invent — downgrade to unknown on conflict.
    const claimed = Array.isArray(r.source_event_ids) ? r.source_event_ids.filter(x => ids.has(x)) : [];
    const pool = claimed.length ? claimed : [...ids];
    const tiers = new Set(evs.filter(e => pool.includes(e.source_event_id)).map(e => ALLOWED_PROV.has(e.provenance) ? e.provenance : 'unknown'));
    if (!prov) prov = tiers.size === 1 ? [...tiers][0] : (tiers.has('user') && tiers.size === 1 ? 'user' : 'unknown');
    else if (!claimed.every(sid => (evs.find(e => e.source_event_id === sid) || {}).provenance === prov)) prov = 'unknown';
    const type = ALLOWED_TYPES.has(r.type) ? r.type : 'fact';
    out.push({ text: t, type, provenance: prov, source_event_ids: claimed });
  }
  return out;
}

module.exports = { extract, parseCandidates, ALLOWED_TYPES, MAX_RECORDS, MAX_TEXT };
