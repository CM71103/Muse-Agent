'use strict';
// research.js — scholarly search for the agent (PaperOrchestra literature
// port).
//
// PaperOrchestra's literature agent searches, prioritizes, dedupes and keeps
// a citation map that later stages read as "data truth". Muse gets the same
// three capabilities, minus the LaTeX:
//
//   search_papers  — Semantic Scholar (+ arXiv for preprints); compact ranked
//                    list with a one-line takeaway and a short id
//   read_paper     — full metadata + abstract for the hits that matter
//   cite_source    — records a source against the artifact: which claim it
//                    supports and where it came from
//
// The archive lives in ~/.muse-agent/research/<artifact>/sources.json and
// raw API responses are cached for a day, so repeat searches cost nothing and
// keep working offline.
//
// Safety: metadata and abstracts only (public APIs), the same sentinel egress
// gate and SSRF guard as web_fetch, bounded results, and an honest
// {ok, error, code} failure shape.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const S2_HOST = 'api.semanticscholar.org';
const OPENALEX_HOST = 'api.openalex.org';
const ARXIV_HOST = 'export.arxiv.org';
const FIELDS = 'title,authors,year,venue,citationCount,externalIds,url,abstract,publicationTypes,openAccessPdf';
const MAX_RESULTS = 10;
const MAX_ABSSTRACT = 900;
const MAX_LIST_CHARS = 1800;      // the agent loop keeps ~2000 chars of a tool result
const MAX_DETAIL_CHARS = 1900;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_DELAY_MS = 1200;   // politeness: one upstream call at a time

function configDir() {
  try { return require('./config').configDir(); } catch { return ''; }
}
function researchRoot() {
  const dir = configDir();
  return dir ? path.join(dir, 'research') : '';
}
function slug(value, max = 48) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'artifact';
}

// --- config ---------------------------------------------------------------

function researchCfg(cfg) {
  const section = (cfg && cfg.research) || {};
  let key = String(section.semantic_scholar_api_key || '').trim();
  if (!key) {
    try { key = String(process.env.SEMANTIC_SCHOLAR_API_KEY || '').trim(); } catch { /* no env */ }
  }
  return {
    apiKey: key,
    maxResults: Math.min(10, Math.max(1, Number(section.max_results) || 6)),
    cacheTtlMs: Math.max(0, Number(section.cache_ttl_hours ?? 24) * 60 * 60 * 1000),
    includeArxiv: section.include_arxiv !== false,
    mailto: String(section.openalex_mailto || '').trim(),
    requestIntervalMs: Math.max(0, Number(section.request_interval_ms ?? UPSTREAM_DELAY_MS)),
  };
}

// --- cache ----------------------------------------------------------------

function cacheFile(url) {
  const root = researchRoot();
  if (!root) return '';
  return path.join(root, 'cache', crypto.createHash('sha1').update(url).digest('hex') + '.json');
}

function cacheRead(url, ttlMs) {
  const file = cacheFile(url);
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (ttlMs >= 0 && Date.now() - (raw.at || 0) > ttlMs) return null;
    return raw.body;
  } catch { return null; }
}

function cacheWrite(url, body) {
  const file = cacheFile(url);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), url, body }));
  } catch { /* a cache miss later is harmless */ }
}

// --- upstream -------------------------------------------------------------

let lastCall = 0;
async function politeWait(intervalMs = UPSTREAM_DELAY_MS) {
  if (!intervalMs) { lastCall = Date.now(); return; }
  const wait = lastCall + intervalMs - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

async function fetchJson(url, { ctx, cfg }) {
  // Policy BEFORE cache: a session that may not reach the host must fail
  // closed even if a cached copy is on disk.
  if (ctx && ctx.sentinel && !ctx.sentinel.egressAllowed(url, ctx.tainted)) {
    return { ok: false, error: `blocked: ${url} is not in the egress allowlist for this session`, code: 'BLOCKED' };
  }
  const cached = cacheRead(url, cfg.cacheTtlMs);
  if (cached) return { ok: true, body: cached, cached: true };
  if (ctx && ctx.sentinel) {
    const { assertPublicAddress } = require('./tools');
    try { await assertPublicAddress(new URL(url).hostname, ctx.netPolicy || { allowLocal: false }); }
    catch (e) { return { ok: false, error: String(e && e.message || e), code: 'BLOCKED' }; }
  }
  await politeWait(cfg.requestIntervalMs);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  const onAbort = () => ac.abort();
  try { if (ctx && ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true }); } catch { /* no signal */ }
  try {
    const headers = { 'User-Agent': 'Muse-Agent/0.1 (research; +https://github.com/CM71103/Muse-Agent)', Accept: 'application/json' };
    if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
    const res = await fetch(url, { signal: ac.signal, headers });
    if (res.status === 429) return { ok: false, error: 'the semantic scholar API rate limit was hit — wait a moment or set research.semantic_scholar_api_key', code: 'RATE_LIMITED' };
    if (res.status === 404) return { ok: false, error: 'not found', code: 'NOT_FOUND' };
    if (!res.ok) return { ok: false, error: `upstream returned HTTP ${res.status}`, code: 'UPSTREAM' };
    const body = await res.json();
    cacheWrite(url, body);
    return { ok: true, body };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'the search timed out', code: 'TIMEOUT' };
    return { ok: false, error: String(e && e.message || e), code: 'NETWORK' };
  } finally {
    clearTimeout(timer);
    try { if (ctx && ctx.signal) ctx.signal.removeEventListener('abort', onAbort); } catch { /* no signal */ }
  }
}

async function fetchText(url, { ctx, cfg }) {
  if (ctx && ctx.sentinel && !ctx.sentinel.egressAllowed(url, ctx.tainted)) {
    return { ok: false, error: `blocked: ${url} is not in the egress allowlist for this session`, code: 'BLOCKED' };
  }
  const cached = cacheRead(url, cfg.cacheTtlMs);
  if (cached) return { ok: true, body: cached, cached: true };
  await politeWait(cfg.requestIntervalMs);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Muse-Agent/0.1 (research)', Accept: 'application/atom+xml' } });
    if (!res.ok) return { ok: false, error: `upstream returned HTTP ${res.status}`, code: 'UPSTREAM' };
    const body = await res.text();
    cacheWrite(url, body);
    return { ok: true, body };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'the search timed out', code: 'TIMEOUT' };
    return { ok: false, error: String(e && e.message || e), code: 'NETWORK' };
  } finally { clearTimeout(timer); }
}

// --- shaping --------------------------------------------------------------

function firstSentence(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const m = clean.match(/^(.{40,320}?[.!?])(\s|$)/);
  return (m ? m[1] : clean.slice(0, 220)).trim();
}

function shortAuthors(paper) {
  const authors = Array.isArray(paper.authors) ? paper.authors.map(a => String(a && a.name || '').trim()).filter(Boolean) : [];
  if (!authors.length) return 'unknown author';
  if (authors.length <= 2) return authors.join(' & ');
  return `${authors[0]} et al.`;
}

function s2UrlFor(id) {
  const raw = String(id).replace(/^s2:/, '');
  const key = raw.startsWith('doi:') ? `DOI:${raw.slice(4)}`
    : raw.startsWith('arxiv:') ? `ARXIV:${raw.slice(6)}`
      : raw;
  return `https://${S2_HOST}/graph/v1/paper/${encodeURIComponent(key)}?fields=${FIELDS}`;
}

function paperId(paper) {
  const ext = paper.externalIds || {};
  if (ext.ArXiv) return `arxiv:${ext.ArXiv}`;
  if (ext.DOI) return `doi:${ext.DOI}`;
  return `s2:${paper.paperId || crypto.createHash('sha1').update(String(paper.title || '')).digest('hex').slice(0, 10)}`;
}

function shapePaper(paper) {
  const ext = paper.externalIds || {};
  const id = paperId(paper);
  return {
    id,
    title: String(paper.title || 'untitled').slice(0, 200),
    authors: shortAuthors(paper),
    year: Number(paper.year) || null,
    venue: String(paper.venue || '').slice(0, 80),
    citations: Number(paper.citationCount) || 0,
    doi: ext.DOI ? String(ext.DOI) : '',
    arxiv: ext.ArXiv ? String(ext.ArXiv) : '',
    url: String(paper.url || (ext.ArXiv ? `https://arxiv.org/abs/${ext.ArXiv}` : '')).slice(0, 300),
    abstract: String(paper.abstract || '').slice(0, MAX_ABSSTRACT),
  };
}

// OpenAlex works without an API key, which makes it the dependable backend
// when the semantic scholar pool is rate limited. Its abstracts arrive as an
// inverted index, so the text is rebuilt from the positions.
function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== 'object') return '';
  const slots = [];
  for (const word of Object.keys(index)) {
    const positions = Array.isArray(index[word]) ? index[word] : [];
    for (const pos of positions) {
      if (Number.isInteger(pos) && pos >= 0) slots.push([pos, word]);
    }
  }
  slots.sort((a, b) => a[0] - b[0]);
  const text = slots.map(([, word]) => word).join(' ').replace(/\s+/g, ' ').trim();
  // OpenAlex often stores the paper's citation header (author list + venue +
  // year) where the abstract should be. Passing that off as an abstract
  // would be worse than having none, so it is detected and dropped.
  if (looksLikeCitationHeader(text)) return '';
  return text;
}

function looksLikeCitationHeader(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  // "… Proceedings of the 2023 Conference on …" and friends.
  if (/\bproceedings of\b|\bin proceedings\b|\bto appear (at|in)\b|\barxiv preprint\b|\bpreprint\b/i.test(s)) return true;
  // Three or more "First Last" pairs in a row: an author list.
  if (/(?:[A-Z][a-z]+ [A-Z][a-z]+)(?:, [A-Z][a-z]+ [A-Z][a-z]+){2,}/.test(s)) return true;
  // Author list + venue + a trailing year.
  if (/\b(19|20)\d{2}\.?$/.test(s) && /[A-Z][a-z]+ [A-Z][a-z]+/.test(s) && s.length < 600) return true;
  return false;
}

function shapeOpenAlex(work) {
  const authors = Array.isArray(work.authorships)
    ? work.authorships.map(a => (a.author && a.author.display_name) || '').filter(Boolean)
    : [];
  const venue = (work.primary_location && work.primary_location.source && work.primary_location.source.display_name) || '';
  const doi = String(work.doi || '').replace(/^https?:\/\/doi\.org\//, '');
  const openAccess = work.open_access && work.open_access.oa_url;
  return shapePaper({
    title: work.title || work.display_name || 'untitled',
    authors: authors.map(name => ({ name })),
    year: Number(work.publication_year) || null,
    venue,
    citationCount: Number(work.cited_by_count) || 0,
    externalIds: { DOI: doi, ...(work.ids && work.ids.openalex ? { OpenAlex: String(work.ids.openalex) } : {}) },
    url: openAccess || (doi ? `https://doi.org/${doi}` : (work.id ? String(work.id) : '')),
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
  });
}

async function searchOpenAlex(query, limit, ctx, cfg) {
  const fields = 'id,title,display_name,publication_year,cited_by_count,doi,ids,open_access,primary_location,authorships,abstract_inverted_index';
  const params = new URLSearchParams({ search: query, 'per-page': String(limit), select: fields });
  if (cfg.mailto) params.set('mailto', cfg.mailto);
  const url = `https://${OPENALEX_HOST}/works?${params.toString()}`;
  const res = await fetchJson(url, { ctx, cfg });
  if (!res.ok) return res;
  const results = (res.body && Array.isArray(res.body.results) ? res.body.results : []).map(shapeOpenAlex);
  return { ok: true, results };
}

function parseArxiv(xml) {
  const out = [];
  const entries = String(xml || '').split('<entry>').slice(1);
  for (const entry of entries) {
    const pick = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : '';
    };
    const title = pick('title');
    const summary = pick('summary');
    const idUrl = pick('id');
    const published = pick('published');
    const authors = (entry.match(/<name>([\s\S]*?)<\/name>/g) || []).map(m => m.replace(/<\/?name>/g, '').trim());
    const arxivId = ((idUrl.match(/abs\/([^/]+)$/) || [])[1] || '').replace(/v\d+$/, '');
    if (!title) continue;
    out.push(shapePaper({
      title,
      abstract: summary,
      authors: authors.map(name => ({ name })),
      year: Number((published || '').slice(0, 4)) || null,
      venue: 'arXiv preprint',
      citationCount: 0,
      externalIds: { ArXiv: arxivId },
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : idUrl,
    }));
  }
  return out;
}

// --- search ---------------------------------------------------------------

async function searchPapers(query, opts, ctx) {
  const cfg = researchCfg(opts && opts.cfg);
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query must not be empty', code: 'BAD_INPUT' };
  const limit = Math.min(MAX_RESULTS, Math.max(1, Number(opts && opts.limit) || cfg.maxResults));
  const yearFrom = Number(opts && opts.year_from) || 0;

  const s2Url = `https://${S2_HOST}/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=${FIELDS}`;
  const errors = [];
  let papers = [];
  const backends = [];

  // Backend order: with an API key the semantic scholar index leads (best
  // coverage and clean abstracts); without one it is tried last, because the
  // keyless pool is heavily rate limited and answers 429.
  const order = [];
  if (cfg.apiKey) order.push('semantic scholar');
  order.push('openalex');
  if (cfg.includeArxiv) order.push('arxiv');
  if (!cfg.apiKey) order.push('semantic scholar');

  for (const name of order) {
    if (papers.length >= limit && name !== 'arxiv' && !(opts && opts.preprints)) break;
    if (name === 'semantic scholar') {
      const res = await fetchJson(s2Url, { ctx, cfg });
      if (!res.ok) { errors.push(res); continue; }
      const list = res.body && Array.isArray(res.body.data) ? res.body.data.map(shapePaper) : [];
      papers.push(...list);
      if (list.length) backends.push('semantic scholar');
    } else if (name === 'openalex') {
      const res = await searchOpenAlex(q, limit, ctx, cfg);
      if (!res.ok) { errors.push(res); continue; }
      papers.push(...res.results);
      if (res.results.length) backends.push('openalex');
    } else {
      // arXiv terms are ANDed: "retrieval augmented generation" must find
      // papers about all three words, not papers about one of them.
      const terms = q.match(/"[^"]+"|\S+/g) || [q];
      const expr = terms.length > 1 ? terms.map(t => `all:${t}`).join(' AND ') : `all:${terms[0]}`;
      const arxivUrl = `https://${ARXIV_HOST}/api/query?search_query=${encodeURIComponent(expr)}&start=0&max_results=${limit}&sortBy=relevance`;
      const ax = await fetchText(arxivUrl, { ctx, cfg });
      if (!ax.ok) { errors.push(ax); continue; }
      const list = parseArxiv(ax.body);
      papers.push(...list);
      if (list.length) backends.push('arxiv');
    }
  }

  // Dedupe across backends (same paper, two indexes).
  const seenTitles = new Set();
  let unique = [];
  for (const paper of papers) {
    const key = (paper.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (!key || seenTitles.has(key)) continue;
    seenTitles.add(key);
    unique.push(paper);
  }
  papers = unique;
  const backend = backends.length ? backends.join(' + ') : 'none';

  // Still nothing: report the real upstream failure, not a fake empty result.
  if (!papers.length && errors.length) return errors[0];

  let filtered = papers;
  if (yearFrom) filtered = filtered.filter(p => (p.year || 0) >= yearFrom);
  // Rank: citations first (a proxy for influence), then recency.
  filtered.sort((a, b) => (b.citations - a.citations) || ((b.year || 0) - (a.year || 0)));
  const results = filtered.slice(0, limit);
  return { ok: true, backend, total: papers.length, results };
}

function renderResults(results, backend) {
  const lines = [];
  for (const paper of results) {
    const meta = [paper.year || 'n.d.', paper.venue, paper.citations ? `${paper.citations} cites` : ''].filter(Boolean).join(' · ');
    lines.push(`[${paper.id}] ${paper.title} — ${paper.authors} (${meta})`);
    const takeaway = firstSentence(paper.abstract);
    if (takeaway) lines.push(`   ${takeaway}`);
    if (paper.url) lines.push(`   ${paper.url}`);
  }
  let text = lines.join('\n');
  if (text.length > MAX_LIST_CHARS) text = text.slice(0, MAX_LIST_CHARS - 1).trimEnd() + '…';
  return `Sources (${backend}) — ${results.length} result${results.length === 1 ? '' : 's'}:\n${text}\nPick the ones that matter and call read_paper for their full abstracts, then cite_source for the ones you use.`;
}

// --- citation store --------------------------------------------------------

function artifactDir(artifact) {
  const root = researchRoot();
  if (!root) return '';
  return path.join(root, 'artifacts', slug(artifact));
}

function readStore(artifact) {
  const dir = artifactDir(artifact);
  if (!dir) return { artifact: String(artifact || ''), sources: [] };
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8')); }
  catch { return { artifact: String(artifact || ''), sources: [] }; }
}

function saveSource(artifact, source) {
  const dir = artifactDir(artifact);
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const store = readStore(artifact);
    store.artifact = String(artifact || '').slice(0, 200);
    store.sources = Array.isArray(store.sources) ? store.sources : [];
    const existing = store.sources.find(s => s.id === source.id);
    if (existing) {
      existing.claim = source.claim || existing.claim;
      existing.quote = source.quote || existing.quote;
      existing.updated_at = new Date().toISOString();
    } else {
      store.sources.push({ ...source, added_at: new Date().toISOString() });
    }
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(store, null, 2));
    return store;
  } catch { return null; }
}

function renderStore(store) {
  const sources = Array.isArray(store.sources) ? store.sources : [];
  if (!sources.length) return 'No sources recorded for this artifact yet.';
  const lines = sources.map(s => {
    const bits = [`[${s.id}] ${s.title || 'untitled'}`, s.year || '', s.venue || ''].filter(Boolean).join(' — ');
    return `${bits}\n   claim: ${s.claim || '(not stated)'}${s.quote ? `\n   quote: ${s.quote}` : ''}`;
  });
  let text = lines.join('\n');
  if (text.length > MAX_DETAIL_CHARS) text = text.slice(0, MAX_DETAIL_CHARS - 1).trimEnd() + '…';
  return `Recorded sources for ${store.artifact || 'this artifact'} (${sources.length}):\n${text}`;
}

// --- tools -----------------------------------------------------------------

function mkResearchTools() {
  const searchTool = {
    name: 'search_papers',
    description:
      'Search scholarly sources (Semantic Scholar, plus arXiv for preprints) and get a compact ranked list: title, authors, year, venue, citations, a one-line takeaway and an id. ' +
      'Use it before asserting anything about research, benchmarks, prior art or "best practice" in a technical field; the model\'s own knowledge may predate the work. ' +
      'Read the promising hits with read_paper, then record the ones you actually rely on with cite_source. Results are cached for a day.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (topic, method, benchmark, author)' },
        limit: { type: 'number', description: 'How many results, default 6, max 10' },
        year_from: { type: 'number', description: 'Only papers published in this year or later' },
        preprints: { type: 'boolean', description: 'Include arXiv preprints even when there are enough results' },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const res = await searchPapers(args.query, { ...args, cfg: ctx.cfg }, ctx);
      if (!res.ok) return { ok: false, error: res.error, code: res.code };
      if (!res.results.length) return { ok: false, error: 'no matching papers — try a broader query or fewer filters', code: 'EMPTY' };
      return { ok: true, text: renderResults(res.results, res.backend), count: res.results.length };
    },
  };

  const readTool = {
    name: 'read_paper',
    description:
      'Get the full record for papers found with search_papers: full abstract, authors, venue, year, citation count, DOI/arXiv id and link. ' +
      'Read the two or three that matter before you rely on a claim.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Paper ids from search_papers (e.g. ["arxiv:1706.03762"])' } },
      required: ['ids'],
    },
    async run(args, ctx) {
      const ids = (Array.isArray(args.ids) ? args.ids : []).map(String).slice(0, 3);
      if (!ids.length) return { ok: false, error: 'ids must not be empty', code: 'BAD_INPUT' };
      const cfg = researchCfg(ctx.cfg);
      const blocks = [];
      for (const id of ids) {
        // The semantic scholar index has the cleanest abstracts. OpenAlex is
        // the fallback (metadata only for some records).
        let paper = null;
        const s2 = await fetchJson(s2UrlFor(id), { ctx, cfg });
        if (s2.ok && s2.body) paper = shapePaper(s2.body);
        if (!paper && id.startsWith('doi:')) {
          const oa = await fetchJson(`https://${OPENALEX_HOST}/works/https://doi.org/${encodeURIComponent(id.slice(4))}`, { ctx, cfg });
          if (oa.ok && oa.body) paper = shapeOpenAlex(oa.body);
        }
        if (!paper) { blocks.push(`[${id}] unavailable (no index has this record right now)`); continue; }
        blocks.push(`[${paper.id}] ${paper.title}\n   ${paper.authors} · ${paper.year || 'n.d.'} · ${paper.venue || 'unknown venue'} · ${paper.citations} cites\n   ${paper.abstract || '(no abstract available in the index — take the metadata and the link, not a guess)'}\n   ${paper.url}`);
      }
      let text = blocks.join('\n\n');
      if (text.length > MAX_DETAIL_CHARS) text = text.slice(0, MAX_DETAIL_CHARS - 1).trimEnd() + '…';
      return { ok: true, text };
    },
  };

  const citeTool = {
    name: 'cite_source',
    description:
      'Record a source you relied on, against the artifact you are writing. Keeps the paper id, title, year, url and the exact claim it supports (plus a short quote). ' +
      'The artifact\'s source list is the record of what the answer is based on — cite every paper you actually used, and nothing you did not.',
    parameters: {
      type: 'object',
      properties: {
        artifact: { type: 'string', description: 'What you are writing (stable label, e.g. "retrieval-vs-long-context")' },
        id: { type: 'string', description: 'Paper id from search_papers, e.g. "arxiv:1706.03762"' },
        title: { type: 'string', description: 'Paper title' },
        year: { type: 'number', description: 'Publication year' },
        url: { type: 'string', description: 'Link to the paper' },
        claim: { type: 'string', description: 'The specific claim this source supports in your answer' },
        quote: { type: 'string', description: 'Short verbatim quote supporting the claim (optional but preferred)' },
      },
      required: ['artifact', 'id', 'title'],
    },
    async run(args, ctx) {
      const store = saveSource(args.artifact, {
        id: String(args.id).slice(0, 120),
        title: String(args.title).slice(0, 300),
        year: Number(args.year) || null,
        url: String(args.url || '').slice(0, 300),
        claim: String(args.claim || '').slice(0, 600),
        quote: String(args.quote || '').slice(0, 400),
      });
      const current = store || readStore(args.artifact);
      return { ok: true, text: renderStore(current), saved: !!store };
    },
  };

  return [searchTool, readTool, citeTool];
}

function researchTools() {
  return mkResearchTools();
}

module.exports = {
  researchTools, mkResearchTools, searchPapers, parseArxiv, shapePaper,
  shapeOpenAlex, abstractFromInvertedIndex, looksLikeCitationHeader, s2UrlFor,
  saveSource, readStore, researchCfg, researchRoot, MAX_RESULTS,
};
