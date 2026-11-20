const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-brief-'));
process.env.MUSE_HOME = home;
const { runBrief } = require('../research-brief');

// The orchestrator is exercised with a stubbed model and a stubbed scholarly
// index: the stage ORDER, the artifacts on disk, and the convergence rule
// are what matter here, not the network.
function stubIndex(papers) {
  return {
    paper: (id) => ({ ...papers.find(p => p.id === id) }),
  };
}

function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    chat: async (messages) => {
      calls.push(messages[1].content);
      const system = messages[0].content;
      const user = messages[1].content;
      let reply = replies.default || '{}';
      if (system.startsWith('You plan research briefs')) {
        reply = JSON.stringify({ goal: 'what the brief must establish', queries: ['long context retrieval', 'context pruning agents'], outline: [{ heading: 'Findings', covers: 'what the papers show' }] });
      } else if (system.startsWith('You take research notes')) {
        reply = JSON.stringify({ points: ['Retrieval cut cost by 40%', 'Pruning kept accuracy within 1 point'], relevance: 'directly informs the adoption decision' });
      } else if (system.startsWith('You write a research brief')) {
        reply = 'Long context beats retrieval for coding agents [1]. One run reports pruning wins [2].\n\n## Findings\n- retrieval is cheaper [1]\n- pruning is safer [2]';
      } else if (system.startsWith('You revise a research brief')) {
        reply = 'Long context beats retrieval for coding agents [1]. Pruning kept accuracy within 1 point and cut cost by 40% [2].\n\n## Findings\n- retrieval is cheaper [1]\n- pruning is safe [2]';
      }
      return { canonical: { text: reply }, message: { content: reply } };
    },
  };
}

function patchStubs(t) {
  const research = require('../research');
  const critic = require('../critic');
  const originalSearch = research.searchPapers;
  const originalRead = research.readPapers;
  const originalReview = critic.reviewText;
  const papers = [
    { id: 'arxiv:1', title: 'Long Context for Coding Agents', authors: 'A Author', year: 2025, venue: 'ICML', citations: 120, url: 'https://example.org/1', abstract: 'We compare long context and retrieval for coding agents across 40 tasks.' },
    { id: 'arxiv:2', title: 'Context Pruning for Agents', authors: 'B Author', year: 2024, venue: 'arXiv', citations: 40, url: 'https://example.org/2', abstract: 'We prune agent context and report cost and accuracy numbers.' },
  ];
  research.searchPapers = async (query) => ({ ok: true, backend: 'stub', total: papers.length, results: papers });
  research.readPapers = async (ids) => ids.map(id => papers.find(p => p.id === id)).filter(Boolean);
  critic.reviewText = async () => ({ ok: true, score: 7, verdict: 'solid but thin on evidence', weaknesses: ['only one number is cited'], fixes: ['add the cost number'], scores: {} });

  t.after(() => {
    research.searchPapers = originalSearch;
    research.readPapers = originalRead;
    critic.reviewText = originalReview;
  });
  // The model client is injected, so the test never touches the network.
  return { papers, clientFactory: () => fakeClient({ default: '{}' }) };
}

test('the orchestrator runs every stage and writes its artifacts', async (t) => {
  const stubs = patchStubs(t);
  const outDir = path.join(home, 'run-1');
  const stages = [];
  const res = await runBrief({ llm: { model: 'stub' } }, {
    clientFactory: stubs.clientFactory,
    topic: 'long context vs retrieval for coding agents',
    goal: 'what should we adopt',
    outDir,
    maxPapers: 4,
    ctx: { cfg: {}, tainted: false, netPolicy: {}, sentinel: null },
    onStage: (stage) => stages.push(stage),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  // plan -> search -> read -> draft -> critique -> revise
  assert.ok(stages.includes('plan'));
  assert.ok(stages.includes('search'));
  assert.ok(stages.includes('read'));
  assert.ok(stages.includes('draft'));
  assert.ok(stages.includes('critique'));
  assert.ok(stages.includes('revise'));

  // artifacts on disk
  assert.ok(fs.existsSync(path.join(outDir, 'outline.json')), 'outline written');
  assert.ok(fs.existsSync(path.join(outDir, 'papers.json')), 'papers written');
  assert.ok(fs.existsSync(path.join(outDir, 'notes.json')), 'notes written');
  assert.ok(fs.existsSync(path.join(outDir, 'run.json')), 'run receipt written');
  assert.ok(fs.existsSync(res.briefPath), 'brief written');

  const brief = fs.readFileSync(res.briefPath, 'utf8');
  assert.match(brief, /## References/, 'the brief ends with its sources');
  assert.match(brief, /\[1\] Long Context for Coding Agents/);
  assert.match(brief, /\[2\] Context Pruning for Agents/);

  // the citation map links each source to the claim it supports
  const sources = JSON.parse(fs.readFileSync(res.sourcesPath, 'utf8'));
  assert.equal(sources.sources.length, 2);
  assert.equal(sources.sources[0].index, 1);
  assert.ok(sources.sources[0].points.length >= 1, 'notes are carried into the map');
  assert.match(sources.sources[0].relevance, /adoption decision/);

  // the run receipt records the stages
  const run = JSON.parse(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8'));
  assert.equal(run.stages.plan.status, 'done');
  assert.equal(run.stages.draft.status, 'done');
  assert.equal(run.stages.done.status, 'done');
});

test('the refine loop stops when the score stops improving', async (t) => {
  const stubs = patchStubs(t);
  const critic = require('../critic');
  const scores = [6, 6];   // no improvement on the second round
  let call = 0;
  critic.reviewText = async () => {
    const score = scores[Math.min(call++, scores.length - 1)];
    return { ok: true, score, verdict: 'x', weaknesses: [], fixes: ['fix it'], scores: {} };
  };
  const outDir = path.join(home, 'run-2');
  const stages = [];
  const res = await runBrief({ llm: { model: 'stub' } }, {
    clientFactory: stubs.clientFactory,
    topic: 'convergence topic',
    outDir,
    maxRounds: 3,
    ctx: { cfg: {}, tainted: false, netPolicy: {}, sentinel: null },
    onStage: (stage) => stages.push(stage),
  });
  assert.equal(res.ok, true);
  assert.equal(res.score, 6);
  const converged = stages.filter(s => s === 'converged');
  assert.equal(converged.length, 1, 'the loop stopped once the score plateaued');
  // exactly two critiques (initial + one revise), not three
  assert.equal(stages.filter(s => s === 'critique').length, 2);
});

test('a good enough score stops the loop immediately', async (t) => {
  const stubs = patchStubs(t);
  const critic = require('../critic');
  critic.reviewText = async () => ({ ok: true, score: 9, verdict: 'good', weaknesses: [], fixes: [], scores: {} });
  const stages = [];
  const res = await runBrief({ llm: { model: 'stub' } }, {
    clientFactory: stubs.clientFactory,
    topic: 'good enough topic',
    outDir: path.join(home, 'run-3'),
    maxRounds: 3,
    ctx: { cfg: {}, tainted: false, netPolicy: {}, sentinel: null },
    onStage: (stage) => stages.push(stage),
  });
  assert.equal(res.ok, true);
  assert.equal(res.score, 9);
  assert.equal(stages.filter(s => s === 'revise').length, 0, 'no revision when the score is already high');
});

test('a failed stage is reported with its stage name', async (t) => {
  const stubs = patchStubs(t);
  const research = require('../research');
  research.searchPapers = async () => ({ ok: false, error: 'rate limited', code: 'RATE_LIMITED' });
  const res = await runBrief({ llm: { model: 'stub' } }, {
    clientFactory: stubs.clientFactory,
    topic: 'nothing found',
    outDir: path.join(home, 'run-4'),
    ctx: { cfg: {}, tainted: false, netPolicy: {}, sentinel: null },
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'search');
  assert.match(res.error, /no papers found/);
});
