// scripts/research-brief.mts - run the research orchestrator from a terminal.
//
//   node scripts/research-brief.mts "long context vs retrieval for coding agents"
//   node scripts/research-brief.mts "topic" --goal "what should we adopt" --papers 8
//   node scripts/research-brief.mts "topic" --print
//
// Keys: MUSE_LLM_API_KEY (or llm.api_key in config.toml) for the model, and
// SEMANTIC_SCHOLAR_API_KEY (or [research].semantic_scholar_api_key) for the
// scholarly index. The app stores its key in the OS credential store, which a
// plain node process cannot read - export it here for CLI runs.

import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');

function arg(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

const topic = process.argv.slice(2).filter(a => !a.startsWith('--') && a !== arg('--goal') && a !== arg('--papers') && a !== arg('--out'))[0];
if (!topic || has('--help')) {
  console.log(`Usage: node scripts/research-brief.mts "<topic>" [options]

Options:
  --goal "<text>"   what the brief must establish
  --papers <n>      how many papers to read (2-10, default 6)
  --out "<dir>"     output folder (default ~/.muse-agent/briefs/<topic>-<stamp>)
  --rounds <n>      critique/revise rounds (1-3, default 2)
  --print           print the finished brief to the terminal
  --no-revise       skip the critique/revise stage

Keys: MUSE_LLM_API_KEY, SEMANTIC_SCHOLAR_API_KEY (or config.toml).`);
  process.exit(topic ? 0 : 1);
}

const { loadConfig } = require(path.join(root, 'app/harness/config.js'));
const { runBrief } = require(path.join(root, 'app/harness/research-brief.js'));
const { apiKey } = require(path.join(root, 'app/harness/config.js'));

const cfg = loadConfig();
if (!apiKey(cfg)) {
  console.error('No chat model key found.\n  Set MUSE_LLM_API_KEY, or put llm.api_key in ~/.muse-agent/config.toml\n  (the app stores its key in the OS credential store, which a terminal cannot read).');
  process.exit(2);
}
if (!cfg.research) cfg.research = {};
if (!cfg.research.semantic_scholar_api_key && process.env.SEMANTIC_SCHOLAR_API_KEY) {
  cfg.research.semantic_scholar_api_key = process.env.SEMANTIC_SCHOLAR_API_KEY;
}

// Minimal policy context: public hosts only, no local addresses, no taint.
const ctx = {
  cfg,
  tainted: false,
  netPolicy: { allowLocal: false },
  sentinel: {
    egressAllowed: () => true,
    decide: () => ({ decision: 'allow' }),
  },
};

const STAGE_LABEL = {
  start: 'start', 'plan': 'plan', 'search': 'search', 'search-progress': 'search', 'search-warning': 'search',
  read: 'read', 'read-progress': 'read', draft: 'draft', critique: 'critique', revise: 'revise',
  converged: 'converged', error: 'error', done: 'done',
};

console.log(`\n  Muse research brief`);
console.log(`  topic: ${topic}`);
console.log(`  model: ${cfg.llm.model}${cfg.llm.review_model ? ` (reviewer: ${cfg.llm.review_model})` : ''}`);
console.log(`  semantic scholar key: ${cfg.research.semantic_scholar_api_key ? 'yes' : 'no (free pool)'}\n`);

const started = Date.now();
const result = await runBrief(cfg, {
  topic,
  goal: arg('--goal'),
  maxPapers: Number(arg('--papers', '6')) || 6,
  maxRounds: has('--no-revise') ? 0 : (Number(arg('--rounds', '2')) || 2),
  outDir: arg('--out') || undefined,
  ctx,
  onStage: (stage, payload) => {
    const label = STAGE_LABEL[stage] || stage;
    if (stage === 'search-warning') console.log(`  ! ${label}: ${payload.query} - ${payload.error}`);
    else if (stage === 'search-progress') console.log(`  . search "${payload.query}" (${payload.found} found)`);
    else if (stage === 'read-progress') console.log(`  . read ${payload.read}/${payload.total}`);
    else if (stage === 'start') console.log(`  . out: ${payload.outDir}`);
    else if (stage === 'plan') console.log(`  . ${payload.queries.length} queries, ${payload.outline.length} sections`);
    else if (stage === 'search') console.log(`  . ${payload.count} papers selected`);
    else if (stage === 'read') console.log(`  . ${payload.count} papers read`);
    else if (stage === 'draft') console.log(`  . draft (${payload.chars} chars)`);
    else if (stage === 'critique') console.log(`  . critique ${payload.ok ? `score ${payload.score}/10` : 'failed'}`);
    else if (stage === 'revise') console.log(`  . revised (${payload.chars} chars)`);
    else if (stage === 'converged') console.log(`  . converged (${payload.score}/10${payload.reason ? ' - ' + payload.reason : ''})`);
    else if (stage === 'error') console.log(`  ! ${payload.message}`);
    else if (stage === 'done') console.log(`  . done (${payload.score}/10)`);
  },
});

if (!result.ok) {
  console.error(`\n  FAILED at ${result.stage}: ${result.error}\n`);
  process.exit(1);
}

console.log(`\n  Score: ${result.score != null ? result.score + '/10' : 'n/a'}   Papers: ${result.papers}`);
console.log(`  Brief:     ${result.briefPath}`);
console.log(`  Citation map: ${result.sourcesPath}`);
console.log(`  Notes:     ${result.notesPath}`);
console.log(`  Took ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

if (has('--print')) {
  const fs = require('node:fs');
  console.log(fs.readFileSync(result.briefPath, 'utf8'));
}
