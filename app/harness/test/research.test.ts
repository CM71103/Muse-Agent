const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-research-'));
process.env.MUSE_HOME = home;
const research = require('../research');
const { Sentinel } = require('../sentinel');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// Real-looking payload from the Semantic Scholar graph API.
const S2_PAYLOAD = {
  data: [
    {
      paperId: 'abc123',
      title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP',
      authors: [{ name: 'Patrick Lewis' }, { name: 'Ethan Perez' }, { name: 'Aleksandra Piktus' }],
      year: 2020,
      venue: 'NeurIPS',
      citationCount: 12000,
      externalIds: { DOI: '10.48550/arXiv.2005.11401', ArXiv: '2005.11401' },
      url: 'https://arxiv.org/abs/2005.11401',
      abstract: 'Large pre-trained language models are storehouses of knowledge from the internet. ' +
        'To make up for the outdated parametric knowledge, we retrieve relevant documents and combine with them. ' +
        'We find that retrieval helps on knowledge-intensive tasks.',
    },
    {
      paperId: 'def456',
      title: 'The False Promise of Imitating Proprietary LLMs',
      authors: [{ name: 'A Study' }],
      year: 2023,
      venue: 'arXiv',
      citationCount: 900,
      externalIds: { ArXiv: '2305.00001' },
      url: 'https://arxiv.org/abs/2305.00001',
      abstract: 'We compare imitation models against the actual proprietary models they imitate.',
    },
  ],
};

function fakeFetch(payload, calls) {
  return async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => (typeof payload === 'function' ? payload(String(url)) : payload),
      text: async () => (typeof payload === 'string' ? payload : ''),
    };
  };
}

function ctxFor(cfg) {
  const sentinel = new Sentinel({ sentinel: { mode: 'auto', deny_rules: [], egress_allowlist: [] }, agent: {} });
  // request_interval_ms 0 keeps the tests fast (no politeness delay).
  return { cfg: cfg || { llm: { model: 'm' }, research: { request_interval_ms: 0 } }, sentinel, tainted: false, netPolicy: { allowLocal: false } };
}

test('search_papers returns a compact ranked list with ids and takeaways', async () => {
  const calls = [];
  const original = globalThis.fetch;
  // Hermetic: a machine-level SEMANTIC_SCHOLAR_API_KEY makes the keyed index
  // lead by design, which is not what this keyless ordering test is about.
  const savedKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  globalThis.fetch = fakeFetch(S2_PAYLOAD, calls);
  try {
    const ctx = ctxFor();
    const res = await research.searchPapers('retrieval augmented generation', { cfg: ctx.cfg }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].id, 'arxiv:2005.11401', 'papers are identified by arXiv id when present');
    // Without an API key the openalex index leads (the semantic scholar pool
    // is rate limited); the keyless S2 search is only a last resort.
    assert.match(calls[0], /api\.openalex\.org/);
    assert.ok(calls.some(u => /semanticscholar/.test(u)), 'semantic scholar is still consulted as a fallback');
  } finally {
    globalThis.fetch = original;
    if (savedKey !== undefined) process.env.SEMANTIC_SCHOLAR_API_KEY = savedKey;
  }
});

test('results respect the year filter and the result cap', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch(S2_PAYLOAD, []);
  try {
    const ctx = ctxFor();
    const recent = await research.searchPapers('year-filter-query', { year_from: 2022, cfg: ctx.cfg }, ctx);
    assert.equal(recent.results.length, 1);
    assert.equal(recent.results[0].year, 2023);
    const capped = await research.searchPapers('cap-query', { limit: 10, cfg: ctx.cfg }, ctx);
    assert.ok(capped.results.length <= research.MAX_RESULTS);
  } finally { globalThis.fetch = original; }
});

test('arXiv preprints are parsed and merged without duplicates', async () => {
  const atom = `<?xml version="1.0"?><feed><entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <published>2024-01-02T00:00:00Z</published>
    <title>Retrieval Benchmarks 2024</title>
    <summary>A benchmark of retrieval systems. It covers many datasets and reports cost numbers.</summary>
    <author><name>Jane Doe</name></author>
  </entry></feed>`;
  const papers = research.parseArxiv(atom);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].id, 'arxiv:2401.00001');
  assert.equal(papers[0].year, 2024);
  assert.equal(papers[0].venue, 'arXiv preprint');
  assert.match(papers[0].abstract, /benchmark of retrieval/);
});

test('a failing upstream is reported honestly with a code', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  try {
    const ctx = ctxFor();
    const res = await research.searchPapers('rate-limited-query', { cfg: ctx.cfg }, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'RATE_LIMITED');
    assert.match(res.error, /rate limit/i);
    assert.match(res.error, /API key|preprint index/i, 'the message says how to get unblocked');
  } finally { globalThis.fetch = original; }
});

test('a tainted session is still bound by the egress allowlist', async () => {
  const sentinel = new Sentinel({
    sentinel: { mode: 'auto', deny_rules: [], egress_allowlist: ['wikipedia.org'] },
    agent: {},
  });
  const ctx = { cfg: { llm: {} }, sentinel, tainted: true, netPolicy: { allowLocal: false } };
  const res = await research.searchPapers('blocked-query', { cfg: ctx.cfg }, ctx);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BLOCKED');
  assert.match(res.error, /egress allowlist/);
});

test('sources are recorded per artifact and re-read with their claims', async () => {
  const saved = research.saveSource('retrieval-vs-long-context', {
    id: 'arxiv:2005.11401', title: 'RAG for Knowledge-Intensive NLP', year: 2020,
    url: 'https://arxiv.org/abs/2005.11401', claim: 'Retrieval beats parametric memory on knowledge-intensive tasks.', quote: 'retrieval helps',
  });
  assert.ok(saved, 'source saved');
  assert.equal(saved.sources.length, 1);
  assert.equal(saved.sources[0].claim, 'Retrieval beats parametric memory on knowledge-intensive tasks.');

  const again = research.saveSource('retrieval-vs-long-context', {
    id: 'arxiv:2305.00001', title: 'False Promise', year: 2023, claim: 'Imitation lags the real model.',
  });
  assert.equal(again.sources.length, 2, 'a second source appends to the same artifact');
  assert.equal(research.readStore('retrieval-vs-long-context').sources.length, 2);

  const other = research.readStore('a-different-artifact');
  assert.equal(other.sources.length, 0, 'artifacts keep separate source lists');
});

test('the three research tools are registered with their contracts', () => {
  const { buildTools } = require('../tools');
  const { tools } = buildTools({ llm: { model: 'm' }, sentinel: { mode: 'ask' }, agent: {} });
  const search = tools.find(t => t.name === 'search_papers');
  const read = tools.find(t => t.name === 'read_paper');
  const cite = tools.find(t => t.name === 'cite_source');
  assert.ok(search && read && cite, 'all three research tools are registered');
  assert.deepEqual(search.parameters.required, ['query']);
  assert.deepEqual(read.parameters.required, ['ids']);
  assert.deepEqual(cite.parameters.required, ['artifact', 'id', 'title']);
});

test('research tools are network/side-effect class: they ask in Ask mode', () => {
  const s = new Sentinel({ sentinel: { mode: 'ask', deny_rules: [] }, agent: {} });
  const decision = s.decide({ tool: 'search_papers', args: { query: 'x' } });
  assert.equal(decision.decision, 'ask');
  const auto = new Sentinel({ sentinel: { mode: 'auto', deny_rules: [] }, agent: {} });
  assert.equal(auto.decide({ tool: 'search_papers', args: { query: 'x' } }).decision, 'allow');
  const plan = new Sentinel({ sentinel: { mode: 'plan', deny_rules: [] }, agent: {} });
  assert.equal(plan.decide({ tool: 'search_papers', args: { query: 'x' } }).decision, 'deny', 'plan mode blocks the network');
});

test('the system prompt advertises research only when the tools exist', () => {
  const { systemPrompt } = require('../agent');
  const without = systemPrompt({ llm: { model: 'm' } }, '', null, false, 'ask');
  assert.ok(!/search_papers/.test(without));
  const withTools = systemPrompt({ llm: { model: 'm' } }, '', null, false, 'ask', false, false, false, false, false, true);
  assert.match(withTools, /search_papers/);
  assert.match(withTools, /cite_source/);
});

// --- openalex backend ------------------------------------------------------

test('openalex abstracts are rebuilt from the inverted index', () => {
  const index = { Hello: [0], world: [1], again: [2] };
  // exported indirectly through the shaping path
  const work = {
    title: 'A Study',
    publication_year: 2024,
    cited_by_count: 12,
    doi: 'https://doi.org/10.1234/abc',
    ids: { openalex: 'https://openalex.org/W123' },
    open_access: { oa_url: 'https://example.org/paper.pdf' },
    primary_location: { source: { display_name: 'A Venue' } },
    authorships: [{ author: { display_name: 'Ada Lovelace' } }],
    abstract_inverted_index: index,
  };
  const paper = research.shapeOpenAlex(work);
  assert.equal(paper.id, 'doi:10.1234/abc');
  assert.equal(paper.year, 2024);
  assert.equal(paper.citations, 12);
  assert.equal(paper.venue, 'A Venue');
  assert.equal(paper.authors, 'Ada Lovelace');
  assert.equal(paper.url, 'https://example.org/paper.pdf');
  assert.equal(paper.abstract, 'Hello world again');
});

test('a citation header stored as an abstract is dropped, not passed off as prose', () => {
  const work = {
    title: 'Active Retrieval Augmented Generation',
    publication_year: 2023,
    cited_by_count: 1878,
    authorships: [{ author: { display_name: 'Zhengbao Jiang' } }],
    abstract_inverted_index: {
      Zhengbao: [0], Jiang: [1], Frank: [2], Xu: [3], Proceedings: [4], of: [5], the: [6], 2023: [7], Conference: [8],
    },
  };
  const paper = research.shapeOpenAlex(work);
  assert.equal(paper.abstract, '', 'a header masquerading as an abstract must not survive');
});

test('the semantic scholar detail URL is built per id flavour', () => {
  assert.match(research.s2UrlFor('arxiv:2005.11401'), /paper\/ARXIV%3A2005\.11401/);
  assert.match(research.s2UrlFor('doi:10.1234/abc'), /paper\/DOI%3A10\.1234%2Fabc/);
  assert.match(research.s2UrlFor('abc123'), /paper\/abc123/);
});

test('a configured research key is used by the researcher', () => {
  const cfg = research.researchCfg({ research: { semantic_scholar_api_key: 'dummy-s2-key', openalex_api_key: 'dummy-oa-key' } });
  assert.equal(cfg.apiKey, 'dummy-s2-key');
  assert.equal(cfg.openAlexKey, 'dummy-oa-key');
});

test('the environment can supply the semantic scholar key', () => {
  const previous = process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.SEMANTIC_SCHOLAR_API_KEY = 'from-env';
  try {
    assert.equal(research.researchCfg({ research: {} }).apiKey, 'from-env');
    assert.equal(research.researchCfg({ research: { semantic_scholar_api_key: 'explicit' } }).apiKey, 'explicit', 'an explicit key wins over the environment');
  } finally {
    if (previous === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = previous;
  }
});

test('the openalex api key is sent as a query parameter', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch({ results: [] }, calls);
  try {
    const ctx = ctxFor({ llm: {}, research: { request_interval_ms: 0, openalex_api_key: 'oa-secret' } });
    await research.searchPapers('openalex-key-check', { cfg: ctx.cfg }, ctx);
    // Match the HOST, not the bare word: the query text itself contains
    // "openalex", which made the semantic scholar URL match and masked which
    // call was being asserted on.
    const oa = calls.find(u => /api\.openalex\.org/.test(u));
    assert.ok(oa, 'openalex was called');
    assert.match(oa, /api_key=oa-secret/);
  } finally { globalThis.fetch = original; }
});

test('a rate limited index is retried once before giving up', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => S2_PAYLOAD, text: async () => '' };
  };
  try {
    const ctx = ctxFor();
    const res = await research.searchPapers('retry-check', { cfg: ctx.cfg }, ctx);
    assert.equal(res.ok, true, 'the retry recovered the search');
    assert.ok(calls >= 2, 'the rate limited call was retried');
  } finally { globalThis.fetch = original; }
});

test('the arxiv expression drops stopwords and keeps the distinctive terms', () => {
  // ANDing a stopword matches nothing: 'long context versus retrieval for
  // coding agents' must not become all:versus AND all:for.
  const expr = research.arxivExpression('long context versus retrieval for coding agents');
  assert.ok(!/all:versus/.test(expr), 'stopwords are dropped');
  assert.ok(!/all:for/.test(expr), 'stopwords are dropped');
  assert.match(expr, /all:retrieval/);
  assert.match(expr, /all:context/);
  assert.match(expr, / AND /, 'terms are ANDed, not ORed');
});

test('a quoted query is used as an exact phrase', () => {
  assert.equal(research.arxivExpression('"retrieval augmented generation"'), 'all:"retrieval augmented generation"');
});
