const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-feedback-'));
process.env.MUSE_HOME = home;
const feedback = require('../feedback');
const voice = require('../voice');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const SHORT_LIST = 'Short answer: do this.\n\n- one\n- two\n- three\n\nLet me know.';
const LONG_HEDGED = ('There are many considerations here. You might want to consider perhaps several approaches. '
  + 'It depends on your situation. You could also think about it in terms of the broader picture, and possibly the trade-offs involved. '
  + 'In summary, consider the following points in detail when you plan your approach to the problem at hand. ').repeat(6);

test('traits describe the style of an answer objectively', () => {
  const short = feedback.traitsOf(SHORT_LIST);
  assert.equal(short.length, 'short');
  assert.equal(short.shape, 'list');
  assert.equal(short.stance, 'direct');
  assert.equal(short.closer, 'recap');

  const long = feedback.traitsOf(LONG_HEDGED);
  assert.equal(long.length, 'long');
  assert.equal(long.stance, 'hedged');
});

test('a grade leaves an explicit marker on disk', () => {
  const res = feedback.adaptiveApply({ sessionId: 's1', turnId: 's1:0', text: SHORT_LIST }, 1);
  assert.equal(res.ok, true);
  assert.equal(res.marker.rating, 1);
  assert.equal(res.marker.traits.length, 'short');
  const raw = fs.readFileSync(feedback.logFile(), 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.rating, 1);
  assert.equal(parsed.turn_id, 's1:0');
  // the marker is explicit: rating, traits and counts — no response body
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'text'), false);
  assert.equal(parsed.text, undefined);
});

test('markers accumulate and are counted as liked / disliked', () => {
  feedback.adaptiveApply({ sessionId: 's1', turnId: 's1:1', text: SHORT_LIST }, 1);
  feedback.adaptiveApply({ sessionId: 's1', turnId: 's1:2', text: LONG_HEDGED }, 0);
  const s = feedback.summary();
  assert.equal(s.total, 3);
  assert.equal(s.liked, 2);
  assert.equal(s.disliked, 1);
});

test('the adaptive policy stays silent until there is real signal', () => {
  const early = feedback.adaptiveRules([{ rating: 1, traits: feedback.traitsOf(SHORT_LIST) }]);
  assert.equal(early.applied, false);
  assert.match(early.reason, /not enough/);
});

test('liked short answers and disliked hedged ones shape the rules', () => {
  const markers = [
    { rating: 1, traits: feedback.traitsOf(SHORT_LIST) },
    { rating: 1, traits: feedback.traitsOf(SHORT_LIST) },
    { rating: 1, traits: feedback.traitsOf(SHORT_LIST) },
    { rating: 0, traits: feedback.traitsOf(LONG_HEDGED) },
    { rating: 0, traits: feedback.traitsOf(LONG_HEDGED) },
  ];
  const policy = feedback.adaptiveRules(markers);
  assert.equal(policy.applied, true);
  assert.ok(policy.rules.some(r => /short/i.test(r)), 'a length rule is derived');
  assert.ok(policy.rules.some(r => /direct/i.test(r)), 'a stance rule is derived');
  assert.ok(policy.rules.some(r => /bullet lists/i.test(r)), 'a shape rule is derived');
});

test('contradictory grades produce no rule (no flapping)', () => {
  const markers = [
    { rating: 1, traits: feedback.traitsOf(SHORT_LIST) },
    { rating: 0, traits: feedback.traitsOf(SHORT_LIST) },
    { rating: 1, traits: feedback.traitsOf(SHORT_LIST) },
  ];
  const policy = feedback.adaptiveRules(markers);
  assert.equal(policy.applied, false);
  assert.match(policy.reason, /mixed/);
});

test('grading composes the guide so the next answers follow the evidence', () => {
  // a base profile first (the guide is the composition of base + adaptive)
  const report = {
    calibrated_at: new Date().toISOString(),
    messages: 40, roots: [], disabled: false,
    features: {
      user: { count: 20, medianWords: 12, questionRate: 1, lowercaseStartRate: 0, emojiRate: 0 },
      assistant: { count: 20, medianWords: 40, p90Words: 60, listRate: 0.8, codeRate: 0, headerRate: 0, emojiRate: 0, recapRate: 0.5, hedgeRate: 0 },
    },
  };
  fs.writeFileSync(path.join(home, 'voice.json'), JSON.stringify(report));
  for (let i = 0; i < 3; i++) feedback.adaptiveApply({ sessionId: 's2', turnId: `s2:${i}`, text: SHORT_LIST }, 1);
  const guide = voice.composeGuide();
  assert.match(guide, /adjusted by your own feedback/);
  assert.match(guide, /keep answers tight/i);
  // the guide still carries the base part
  assert.match(guide, /previous AI conversations/);
});

test('the guide stays metrics-only: no response content leaks into it', () => {
  const SECRET = 'kumquat invoice 4821';
  const secretText = `Short answer: ${SECRET} is wrong.\n\n- check it\n- redo it`;
  for (let i = 0; i < 3; i++) feedback.adaptiveApply({ sessionId: 's3', turnId: `s3:${i}`, text: secretText }, 1);
  const guide = voice.composeGuide();
  assert.equal(guide.includes(SECRET), false, 'the guide must never quote the graded answer');
  assert.equal(feedback.summary().markers.some(m => JSON.stringify(m).includes(SECRET)), false,
    'the markers store traits, not the answer text');
});

test('the next turn of a live session picks up the updated style rules', () => {
  // Start from a clean slate (earlier tests left markers behind).
  feedback.reset();
  // The system message is built once per session; a grade must refresh it.
  const agent = require('../agent');
  const a: any = new agent.Agent({ llm: { model: 'gpt-4o', base_url: 'https://x.invalid/v1', context_tokens: 100000 }, agent: {}, sentinel: {} }, { toolMap: new Map(), tools: [] });
  a.toolMap = new Map();
  a.sentinel = { mode: 'auto', clearGrants: () => {} };
  a.toolSchemas = () => [];
  a.llm = { chat: async () => ({ message: { role: 'assistant', content: 'ok' }, canonical: { role: 'assistant', text: 'ok', toolCalls: [], reasoning: '' }, finish_reason: 'stop' }) };
  a.events = () => {};
  a.ctxBudget = 100000;
  a._pendingToolImages = [];
  a.memory = null;

  const systemOf = () => a.history.find((m: any) => m.role === 'system')?.content || '';
  // first turn: no adaptive rules yet
  a.run('first question', { systemExtra: '' });
  const before = systemOf();
  assert.equal(/adjusted by your own feedback/.test(before), false, 'no adaptive rules before any grade');

  // three liked short answers → the adaptive policy applies
  for (let i = 0; i < 3; i++) feedback.adaptiveApply({ sessionId: 'live', turnId: `live:${i}`, text: SHORT_LIST }, 1);

  // next turn in the SAME session must carry the new rules
  a.run('second question', { systemExtra: '' });
  const after = systemOf();
  assert.match(after, /adjusted by your own feedback/, 'the system prompt refreshed in place');
  assert.match(after, /keep answers tight/i);
});

test('reset removes the markers and the adaptive rules', () => {
  const res = feedback.reset();
  assert.equal(res.ok, true);
  assert.equal(feedback.summary().total, 0);
  const guide = voice.composeGuide();
  assert.equal(/adjusted by your own feedback/.test(guide), false);
});
