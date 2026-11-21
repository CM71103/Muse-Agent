'use strict';
// critic.js — the review/reflection gate (PaperOrchestra port).
//
// PaperOrchestra's key insight: a writer model alone does not produce
// submission-ready work. It runs a SEPARATE reviewer pass with a rubric and
// a score, then a refine loop that stops when the score stops improving.
//
// Muse port: a `critique` tool that reviews a draft (message, report, code
// summary, dashboard spec) against explicit axes and returns a score plus
// concrete, actionable fixes. The agent fixes what it can and stops when the
// score no longer improves.
//
// Notes:
//   - the reviewer may run on a different model (llm.review_model); it falls
//     back to the chat model. PaperOrchestra uses a separate reflection model
//     for exactly this reason.
//   - read-class tool: it never mutates anything. It only spends a model call,
//     so the sentinel treats it like spawn_agent (a cost, not a side effect).
//   - output is capped so it survives the agent loop's 2000-char tool-result
//     window without losing the actionable part.

const { LlmClient } = require('./llm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CHARS = 40000;            // input cap (bounded cost)
const MAX_AXES = 6;
const MAX_ITEMS = 5;
const MAX_ITEM_CHARS = 240;

const DEFAULT_AXES = ['correctness', 'completeness', 'clarity', 'conciseness'];

function clampText(v, n) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Extract the first balanced JSON object from a model reply (the model may
// wrap it in ```json fences or add prose around it).
function parseCritique(raw) {
  const text = String(raw || '');
  let candidate = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidate = fenced[1];
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function normalizeCritique(parsed, axes) {
  if (!parsed || typeof parsed !== 'object') return null;
  const scores = {};
  const rawScores = parsed.scores && typeof parsed.scores === 'object' ? parsed.scores : {};
  for (const axis of axes) {
    const v = Number(rawScores[axis] != null ? rawScores[axis] : parsed[axis]);
    scores[axis] = Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : null;
  }
  const listed = Array.isArray(parsed.scores) ? parsed.scores : [];
  const overall = Number(parsed.score != null ? parsed.score : (listed[0] && listed[0].score));
  const items = (arr) => (Array.isArray(arr) ? arr : [])
    .slice(0, MAX_ITEMS)
    .map(x => clampText(typeof x === 'string' ? x : (x && (x.fix || x.issue || x.problem)) || '', MAX_ITEM_CHARS))
    .filter(Boolean);
  return {
    score: Number.isFinite(overall) ? Math.max(0, Math.min(10, overall)) : null,
    scores,
    verdict: clampText(parsed.verdict || parsed.summary || '', MAX_ITEM_CHARS),
    weaknesses: items(parsed.weaknesses || parsed.issues || parsed.problems),
    fixes: items(parsed.fixes || parsed.suggestions || parsed.recommendations),
  };
}

function reviewerCfg(cfg) {
  const reviewModel = cfg && cfg.llm && cfg.llm.review_model;
  if (!reviewModel) return cfg;
  return { ...cfg, llm: { ...cfg.llm, model: reviewModel, temperature: 0.2 } };
}

function criticSystemPrompt(axes, hasStyle) {
  const axisList = axes.map(a => `- ${a}`).join('\n');
  return [
    'You are a strict but fair reviewer. You never write the deliverable yourself: you review it and hand back concrete fixes.',
    '',
    'Score each axis from 0 (broken) to 10 (excellent):',
    axisList,
    '',
    'Rules:',
    '- Judge only what is in front of you. Never invent facts to praise or to fault.',
    '- Every weakness must name the concrete thing that is wrong (quote or point at it).',
    '- Every fix must be actionable and specific enough to apply without re-reading the whole text.',
    '- Report at most 5 weaknesses and 5 fixes; rank them by impact.',
    hasStyle
      ? '- One axis may be "tone fit": does the reply match the style this user prefers (length, structure, directness, no AI filler)?'
      : '- Judge tone fit against plain, direct writing: no filler intros, no restating the question, no summarizing what you just said.',
    '',
    'Reply with ONLY a JSON object, no prose around it:',
    '{"score": 0-10, "scores": {"axis": 0-10}, "verdict": "one short sentence", "weaknesses": ["..."], "fixes": ["..."]}',
  ].join('\n');
}

// Review a draft. Returns {ok:true, ...review} or {ok:false, error}.
async function reviewText(cfg, text, opts = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return { ok: false, error: 'nothing to review (empty text)' };
  const truncated = raw.length > MAX_CHARS;
  const body = truncated ? raw.slice(0, MAX_CHARS) : raw;
  const axes = (Array.isArray(opts.rubric) && opts.rubric.length
    ? opts.rubric
    : DEFAULT_AXES
  ).map(a => String(a).slice(0, 40)).slice(0, MAX_AXES);

  const goal = opts.goal ? String(opts.goal).slice(0, 2000) : '(not specified)';
  const userMsg = [
    `GOAL the piece must satisfy:\n${goal}`,
    '',
    `DRAFT TO REVIEW${truncated ? ` (truncated to the first ${MAX_CHARS} chars)`: ''}:`,
    '---',
    body,
    '---',
  ].join('\n');

  const client = opts.client || new LlmClient(reviewerCfg(cfg));
  let reply;
  try {
    const res = await client.chat(
      [{ role: 'system', content: criticSystemPrompt(axes, !!opts.hasStyle) }, { role: 'user', content: userMsg }],
      [],
      { signal: opts.signal }
    );
    reply = (res && res.canonical && res.canonical.text) || (res && res.message && res.message.content) || '';
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  const parsed = parseCritique(reply);
  const review = normalizeCritique(parsed, axes);
  if (!review) return { ok: false, error: 'reviewer did not return usable JSON' };
  return { ok: true, ...review, truncated };
}

function mkCritiqueTool() {
  return {
    name: 'critique',
    description:
      'Review a draft against explicit axes and get back a score, ranked weaknesses and concrete fixes. ' +
      'Use it on long or important output (reports, plans, summaries, code explanations, docs) before calling the work done. ' +
      'Apply the fixes, then critique again only if the score is still low: stop when the score stops improving. ' +
      'Never use it on trivial replies: it costs a model call.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The draft to review' },
        goal: { type: 'string', description: 'What the draft must accomplish (why it exists, who it is for)' },
        artifact: { type: 'string', description: 'Stable label for the thing being reviewed (e.g. "quarterly-report" or a file path). Reviews of the same artifact are archived together so the iteration history is visible.' },
        rubric: {
          type: 'array',
          items: { type: 'string' },
          description: 'Review axes to score, e.g. ["correctness","completeness","clarity","tone fit"]. Defaults to a standard set.',
        },
      },
      required: ['text'],
    },
    async run(args, ctx) {
      let style = false;
      try { style = !!require('./voice').voiceGuide(); } catch { /* style profile optional */ }
      const res = await reviewText(ctx.cfg, args.text, {
        goal: args.goal,
        rubric: args.rubric,
        signal: ctx.signal,
        hasStyle: style,
      });
      if (!res.ok) return { ok: false, error: res.error };
      // Compact: the agent loop keeps only the first 2000 chars of a tool
      // result, so the actionable part has to fit.
      const trim = (arr) => (arr || []).slice(0, 4).map(s => clampText(s, 200));
      const saved = saveReview({
        artifact: args.artifact,
        goal: args.goal,
        rubric: args.rubric,
        text: args.text,
        review: res,
      });
      const out = {
        ok: true,
        score: res.score,
        verdict: res.verdict,
        weaknesses: trim(res.weaknesses),
        fixes: trim(res.fixes),
      };
      if (saved) {
        out.version = saved.version;
        // Previous rounds of the same artifact: the agent can see whether the
        // score is actually climbing and stop when it is not.
        out.history = saved.history.map(h => `v${h.version}: ${h.score}`);
      }
      return out;
    },
  };
}

function critiqueTools() {
  return [mkCritiqueTool()];
}

// --- persisted review artifacts ---------------------------------------------
// PaperOrchestra keeps every review pass on disk (review_v0.json,
// review_v1.json, ...) and feeds the previous log back into the refine
// prompt. Muse does the same, so a draft's review history survives the
// session: the agent can see whether the score is actually climbing.

function reviewsRoot() {
  try { return path.join(require('./config').configDir(), 'reviews'); } catch { return ''; }
}

function reviewSlug(artifact, text) {
  const raw = String(artifact || '').trim();
  if (raw) {
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (slug) return slug;
  }
  return 'draft-' + crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10);
}

function readHistory(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8')); }
  catch { return []; }
}

// Save one review pass and return {path, version, history}.
function saveReview({ artifact, goal, rubric, text, review }) {
  const root = reviewsRoot();
  if (!root) return null;
  try {
    const dir = path.join(root, reviewSlug(artifact, text));
    fs.mkdirSync(dir, { recursive: true });
    const history = readHistory(dir);
    const version = history.reduce((max, h) => Math.max(max, Number(h.version) || 0), 0) + 1;
    const record = {
      version,
      at: new Date().toISOString(),
      artifact: String(artifact || '').slice(0, 200),
      goal: String(goal || '').slice(0, 2000),
      rubric: Array.isArray(rubric) ? rubric.map(String).slice(0, 6) : [],
      score: review && typeof review.score === 'number' ? review.score : null,
      verdict: (review && review.verdict) || '',
      weaknesses: (review && review.weaknesses) || [],
      fixes: (review && review.fixes) || [],
    };
    const file = path.join(dir, `review_v${version}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    history.push({ version, at: record.at, score: record.score });
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history.slice(-50), null, 2));
    return { path: file, version, history: history.slice(-5) };
  } catch {
    return null;   // a review that cannot be archived is still a valid review
  }
}

function reviewHistory(artifact, text) {
  const root = reviewsRoot();
  if (!root) return [];
  try {
    const dir = path.join(root, reviewSlug(artifact, text));
    return readHistory(dir).slice(-5);
  } catch { return []; }
}

module.exports = {
  reviewText, parseCritique, normalizeCritique, mkCritiqueTool, critiqueTools,
  saveReview, reviewHistory, reviewSlug, DEFAULT_AXES, MAX_CHARS,
};
