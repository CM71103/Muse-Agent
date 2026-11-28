'use strict';
// research-brief.js - the PaperOrchestra orchestrator, in Muse.
//
// PaperOrchestra's write_single_paper() runs: outline -> literature ->
// section writing -> content refinement, refining until the reviewer score
// stops improving. Muse runs the same shape over any topic:
//
//   plan    -> turn the topic into search queries and a section outline
//   search  -> query the scholarly indexes, dedupe, rank
//   read    -> pull the papers that matter and take notes on each
//   draft   -> write the brief, citing [n] markers
//   critique-> a reviewer scores it (optionally a different model)
//   revise  -> apply the fixes, and stop when the score stops climbing
//
// Every stage writes its output to disk and lands in run.json, so a run is
// inspectable and resumable after a crash. The result is a brief plus the
// citation map that says which source supports which claim.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { LlmClient } = require('./llm');
const research = require('./research');
const critic = require('./critic');

// --- helpers ---------------------------------------------------------------

function slug(value, max = 48) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'brief';
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function textOf(res) {
  return (res && res.canonical && res.canonical.text) || (res && res.message && res.message.content) || '';
}

// The model client is created through a factory so a caller (or a test) can
// supply its own - the orchestrator never reaches for a global.
function clientFor(cfg, deps = {}) {
  if (deps && typeof deps.clientFactory === 'function') return deps.clientFactory(cfg);
  const { LlmClient } = require('./llm');
  return new LlmClient(cfg);
}

async function ask(client, { system, user, signal, temperature }) {
  const res = await client.chat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    [],
    { signal, temperature }
  );
  return textOf(res);
}

function extractJson(raw) {
  return critic.parseCritique(raw);   // shared tolerant JSON extractor
}

// --- stages ----------------------------------------------------------------

const PLAN_SYSTEM = `You plan research briefs. Reply with ONLY a JSON object:
{"goal": "one sentence: what the brief must establish",
 "queries": ["3 to 5 distinct scholarly search queries, each 2-6 words, no stopwords"],
 "outline": [{"heading": "section title", "covers": "what that section must contain"}]}`;

async function stagePlan(cfg, { topic, goal }, { onStage, signal, clientFactory }) {
  const client = clientFor(cfg, { clientFactory });
  const raw = await ask(client, {
    system: PLAN_SYSTEM,
    user: `Topic: ${topic}\n${goal ? `The reader's goal: ${goal}\n`: ''}Plan the brief. The queries must be real search queries a scholar would type.`,
    signal,
  });
  const parsed = extractJson(raw) || {};
  const queries = (Array.isArray(parsed.queries) ? parsed.queries : []).map(q => String(q).trim()).filter(Boolean).slice(0, 5);
  const outline = (Array.isArray(parsed.outline) ? parsed.outline : [])
    .map(o => ({ heading: String(o && o.heading || '').slice(0, 120), covers: String(o && o.covers || '').slice(0, 400) }))
    .filter(o => o.heading)
    .slice(0, 10);
  if (!queries.length) queries.push(String(topic).slice(0, 120));
  if (!outline.length) outline.push({ heading: String(topic).slice(0, 120), covers: String(goal || 'the topic').slice(0, 400) });
  onStage('plan', { queries, outline });
  return { goal: String(parsed.goal || goal || topic).slice(0, 400), queries, outline };
}

async function stageSearch(cfg, plan, { onStage, signal, ctx, maxPapers }) {
  const found = new Map();
  for (const query of plan.queries) {
    const res = await research.searchPapers(query, { cfg, limit: 6 }, ctx);
    if (!res.ok) { onStage('search-warning', { query, error: res.error, code: res.code }); continue; }
    for (const paper of res.results) {
      const key = (paper.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
      if (!key || found.has(key)) continue;
      found.set(key, paper);
    }
    onStage('search-progress', { query, found: found.size });
    if (found.size >= maxPapers * 2) break;
  }
  const papers = [...found.values()]
    .sort((a, b) => (b.citations - a.citations) || ((b.year || 0) - (a.year || 0)))
    .slice(0, maxPapers);
  onStage('search', { count: papers.length });
  return papers;
}

const NOTE_SYSTEM = `You take research notes on a single paper. Reply with ONLY JSON:
{"points": ["1-3 concrete findings or claims, each <= 200 chars, in the paper's own terms"],
 "relevance": "one sentence: why this matters for the brief"}`;

async function stageRead(cfg, papers, { onStage, signal, ctx, clientFactory }) {
  const options = { clientFactory };
  const notes = [];
  for (let i = 0; i < papers.length; i += 3) {
    const chunk = papers.slice(i, i + 3);
    const details = await research.readPapers(chunk.map(p => p.id), ctx, research.researchCfg(cfg));
    for (const paper of details) {
      if (!paper.abstract) {
        notes.push({ id: paper.id, title: paper.title, year: paper.year, venue: paper.venue, url: paper.url, authors: paper.authors, points: [], relevance: '', abstract_missing: true });
        continue;
      }
      let points = [];
      let relevance = '';
      try {
        const client = clientFor(cfg, { clientFactory: options.clientFactory });
        const raw = await ask(client, {
          system: NOTE_SYSTEM,
          user: `Paper: ${paper.title} (${paper.year || 'n.d.'}, ${paper.venue || 'unknown venue'})\nAbstract: ${paper.abstract.slice(0, 2500)}\n\nTake notes.`,
          signal,
          temperature: 0.2,
        });
        const parsed = extractJson(raw) || {};
        points = (Array.isArray(parsed.points) ? parsed.points : []).map(p => String(p).slice(0, 240)).filter(Boolean).slice(0, 3);
        relevance = String(parsed.relevance || '').slice(0, 300);
      } catch { /* notes are best effort - the abstract is still cited */ }
      notes.push({ id: paper.id, title: paper.title, year: paper.year, venue: paper.venue, url: paper.url, authors: paper.authors, points, relevance });
    }
    onStage('read-progress', { read: Math.min(i + 3, papers.length), total: papers.length });
  }
  onStage('read', { count: notes.length });
  return notes;
}

const DRAFT_SYSTEM = `You write a research brief that is grounded in the notes you are given.
Rules:
- Use ONLY the notes. Never add a fact, number, or claim that is not in them.
- Cite every claim with the bracketed marker of its source, like [1] or [2][3].
- If the notes do not support a point, say it is not covered by the sources.
- Plain markdown. No LaTeX. Lead with the conclusion, then the evidence.
- Say plainly how strong the evidence is (how many sources agree, whether they are preprints).`;

function draftPrompt(plan, notes) {
  const blocks = notes.map((n, i) => [
    `[${i + 1}] ${n.title} (${n.year || 'n.d.'}, ${n.venue || 'unknown venue'}): ${n.authors || 'unknown authors'}`,
    n.abstract_missing ? '  (no abstract available in the index)' : (n.points || []).map(p => `  - ${p}`).join('\n'),
    n.relevance ? `  relevance: ${n.relevance}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    `TOPIC: ${plan.topic}`,
    `THE BRIEF MUST ESTABLISH: ${plan.goal}`,
    `SECTIONS:\n${plan.outline.map(s => `- ${s.heading}: ${s.covers}`).join('\n')}`,
    `SOURCES (use these markers [n]):\n${blocks}`,
    '',
    'Write the brief.',
  ].join('\n');
}

async function stageDraft(cfg, { topic, goal, outline, notes }, { onStage, signal, clientFactory }) {
  const client = clientFor(cfg, { clientFactory });
  const plan = { topic, goal, outline, notes };
  const raw = await ask(client, { system: DRAFT_SYSTEM, user: draftPrompt(plan, notes), signal });
  const brief = String(raw || '').trim();
  onStage('draft', { chars: brief.length });
  return brief;
}

function referencesFrom(notes) {
  return notes.map((n, i) => {
    const year = n.year || 'n.d.';
    const venue = n.venue ? `, ${n.venue}` : '';
    const link = n.url ? `: ${n.url}` : '';
    return `[${i + 1}] ${n.title}. ${n.authors || 'Unknown authors'}. ${year}${venue}.${link}`;
  }).join('\n');
}

async function stageCritique(cfg, brief, { onStage, signal }) {
  const reviewerCfg = cfg.llm && cfg.llm.review_model
    ? { ...cfg, llm: { ...cfg.llm, model: cfg.llm.review_model } }
    : cfg;
  const res = await critic.reviewText(reviewerCfg, brief, {
    goal: 'a research brief that is fully grounded in its sources',
    rubric: ['correctness', 'evidence', 'completeness', 'clarity'],
    signal,
  });
  onStage('critique', { ok: res.ok, score: res.score });
  return res;
}

async function stageRevise(cfg, brief, review, { onStage, signal, clientFactory }) {
  if (!review || !review.ok) return { brief, applied: [], skipped: true };
  const client = clientFor(cfg, { clientFactory });
  const raw = await ask(client, {
    system: 'You revise a research brief using a reviewer\'s notes. Apply the fixes that matter; keep the citations accurate; do not add facts that are not in the brief\'s sources. Reply with ONLY the revised brief in markdown.',
    user: `REVIEWER SCORE: ${review.score}\nVERDICT: ${review.verdict || ''}\nWEAKNESSES:\n${(review.weaknesses || []).map(w => `- ${w}`).join('\n') || '- none'}\nFIXES:\n${(review.fixes || []).map(f => `- ${f}`).join('\n') || '- none'}\n\nCURRENT BRIEF:\n${brief.slice(0, 40000)}`,
    signal,
  });
  const revised = String(raw || '').trim();
  onStage('revise', { chars: revised.length });
  return { brief: revised || brief, applied: (review.fixes || []).slice(0, 8), skipped: false };
}

// --- the run ---------------------------------------------------------------

async function runBrief(cfg, options = {}) {
  const topic = String(options.topic || '').trim();
  if (!topic) return { ok: false, error: 'a topic is required' };
  const outDir = options.outDir || path.join(require('./config').configDir(), 'briefs', `${slug(topic)}-${Date.now().toString(36)}`);
  const maxPapers = Math.min(10, Math.max(2, Number(options.maxPapers) || 6));
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  const signal = options.signal;
  const ctx = options.ctx || { cfg, sentinel: null, tainted: false, netPolicy: { allowLocal: false } };

  fs.mkdirSync(outDir, { recursive: true });
  const runFile = path.join(outDir, 'run.json');
  const run = readJson(runFile) || { topic, started_at: new Date().toISOString(), stages: {} };

  const mark = (name, status, extra = {}) => {
    run.stages[name] = { status, at: new Date().toISOString(), ...extra };
    writeJson(runFile, run);
  };

  onStage('start', { topic, outDir, maxPapers });

  // 1. plan
  let plan;
  try {
    plan = await stagePlan(cfg, { topic, goal: options.goal }, { onStage, signal, clientFactory: options.clientFactory });
    writeJson(path.join(outDir, 'outline.json'), plan);
    mark('plan', 'done', { queries: plan.queries.length, sections: plan.outline.length });
  } catch (e) {
    mark('plan', 'failed', { error: String(e && e.message || e) });
    return { ok: false, stage: 'plan', error: String(e && e.message || e), outDir };
  }

  // 2. search
  let papers;
  try {
    papers = await stageSearch(cfg, plan, { onStage, signal, ctx, maxPapers });
    writeJson(path.join(outDir, 'papers.json'), papers);
    mark('search', 'done', { papers: papers.length });
  } catch (e) {
    mark('search', 'failed', { error: String(e && e.message || e) });
    return { ok: false, stage: 'search', error: String(e && e.message || e), outDir };
  }
  if (!papers.length) {
    mark('search', 'empty');
    onStage('error', { message: 'no papers found - the scholarly indexes may be rate limited, or the topic is too narrow' });
    return { ok: false, stage: 'search', error: 'no papers found', outDir };
  }

  // 3. read + take notes
  let notes;
  try {
    notes = await stageRead(cfg, papers, { onStage, signal, ctx, clientFactory: options.clientFactory });
    writeJson(path.join(outDir, 'notes.json'), notes);
    mark('read', 'done', { notes: notes.length });
  } catch (e) {
    mark('read', 'failed', { error: String(e && e.message || e) });
    return { ok: false, stage: 'read', error: String(e && e.message || e), outDir };
  }

  // 4. draft
  let brief;
  try {
    brief = await stageDraft(cfg, { topic, goal: plan.goal, outline: plan.outline, notes }, { onStage, signal, clientFactory: options.clientFactory });
    mark('draft', 'done', { chars: brief.length });
  } catch (e) {
    mark('draft', 'failed', { error: String(e && e.message || e) });
    return { ok: false, stage: 'draft', error: String(e && e.message || e), outDir };
  }

  // 5. critique + 6. revise (bounded, and only while the score is climbing)
  const reviews = [];
  let score = null;
  const maxRounds = Math.min(3, Math.max(1, Number(options.maxRounds) || 2));
  for (let round = 1; round <= maxRounds; round++) {
    const review = await stageCritique(cfg, brief, { onStage, signal });
    reviews.push(review);
    if (!review.ok) { mark('critique', 'failed', { error: review.error }); break; }
    score = review.score;
    const saved = critic.saveReview({ artifact: `brief:${slug(topic)}`, goal: plan.goal, rubric: ['correctness', 'evidence', 'completeness', 'clarity'], text: brief, review });
    mark('critique', 'done', { round, score, version: saved && saved.version });
    // Convergence: a good enough score, or a score that stopped climbing, ends
    // the loop. Drafts must not churn for the sake of a number.
    if (typeof score === 'number' && score >= (options.acceptScore ?? 8)) { onStage('converged', { score }); break; }
    const previous = reviews.length > 1 ? reviews[reviews.length - 2].score : null;
    if (round > 1 && typeof previous === 'number' && typeof score === 'number' && score <= previous) {
      onStage('converged', { score, reason: 'the score stopped improving' });
      break;
    }
    if (round === maxRounds) break;
    const revised = await stageRevise(cfg, brief, review, { onStage, signal, clientFactory: options.clientFactory });
    brief = revised.brief;
    writeJson(path.join(outDir, 'brief.md'), brief);
  }

  // outputs
  const finalText = `${brief}\n\n## References\n\n${referencesFrom(notes)}\n`;
  const briefPath = path.join(outDir, 'brief.md');
  fs.writeFileSync(briefPath, finalText);

  // the citation map, in the same place the developer's other artifacts live
  const artifactKey = slug(topic);
  const store = { artifact: artifactKey, topic, generated_at: new Date().toISOString(), sources: notes.map((n, i) => ({
    index: i + 1,
    id: n.id,
    title: n.title,
    authors: n.authors || '',
    year: n.year || null,
    venue: n.venue || '',
    url: n.url || '',
    points: n.points || [],
    relevance: n.relevance || '',
    abstract_missing: !!n.abstract_missing,
  })) };
  writeJson(path.join(outDir, 'sources.json'), store);
  const homeStore = research.saveSource(`brief:${artifactKey}`, {
    id: notes[0] ? notes[0].id : 'brief',
    title: topic,
    year: null,
    url: briefPath,
    claim: `Research brief: ${topic}${score !== null ? ` (review ${score}/10)`: ''}`,
  });
  mark('done', 'done', { score, chars: brief.length });
  onStage('done', { score, briefPath, sources: notes.length });

  return {
    ok: true,
    outDir,
    briefPath,
    sourcesPath: path.join(outDir, 'sources.json'),
    notesPath: path.join(outDir, 'notes.json'),
    score,
    papers: notes.length,
    citations: homeStore ? homeStore.sources.length : 0,
  };
}

// The agent-facing tool: one call runs the whole pipeline and returns the
// brief, so "research X for me" starts the real thing instead of ad-hoc fetches.
function mkResearchBriefTool() {
  return {
    name: 'research_brief',
    description: 'Run the full research pipeline on a topic: plan queries, read papers from the scholarly indexes, draft a cited brief, review it and revise it. Writes the brief to disk and returns it. Takes minutes and several model calls.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'what the brief is about' },
        goal: { type: 'string', description: 'optional: what the brief must answer or decide' },
        papers: { type: 'integer', description: 'papers to read, 2-10 (default 6)' },
        rounds: { type: 'integer', description: 'review rounds, 1-3 (default 2)' },
      },
      required: ['topic'],
    },
    async run(args, ctx) {
      if (!args || typeof args.topic !== 'string' || !args.topic.trim()) return { ok: false, error: 'a topic is required' };
      const emit = (text) => { try { if (ctx.agent && typeof ctx.agent.events === 'function') ctx.agent.events({ type: 'info', text }); } catch {} };
      const seen = new Set();
      const onStage = (stage, data = {}) => {
        if (seen.has(stage)) return;
        seen.add(stage);
        if (stage === 'start') emit(`research brief: planning "${String(args.topic).slice(0, 80)}"`);
        else if (stage === 'search') emit(`research brief: found ${data.count} papers`);
        else if (stage === 'read') emit(`research brief: read ${data.count} papers, drafting`);
        else if (stage === 'critique') emit(`research brief: review ${data.score == null ? 'unavailable' : `${data.score}/10`}`);
        else if (stage === 'error') emit(`research brief: ${data.message}`);
      };
      const res = await runBrief(ctx.cfg, {
        topic: args.topic,
        goal: args.goal,
        maxPapers: args.papers,
        maxRounds: args.rounds,
        signal: ctx.signal,
        onStage,
        ctx: { cfg: ctx.cfg, sentinel: ctx.sentinel, tainted: ctx.tainted, netPolicy: ctx.netPolicy },
      });
      if (!res.ok) return { ok: false, stage: res.stage, error: res.error, outDir: res.outDir };
      let brief = '';
      try { brief = fs.readFileSync(res.briefPath, 'utf8'); } catch {}
      return {
        ok: true,
        topic: args.topic,
        briefPath: res.briefPath,
        outDir: res.outDir,
        score: res.score,
        papers: res.papers,
        brief: brief.length > 12000 ? `${brief.slice(0, 12000)}\n[truncated; the full brief is in ${res.briefPath}]` : brief,
      };
    },
  };
}

module.exports = { runBrief, mkResearchBriefTool, slug };
