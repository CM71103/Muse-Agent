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
function endsWithQuestion(t) { return /[?]\s*$/.test(String(t).trim()); }
function politeOpener(t) { return /^(sure|absolutely|of course|certainly|great question|good question|happy to help|i'd be happy|no problem|alright|okay|ok|got it)\b[,!.\s-]/i.test(String(t).trim()); }

// The short, unambiguous ways a person says "yes, that one was right".
// Used to work out which answers were ACCEPTED — the likable ones.
const POSITIVE_REPLY = /^(ok(ay)?|k|kk|yes|yep|yeah|yup|sure|thanks?|thank you|ty|thx|perfect|nice|cool|great|awesome|lovely|beautiful|fab|good job|well done|works?|worked|working|works for me|looks good|looks great|sounds good|exactly|correct|indeed|got it|do it|go ahead|perfectly|done|that'?s (it|right|correct)|makes sense|bingo|please continue|carry on|proceed)\b/i;
const POSITIVE_ONLY = /^[^\p{L}\p{N}]*(?:[👍✅🎉🙏💯❤️]+|✔️?)[^\p{L}\p{N}]*$/u;

function isPositiveReply(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return false;
  if (t.includes('?')) return false;               // "are you sure?" is not acceptance
  if (POSITIVE_ONLY.test(t)) return true;           // a thumbs-up on its own
  const first = t.split(/[\n\r]/)[0].trim();
  return POSITIVE_REPLY.test(first);
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
      endQuestionRate: rate(assist, endsWithQuestion),
      openerRate: rate(assist, politeOpener),
    },
  };
}

// --- the likable ones ------------------------------------------------------
//
// Not every accepted answer is graded in this app — most of the user's AI
// history lives in other tools, where the only signal is what they typed
// NEXT. An answer that is followed by "ok", "thanks", "works", "perfect"…
// was accepted; anything else is just a normal exchange. Those accepted
// answers are the likable ones, and the gap between them and the average
// answer is what the user actually rewards.
const MIN_LIKED = 4;

function likedAnswers(messages) {
  const out = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const answer = messages[i];
    const reply = messages[i + 1];
    if (!answer || answer.role !== 'assistant') continue;
    if (!reply || reply.role !== 'user') continue;
    if (!isPositiveReply(reply.text)) continue;
    out.push(answer.text);
  }
  return out;
}

const round10 = (n) => Math.max(10, Math.round(n / 10) * 10);

// Compare the accepted answers with the average answer and say what is
// different. Deterministic, metrics only — no answer text is kept.
function likedProfile(messages) {
  const liked = likedAnswers(messages);
  const baseline = analyze(messages).assistant;
  const profile = { count: liked.length, baseline: baseline.count, rules: [], note: '' };
  if (liked.length < MIN_LIKED || baseline.count < 20) {
    profile.note = liked.length < MIN_LIKED
      ? `only ${liked.length} accepted answers found: keep chatting to sharpen this`
      : 'not enough answers overall to compare against';
    return profile;
  }
  const L = analyze(liked.map(text => ({ role: 'assistant', text }))).assistant;
  const rules = [];
  const deltas = {};
  if (L.medianWords && baseline.medianWords) {
    if (L.medianWords <= baseline.medianWords * 0.8) { deltas.length = 'shorter'; rules.push(`The answers you accept are shorter than your average: aim for about ${round10(L.medianWords)} words, then stop.`); }
    else if (L.medianWords >= baseline.medianWords * 1.25) { deltas.length = 'longer'; rules.push(`The answers you accept run long (about ${round10(L.medianWords)} words): give the real detail instead of a teaser.`); }
  }
  if (baseline.recapRate >= 0.15 && L.recapRate <= baseline.recapRate * 0.5) { deltas.recap = 'none'; rules.push('The answers you accept skip the recap and the closing pleasantry: end on the answer itself.'); }
  else if (L.recapRate >= Math.min(0.5, baseline.recapRate + 0.2)) { deltas.recap = 'yes'; rules.push('The answers you accept close with a one-line recap or the concrete next step.'); }
  if (baseline.endQuestionRate >= 0.15 && L.endQuestionRate <= baseline.endQuestionRate * 0.5) { deltas.question = 'no'; rules.push('Do not end with a question: state the answer and stop.'); }
  if (baseline.hedgeRate >= 0.15 && L.hedgeRate <= baseline.hedgeRate * 0.5) { deltas.hedge = 'less'; rules.push('Less hedging in the answers you accept: recommend one path, then note the caveat.'); }
  if (baseline.listRate >= 0.15 && L.listRate >= baseline.listRate + 0.15) { deltas.list = 'more'; rules.push('The answers you accept are list-shaped: bullets beat paragraphs.'); }
  if (baseline.codeRate >= 0.1 && L.codeRate >= baseline.codeRate + 0.15) { deltas.code = 'more'; rules.push('The answers you accept show the actual command or code, not only a description of it.'); }
  if (baseline.headerRate >= 0.15 && L.headerRate >= baseline.headerRate + 0.15) { deltas.header = 'more'; rules.push('The answers you accept use short headings to structure longer replies.'); }
  if (baseline.emojiRate >= 0.08 && L.emojiRate <= baseline.emojiRate * 0.4) { deltas.emoji = 'none'; rules.push('The answers you accept carry no emoji.'); }
  if (baseline.openerRate >= 0.12 && L.openerRate <= baseline.openerRate * 0.5) { deltas.opener = 'none'; rules.push('Skip the pleasantry opener ("Sure", "Absolutely", "Great question"): start with the answer.'); }
  profile.rules = rules;
  profile.deltas = deltas;
  profile.features = L;
  profile.note = rules.length
    ? `${liked.length} accepted answers compared with ${baseline.count} answers overall`
    : `${liked.length} accepted answers: they look like your usual style, nothing to change yet`;
  return profile;
}

function renderLikedSection(profile) {
  if (!profile || !profile.rules || !profile.rules.length) return '';
  return [
    '# Answer style (the answers you liked best)',
    '# Learned from the answers you accepted across your local chats —',
    '# compared against your average answer, and only what differs is kept.',
    '# Where this section and the summary above disagree, this one wins.',
    ...profile.rules.map(r => `- ${r}`),
    profile.note ? `\n<!-- ${profile.note} -->` : '',
  ].filter(Boolean).join('\n');
}

// --- guide generation (deterministic rules, metrics only) ---

function renderGuide(features, report, liked) {
  const a = features.assistant, u = features.user;
  const n = a.count + u.count;
  const rules = [];
  rules.push(`Match the answer style the user already knows from their previous AI conversations (${n} messages analyzed locally).`);

  // length — skipped when the likable answers already say something different
  const lengthDelta = liked && liked.deltas ? liked.deltas.length : null;
  if (!lengthDelta && a.medianWords && a.medianWords < 90) rules.push(`Keep replies short and direct: around ${Math.max(30, Math.round(a.medianWords / 10) * 10)} words when the task allows; expand only when asked.`);
  else if (!lengthDelta && a.medianWords < 220) rules.push(`Keep replies moderate: a few short paragraphs (previous median ≈ ${Math.round(a.medianWords / 10) * 10} words); pad nothing.`);
  else if (!lengthDelta && a.medianWords) rules.push(`Thorough replies match this user's history (previous median ≈ ${Math.round(a.medianWords / 10) * 10} words): structure them, don't ramble.`);

  // structure
  if (a.listRate >= 0.35) rules.push('Use bullet lists whenever there are 3 or more items: this user reads lists well.');
  if (a.headerRate >= 0.25) rules.push('Short headings structure longer answers for this user.');
  if (a.codeRate >= 0.25) rules.push('Show code in fenced blocks with a one-line intro; the code carries the answer.');
  else if (a.codeRate <= 0.05 && a.count > 20) rules.push('Mostly prose answers: include code only when the task is code.');

  // tone
  if (a.hedgeRate <= 0.25 && a.count > 20) rules.push('Answer directly first. Skip disclaimers, hedging, and "it depends" openers: give the recommendation, then the caveat if truly needed.');
  if (a.emojiRate <= 0.02 && a.count > 20) rules.push('No emoji.');
  else if (a.emojiRate >= 0.08) rules.push('Occasional emoji is welcome and familiar to this user.');
  if (a.recapRate >= 0.25) rules.push('Close with a one-line recap or the concrete next step.');

  // user register
  if (u.count > 10) {
    if (u.lowercaseStartRate >= 0.5) rules.push("The user writes casually (lowercase, contractions): mirror that register: conversational, not formal.");
    else rules.push('The user writes in clean sentences: keep the tone polished and warm.');
    if (u.medianWords && u.medianWords < 25) rules.push('The user asks in short bursts: infer the obvious context and ask a question only when truly stuck.');
    if (u.emojiRate <= 0.02 && u.count > 20) rules.push('The user does not use emoji: none in replies either.');
  }

  const reportLine = report && report.roots && report.roots.length
    ? `Sources: ${report.roots.map(r => `${r.kind} (${r.messages})`).join(', ')}.`
    : '';
  return [
    '# Answer style (learned locally from this user\'s previous AI conversations)',
    '# Style metrics only: no conversation content is stored in this guide.',
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
  const liked = likedProfile(messages);
  const report = {
    calibrated_at: new Date().toISOString(),
    messages: messages.length,
    roots: roots.map(r => ({ kind: r.kind, confidence: r.confidence, messages: r.messages })),
    features,
    liked: { count: liked.count, note: liked.note, rules: liked.rules, deltas: liked.deltas || {} },
    disabled: false,
  };
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(voiceJson(), JSON.stringify(report, null, 2));
  const guide = composeGuide();
  return { ok: true, messages: messages.length, roots: report.roots, features, liked, guide };
}

// The guide is the COMPOSITION of three sources, weakest first:
//   1. the base style learned from the user's other AI conversations
//   2. the gap between the answers the user ACCEPTED and their average
//   3. the adaptive rules derived from the answers the user GRADED here
// All three are metrics and rules only — never conversation content.
function composeGuide() {
  let report = null;
  try { report = JSON.parse(fs.readFileSync(voiceJson(), 'utf8')); } catch { report = null; }
  if (report && report.disabled) { try { fs.unlinkSync(voiceMd()); } catch { /* gone */ } return ''; }

  const base = report && report.features ? renderGuide(report.features, report, report.liked) : '';
  const liked = report && report.liked ? renderLikedSection(report.liked) : '';
  let adaptive = { rules: [], applied: false, reason: 'not enough graded answers yet' };
  try { adaptive = require('./feedback').adaptiveRules(require('./feedback').readMarkers()); } catch { adaptive = { rules: [], applied: false }; }

  const sections = [];
  if (base) sections.push(base);
  if (liked) sections.push(liked);
  if (adaptive.applied && adaptive.rules.length) {
    sections.push([
      '# Answer style (adjusted by your own feedback in this app)',
      '# Derived from the answers you graded: liked answers shaped these rules,',
      '# disliked answers ruled the opposite out.',
      ...adaptive.rules.map(r => `- ${r}`),
      adaptive.reason ? `\n<!-- ${adaptive.reason} -->` : '',
    ].filter(Boolean).join('\n'));
  }
  const guide = sections.join('\n\n');
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(voiceMd(), guide);
  } catch { /* guide is a cache; the prompt falls back to '' */ }
  return guide;
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
      liked: report.liked || null,
      guide: fs.existsSync(voiceMd()) ? fs.readFileSync(voiceMd(), 'utf8') : null,
    };
  } catch { return { ok: true, calibrated: false, disabled: false, guide: null }; }
}

// The system-prompt block; '' when there is no profile or it is disabled.
function voiceGuide() {
  if (isDisabled()) return '';
  try { return fs.readFileSync(voiceMd(), 'utf8'); } catch { return ''; }
}

module.exports = { analyze, renderGuide, calibrate, composeGuide, reset, status, voiceGuide, isDisabled, likedAnswers, likedProfile, renderLikedSection, isPositiveReply };
