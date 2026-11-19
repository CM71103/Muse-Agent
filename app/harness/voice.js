'use strict';
// voice.js — "vibe calibration": learn HOW this user likes answers from the
// AI conversations they already have on the machine, and give Muse a style
// guide so it matches that vibe from the first message.
//
// Privacy contract:
//   - nothing leaves the machine; analysis runs locally
//   - the generated guide contains STYLE METRICS AND RULES ONLY — never
//     quotes, topics, or any conversation content (pinned by tests)
//   - the user can preview, recalibrate, or reset at any time
//
// Outputs (in the config dir):
//   voice.json — measured features + which sources contributed (the report)
//   voice.md   — the answer-style guide, injected into the system prompt

const fs = require('fs');
const path = require('path');
const { configDir } = require('./config');
const sources = require('./voice-sources');

function voiceJson() { return path.join(configDir(), 'voice.json'); }
function voiceMd() { return path.join(configDir(), 'voice.md'); }

// --- measurement (pure) ---

const words = (t) => (String(t).match(/[\p{L}\p{N}'’]+/gu) || []).length;
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const rate = (xs, pred) => (xs.length ? xs.filter(pred).length / xs.length : 0);

function containsEmoji(t) { return /\p{Extended_Pictographic}/u.test(t); }
function hasList(t) { return /(^|\n)\s*([-*•]|\d+[.)])\s+\S/.test(t); }
function hasCode(t) { return /```/.test(t); }
function hasHeader(t) { return /(^|\n)#{1,4}\s+\S/.test(t); }
function hasRecap(t) { return /\b(in summary|in short|to summarize|tl;?dr|next steps?|let me know|feel free|if you want)\b/i.test(t); }
function hedgeCount(t) {
  return (String(t).match(/\b(you might|you could|you may want to|it depends|consider|perhaps|possibly|i'd suggest|i recommend|it's worth noting|keep in mind)\b/gi) || []).length;
}
function directCount(t) {
  return (String(t).match(/\b(do this|first,|start by|use |run |set |add |remove |change |make sure|note:|short answer|yes,|no,)\b/gi) || []).length;
}

function analyze(messages) {
  const user = messages.filter(m => m.role === 'user').map(m => m.text);
  const assist = messages.filter(m => m.role === 'assistant').map(m => m.text);
  const aw = assist.map(words), uw = user.map(words);
  return {
    user: {
      count: user.length,
      medianWords: median(uw),
      questionRate: rate(user, t => /\?\s*$|\?$/.test(t.trim()) || /^(what|how|why|when|where|who|can|could|is|are|do|does)\b/i.test(t.trim())),
      lowercaseStartRate: rate(user, t => /^[a-z]/.test(t.trim())),
      emojiRate: rate(user, containsEmoji),
    },
    assistant: {
      count: assist.length,
      medianWords: median(aw),
      p90Words: aw.length ? [...aw].sort((a, b) => a - b)[Math.floor(aw.length * 0.9)] : 0,
      listRate: rate(assist, hasList),
      codeRate: rate(assist, hasCode),
      headerRate: rate(assist, hasHeader),
      emojiRate: rate(assist, containsEmoji),
      recapRate: rate(assist, hasRecap),
      hedgeRate: rate(assist, t => hedgeCount(t) > directCount(t)),
    },
  };
}

// --- guide generation (deterministic rules, metrics only) ---

function renderGuide(features, report) {
  const a = features.assistant, u = features.user;
  const n = a.count + u.count;
  const rules = [];
  rules.push(`Match the answer style the user already knows from their previous AI conversations (${n} messages analyzed locally).`);

  // length
  if (a.medianWords && a.medianWords < 90) rules.push(`Keep replies short and direct — around ${Math.max(30, Math.round(a.medianWords / 10) * 10)} words when the task allows; expand only when asked.`);
  else if (a.medianWords < 220) rules.push(`Keep replies moderate — a few short paragraphs (previous median ≈ ${Math.round(a.medianWords / 10) * 10} words); pad nothing.`);
  else if (a.medianWords) rules.push(`Thorough replies match this user's history (previous median ≈ ${Math.round(a.medianWords / 10) * 10} words) — structure them, don't ramble.`);

  // structure
  if (a.listRate >= 0.35) rules.push('Use bullet lists whenever there are 3 or more items — this user reads lists well.');
  if (a.headerRate >= 0.25) rules.push('Short headings structure longer answers for this user.');
  if (a.codeRate >= 0.25) rules.push('Show code in fenced blocks with a one-line intro; the code carries the answer.');
  else if (a.codeRate <= 0.05 && a.count > 20) rules.push('Mostly prose answers — include code only when the task is code.');

  // tone
  if (a.hedgeRate <= 0.25 && a.count > 20) rules.push('Answer directly first. Skip disclaimers, hedging, and "it depends" openers — give the recommendation, then the caveat if truly needed.');
  if (a.emojiRate <= 0.02 && a.count > 20) rules.push('No emoji.');
  else if (a.emojiRate >= 0.08) rules.push('Occasional emoji is welcome and familiar to this user.');
  if (a.recapRate >= 0.25) rules.push('Close with a one-line recap or the concrete next step.');

  // user register
  if (u.count > 10) {
    if (u.lowercaseStartRate >= 0.5) rules.push("The user writes casually (lowercase, contractions) — mirror that register: conversational, not formal.");
    else rules.push('The user writes in clean sentences — keep the tone polished and warm.');
    if (u.medianWords && u.medianWords < 25) rules.push('The user asks in short bursts — infer the obvious context and ask a question only when truly stuck.');
    if (u.emojiRate <= 0.02 && u.count > 20) rules.push('The user does not use emoji — none in replies either.');
  }

  const reportLine = report && report.roots && report.roots.length
    ? `Sources: ${report.roots.map(r => `${r.kind} (${r.messages})`).join(', ')}.`
    : '';
  return [
    '# Answer style (learned locally from this user\'s previous AI conversations)',
    '# Style metrics only — no conversation content is stored in this guide.',
    ...rules.map(r => `- ${r}`),
    reportLine ? `\n<!-- ${reportLine} -->` : '',
  ].filter(Boolean).join('\n');
}

// --- public API ---

function calibrate(opts = {}) {
  const { messages, roots } = sources.collectMessages(opts);
  if (messages.length < 20) {
    return { ok: false, error: 'not enough conversation history found to learn a style', found: messages.length };
  }
  const features = analyze(messages);
  const report = {
    calibrated_at: new Date().toISOString(),
    messages: messages.length,
    roots: roots.map(r => ({ kind: r.kind, confidence: r.confidence, messages: r.messages })),
    features,
    disabled: false,
  };
  const guide = renderGuide(features, report);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(voiceJson(), JSON.stringify(report, null, 2));
  fs.writeFileSync(voiceMd(), guide);
  return { ok: true, messages: messages.length, roots: report.roots, features, guide };
}

function isDisabled() {
  try { return JSON.parse(fs.readFileSync(voiceJson(), 'utf8')).disabled === true; } catch { return false; }
}

function reset() {
  try { fs.unlinkSync(voiceMd()); } catch { /* already gone */ }
  try {
    const report = JSON.parse(fs.readFileSync(voiceJson(), 'utf8'));
    report.disabled = true;
    fs.writeFileSync(voiceJson(), JSON.stringify(report, null, 2));
  } catch {
    try { fs.writeFileSync(voiceJson(), JSON.stringify({ disabled: true })); } catch { /* config dir gone */ }
  }
  return { ok: true };
}

function status() {
  try {
    const report = JSON.parse(fs.readFileSync(voiceJson(), 'utf8'));
    return {
      ok: true,
      calibrated: !report.disabled && fs.existsSync(voiceMd()),
      disabled: !!report.disabled,
      calibrated_at: report.calibrated_at || null,
      messages: report.messages || 0,
      roots: report.roots || [],
      guide: fs.existsSync(voiceMd()) ? fs.readFileSync(voiceMd(), 'utf8') : null,
    };
  } catch { return { ok: true, calibrated: false, disabled: false, guide: null }; }
}

// The system-prompt block; '' when there is no profile or it is disabled.
function voiceGuide() {
  if (isDisabled()) return '';
  try { return fs.readFileSync(voiceMd(), 'utf8'); } catch { return ''; }
}

module.exports = { analyze, renderGuide, calibrate, reset, status, voiceGuide, isDisabled };
