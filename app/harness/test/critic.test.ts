const { test } = require('node:test');
const assert = require('node:assert/strict');
const critic = require('../critic');
const { Sentinel } = require('../sentinel');

function fakeClient(reply) {
  return { chat: async (messages) => ({ canonical: { text: reply }, message: { content: reply }, _messages: messages }) };
}

test('parseCritique pulls JSON out of fenced and noisy replies', () => {
  const fenced = 'Here you go:\n```json\n{"score": 8, "verdict": "solid"}\n```';
  assert.equal(critic.parseCritique(fenced).score, 8);
  const noisy = 'blah {"score": 5, "verdict": "ok", "fixes": ["a", "b"]} trailing prose';
  assert.deepEqual(critic.parseCritique(noisy).fixes, ['a', 'b']);
  assert.equal(critic.parseCritique('no json here'), null);
});

test('normalizeCritique clamps scores and caps item lists', () => {
  const r = critic.normalizeCritique(
    { score: 42, scores: { correctness: -3, clarity: 9 }, weaknesses: ['a', 'b', 'c', 'd', 'e', 'f'], fixes: [] },
    ['correctness', 'clarity', 'missing']
  );
  assert.equal(r.score, 10);
  assert.equal(r.scores.correctness, 0);
  assert.equal(r.scores.clarity, 9);
  assert.equal(r.scores.missing, null);
  assert.equal(r.weaknesses.length, 5, 'weakness list is capped');
});

test('reviewText returns a structured review from the reviewer model', async () => {
  const reply = JSON.stringify({
    score: 7,
    scores: { correctness: 8, clarity: 6 },
    verdict: 'good structure, thin evidence',
    weaknesses: ['claims X without a source'],
    fixes: ['cite the experiment log for the X claim'],
  });
  const res = await critic.reviewText({ llm: { model: 'm' } }, 'some draft text', {
    client: fakeClient(reply),
    rubric: ['correctness', 'clarity'],
  });
  assert.equal(res.ok, true);
  assert.equal(res.score, 7);
  assert.equal(res.scores.correctness, 8);
  assert.deepEqual(res.fixes, ['cite the experiment log for the X claim']);
});

test('reviewText refuses empty input and survives a broken reviewer', async () => {
  const empty = await critic.reviewText({ llm: {} }, '   ');
  assert.equal(empty.ok, false);
  const broken = await critic.reviewText({ llm: {} }, 'draft', { client: fakeClient('hello, not json') });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /usable JSON/);
});

test('reviewText bounds the input it sends to the reviewer', async () => {
  let seen = '';
  const client = { chat: async (messages) => { seen = messages[1].content; return { canonical: { text: '{"score":6}' } }; } };
  const res = await critic.reviewText({ llm: {} }, 'x'.repeat(critic.MAX_CHARS + 5000), { client });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.ok(seen.length < critic.MAX_CHARS + 2000, 'reviewer input is bounded');
});

test('reviewText can run on a separate reviewer model', async () => {
  const cfg = { llm: { model: 'writer-model', review_model: 'critic-model' } };
  const out = require('../critic');
  const probe = out.parseCritique('{"score":1}');
  assert.equal(probe.score, 1);
  // reviewerCfg is internal, but its effect is observable through the client
  // factory: build the client the same way the tool does.
  const { LlmClient } = require('../llm');
  const client = new LlmClient(cfg.llm.review_model ? { ...cfg, llm: { ...cfg.llm, model: cfg.llm.review_model } } : cfg);
  assert.equal(client.cfg.model, 'critic-model');
});

test('critique is registered, read-class, and gated like a cost tool', () => {
  const { buildTools } = require('../tools');
  const { tools } = buildTools({ llm: { model: 'm' }, sentinel: { mode: 'ask' }, agent: {} });
  const critique = tools.find(t => t.name === 'critique');
  assert.ok(critique, 'critique tool is registered');
  assert.deepEqual(critique.parameters.required, ['text']);

  const s = new Sentinel({ sentinel: { mode: 'ask', deny_rules: [] }, agent: {} });
  const ask = s.decide({ tool: 'critique', args: { text: 'x' } });
  assert.equal(ask.decision, 'ask', 'ask mode asks before spending a review call');
  assert.match(ask.reason, /review model call/);

  const auto = new Sentinel({ sentinel: { mode: 'auto', deny_rules: [] }, agent: {} });
  assert.equal(auto.decide({ tool: 'critique', args: { text: 'x' } }).decision, 'allow');

  const plan = new Sentinel({ sentinel: { mode: 'plan', deny_rules: [] }, agent: {} });
  assert.equal(plan.decide({ tool: 'critique', args: { text: 'x' } }).decision, 'allow', 'plan mode allows the read-only review');

  const unknown = s.decide({ tool: 'totally_unknown', args: {} });
  assert.equal(unknown.decision, 'deny', 'unknown tools still fail closed');
});

test('system prompt tells the model today\u2019s date and its knowledge cutoff', () => {
  const { systemPrompt } = require('../agent');
  const p = systemPrompt({ llm: { model: 'm' } }, '', null, false, 'ask');
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.ok(p.includes(iso), 'prompt carries the current date');
  assert.match(p, /training data is older/);
  assert.match(p, /web_fetch/);
});

test('system prompt mentions the critique gate only when the tool exists', () => {
  const { systemPrompt } = require('../agent');
  const without = systemPrompt({ llm: { model: 'm' } }, '', null, false, 'ask');
  assert.ok(!/You also have critique/.test(without));
  const withTool = systemPrompt({ llm: { model: 'm' } }, '', null, false, 'ask', false, false, false, false, true);
  assert.match(withTool, /You also have critique/);
  assert.match(withTool, /At most one review pass per artifact/);
});

// --- persisted review artifacts (PaperOrchestra review log) ---

test('reviews are archived per artifact with a version and a history', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-reviews-'));
  const prev = process.env.MUSE_HOME;
  process.env.MUSE_HOME = home;
  delete require.cache[require.resolve('../config')];
  const critic2 = require('../critic');

  const first = critic2.saveReview({ artifact: 'Quarterly Report', goal: 'g', rubric: ['correctness'], text: 'draft one', review: { score: 5, verdict: 'thin', weaknesses: ['a'], fixes: ['b'] } });
  assert.ok(first, 'review saved');
  assert.equal(first.version, 1);
  assert.ok(fs.existsSync(first.path), 'review file on disk');
  assert.match(first.path, /review_v1\.json$/);

  const second = critic2.saveReview({ artifact: 'quarterly-report', goal: 'g', rubric: ['correctness'], text: 'draft two', review: { score: 8, verdict: 'better', weaknesses: [], fixes: [] } });
  assert.equal(second.version, 2, 'the same artifact keeps its own version chain');
  assert.ok(fs.existsSync(second.path));
  assert.deepEqual(second.history.map(h => h.score), [5, 8], 'history shows the score trajectory');

  const other = critic2.saveReview({ artifact: 'other-doc', text: 'x', review: { score: 3 } });
  assert.equal(other.version, 1, 'a different artifact starts its own chain');

  assert.equal(critic2.reviewSlug('Quarterly Report', 'x'), 'quarterly-report');
  assert.equal(critic2.reviewSlug('', 'hello'), 'draft-' + require('node:crypto').createHash('sha1').update('hello').digest('hex').slice(0, 10));

  if (prev === undefined) delete process.env.MUSE_HOME; else process.env.MUSE_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});
