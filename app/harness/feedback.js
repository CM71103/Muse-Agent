'use strict';
// feedback.js — explicit "liked / disliked" markers and the adaptive apply.
//
// The user grades an answer (/good, /bad, or the thumbs in the transcript).
// Every grade leaves an EXPLICIT, inspectable marker:
//
//   ~/.muse-agent/feedback.jsonl
//   { ts, session_id, turn_id, rating: 1|0, words, traits: {...} }
//
// From those markers an adaptive policy derives style rules ("this user
// liked short, list-shaped answers; disliked hedged ones") and applies them
// to the answer-style guide that joins the system prompt — so the next
// answers match what the user actually rewards.
//
// Contract:
//   • markers are local, append-only, one JSON line per grade
//   • the adaptive rules are STYLE METRICS AND RULES ONLY — no response
//     content is put into the guide (the guide is pinned metrics-only by
//     the voice tests)
//   • apply is deterministic: the same markers always yield the same rules
//   • a single grade changes nothing visible yet — the policy needs a
//     minimum sample before it adapts (no flapping on one reaction)

const fs = require('fs');
const path = require('path');
const { configDir } = require('./config');

const MIN_SAMPLES = 3;          // markers needed before the policy adapts
const KEEP_MARKERS = 500;       // ring buffer on disk

function dir() { return configDir(); }
function logFile() { return path.join(dir(), 'feedback.jsonl'); }

// --- traits ----------------------------------------------------------------

function words(t) { return (String(t).match(/[\p{L}\p{N}'’]+/gu) || []).length; }

// The style facets a graded answer is judged on. Kept deliberately small and
// objective — these are what the rules can speak about.
function traitsOf(text) {
  const t = String(text || '');
  const w = words(t);
  const lists = /(^|\n)\s*([-*•]|\d+[.)])\s+\S/.test(t);
  const code = /```/.test(t);
  const headers = /(^|\n)#{1,4}\s+\S/.test(t);
  const hedges = (t.match(/\b(you might|you could|you may want to|it depends|consider|perhaps|possibly|i'd suggest|i recommend|it's worth noting|keep in mind)\b/gi) || []).length;
  const directs = (t.match(/\b(do this|first,|start by|use |run |set |add |remove |change |make sure|note:|short answer|yes,|no,)\b/gi) || []).length;
  return {
    length: w < 90 ? 'short' : w < 260 ? 'medium' : 'long',
    shape: code ? 'code' : lists ? 'list' : headers ? 'headed' : 'prose',
    stance: hedges > directs ? 'hedged' : 'direct',
    closer: /\b(in summary|in short|to summarize|tl;?dr|next steps?|let me know|feel free|if you want)\b/i.test(t) ? 'recap' : 'no-recap',
    emoji: /\p{Extended_Pictographic}/u.test(t) ? 'emoji' : 'plain',
    words: w,
  };
}

// --- markers ---------------------------------------------------------------

function readMarkers() {
  let raw = '';
  try { raw = fs.readFileSync(logFile(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && (m.rating === 1 || m.rating === 0)) out.push(m);
    } catch { /* skip a torn line */ }
  }
  // One grade per turn: re-clicking a thumb must not count twice (a like is
  // a grade of a turn, not of a click). The latest marker for a turn wins, so
  // changing your mind swaps the grade instead of stacking a second one.
  const seen = new Map();
  let anon = 0;
  for (const m of out) {
    const key = m.turn_id ? `${m.session_id || ''}|${m.turn_id}` : `anon|${anon++}`;
    seen.set(key, m);
  }
  return [...seen.values()].slice(-KEEP_MARKERS);
}

function appendMarker(marker) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(marker) + '\n', 'utf8');
  } catch { /* markers are best-effort; never break a turn */ }
}

function summary() {
  const markers = readMarkers();
  const liked = markers.filter(m => m.rating === 1).length;
  const disliked = markers.filter(m => m.rating === 0).length;
  return { total: markers.length, liked, disliked, markers: markers.slice(-20).reverse() };
}

// --- the adaptive policy ---------------------------------------------------

// For one facet, which value does the evidence favour?
// A value needs a clear MARGIN: liked(value) - disliked(value) >= 2 and at
// least two liked samples. Anything thinner is treated as mixed — we say
// nothing rather than flip-flop on one reaction.
const REQUIRED_MARGIN = 2;

function favoured(markers, pick) {
  const liked = {}, disliked = {};
  for (const m of markers) {
    const v = pick(m.traits);
    if (!v) continue;
    if (m.rating === 1) liked[v] = (liked[v] || 0) + 1;
    else disliked[v] = (disliked[v] || 0) + 1;
  }
  const values = [...new Set([...Object.keys(liked), ...Object.keys(disliked)])];
  let best = null, bestMargin = 0, bestLiked = 0, bestDisliked = 0;
  for (const v of values) {
    const l = liked[v] || 0, d = disliked[v] || 0;
    const margin = l - d;
    if (margin > bestMargin) { best = v; bestMargin = margin; bestLiked = l; bestDisliked = d; }
  }
  if (!best || bestLiked < 2 || bestMargin < REQUIRED_MARGIN) return null;
  return { value: best, liked: bestLiked, disliked: bestDisliked, margin: bestMargin };
}

const RULES = {
  length: {
    short: 'Short replies: keep answers tight: a few sentences unless asked for detail.',
    medium: 'Moderate replies: a few short paragraphs, nothing padded.',
    long: 'Thorough replies: structure them with headings and details.',
  },
  shape: {
    list: 'Prefer bullet lists when there are three or more items.',
    prose: 'Plain prose reads better for this user than lists.',
    headed: 'Use short headings to structure longer answers.',
    code: 'Show the code prominently: the code is the answer.',
  },
  stance: {
    direct: 'Answer directly: recommendation first, caveats only when they matter.',
    hedged: 'This user prefers options and trade-offs spelled out before a recommendation.',
  },
  closer: {
    recap: 'Close with a one-line recap or the concrete next step.',
    'no-recap': 'Do not add a recap or a closing pleasantry: end with the answer.',
  },
  emoji: {
    emoji: 'An occasional emoji is welcome.',
    plain: 'No emoji.',
  },
};

// Derive the adaptive rules from the markers. Deterministic.
function adaptiveRules(markers) {
  if (!markers || markers.length < MIN_SAMPLES) return { rules: [], applied: false, reason: 'not enough graded answers yet' };
  const dims = [
    ['length', t => t.length],
    ['shape', t => t.shape],
    ['stance', t => t.stance],
    ['closer', t => t.closer],
    ['emoji', t => t.emoji],
  ];
  const rules = [];
  const evidence = {};
  for (const [dim, pick] of dims) {
    const win = favoured(markers, pick);
    if (!win || !RULES[dim] || !RULES[dim][win.value]) continue;
    // Only assert a rule when the evidence has a real margin.
    const supporting = markers.filter(m => m.rating === 1 && pick(m.traits) === win.value).length;
    const opposing = markers.filter(m => m.rating === 0 && pick(m.traits) === win.value).length;
    if (supporting < 2 || supporting - opposing < REQUIRED_MARGIN) continue;
    evidence[dim] = { value: win.value, liked: supporting, disliked: opposing };
    rules.push(RULES[dim][win.value]);
  }
  if (!rules.length) return { rules: [], applied: false, reason: 'graded answers are too mixed to act on yet' };
  const liked = markers.filter(m => m.rating === 1).length;
  const disliked = markers.filter(m => m.rating === 0).length;
  return {
    rules,
    applied: true,
    evidence,
    reason: `based on ${liked} liked and ${disliked} disliked answers in this app`,
  };
}

// --- the adaptive apply ----------------------------------------------------
//
//   adaptiveApply(t, r)
//     t = the turn  { sessionId, turnId, text }
//     r = the rating { 1 = liked, 0 = disliked }
//
// Records the marker, recomputes the adaptive rules and rewrites the
// answer-style guide so the next answers follow the evidence.
function adaptiveApply(turn, rating) {
  const r = rating === 1 || rating === true ? 1 : 0;
  const text = String((turn && turn.text) || '');
  if (!text.trim()) return { ok: false, error: 'nothing to grade' };
  const marker = {
    ts: new Date().toISOString(),
    session_id: String((turn && turn.sessionId) || ''),
    turn_id: String((turn && turn.turnId) || ''),
    rating: r,
    words: words(text),
    traits: traitsOf(text),
  };
  // Idempotent per turn: the same grade on the same answer is a no-op, so a
  // double click stays one like (and switching like/dislike replaces it).
  const prior = marker.turn_id
    ? readMarkers().find(m => m.session_id === marker.session_id && m.turn_id === marker.turn_id)
    : null;
  if (prior && prior.rating === r) {
    const policy = adaptiveRules(readMarkers());
    let guide = null;
    try { guide = require('./voice').composeGuide(); } catch { guide = null; }
    return { ok: true, deduped: true, marker: prior, policy, guide };
  }
  appendMarker(marker);

  const markers = readMarkers();
  const policy = adaptiveRules(markers);
  // The guide is what the model actually reads — refresh it after a grade.
  let guide = null;
  try { guide = require('./voice').composeGuide(); } catch { guide = null; }
  return { ok: true, marker, policy, guide };
}

// Reset: drop the markers and the adaptive part of the guide.
function reset() {
  try { fs.unlinkSync(logFile()); } catch { /* already gone */ }
  try { require('./voice').composeGuide(); } catch { /* guide is optional */ }
  return { ok: true };
}

module.exports = { traitsOf, record: adaptiveApply, adaptiveApply, adaptiveRules, readMarkers, summary, reset, logFile, MIN_SAMPLES };
