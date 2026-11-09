'use strict';
// citation-integration.test.js - end-to-end citation contract through the real
// Agent loop and the real MemoryLayer, against a mock OpenAI-compatible server
// that serves BOTH /embeddings and /chat/completions (recorded-response style:
// the chat reply is a fixed provider-shaped body, no live network, no keys).
//
// Covers the five links in the chain, any one of which silently kills the
// feedback loop:
//   1. retrieved memories reach the model WITH [cN] markers and an instruction
//      to cite them
//   2. the model's cited markers survive into the returned text
//   3. parseCitations maps markers back to the right memory ids
//   4. /good moves S for cited rows and F for packed-but-uncited rows
//   5. rows that were never packed get no evidence at all
//
// Run: node --test app/harness/test/citation-integration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// isolate session/credential writes before the harness modules resolve paths
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-cite-'));
process.env.MUSE_HOME = HOME;

const { DEFAULTS, deepMerge } = require('../config');
const { MemoryLayer } = require('../../memory/layer');
const { Agent } = require('../agent');

// ---------- mock provider ----------

let port = 0;
let server = null;
let embedCounter = 0;
const chatScript = [];      // [{content}] consumed one per /chat/completions call
const chatRequests = [];    // every request body the agent actually sent

// deterministic all-positive unit vectors, same generator as memory.test.js so
// cosine ordering is stable and both planted rows clear score_cutoff
function unitVec(seed) {
  const v = [(seed % 7) + 1, ((seed * 3) % 5) + 1, ((seed * 7) % 3) + 1, 1];
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / n);
}

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (req.url.endsWith('/embeddings')) {
        const texts = (JSON.parse(body || '{}').input) || [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: texts.map((_, i) => ({ index: i, embedding: unitVec(embedCounter + i + 1) })),
          model: 'test-embed-model',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }));
        embedCounter += texts.length;
        return;
      }
      chatRequests.push(JSON.parse(body || '{}'));
      const s = chatScript.shift();
      if (!s) { res.writeHead(500); res.end('chat script exhausted'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: s.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        model: 'test-chat-model',
      }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

test.after(() => {
  if (server) { server.close(); if (server.closeAllConnections) server.closeAllConnections(); }
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ---------- fixtures ----------

// adaptive_ranking ON so grades actually move evidence. Baseline mode records
// grades without applying them, which would make requirements 4 and 5 vacuous.
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muse-cite-db-${crypto.randomBytes(4).toString('hex')}-`));
  const cfg = deepMerge(DEFAULTS, {
    llm: {
      base_url: `http://127.0.0.1:${port}/v1`,
      api_key: 'test-key',
      api_key_env: 'MUSE_TEST_KEY_UNUSED',
      model: 'test-chat-model',
      temperature: 0,
      max_tokens: 200,
      context_tokens: 200000,
      retry_attempts: 1,
    },
    agent: { max_turns: 5, approval_timeout_s: 5 },
    sentinel: { deny_rules: [] },
    hands: { enabled: false },
    bridge: { enabled: false },
    memory: {
      enabled: true,
      budget_tokens: 1200,
      score_cutoff: 0.20,
      project_id_strategy: 'manual',
      embed_model: 'test-embed-model',
      embed_dims: 4,
      adaptive_ranking: true,
    },
  });
  const mem = new MemoryLayer(cfg, {
    dataDir: dir,
    projectId: 'cite-proj',
    embedBaseUrl: `http://127.0.0.1:${port}/v1`,
    embedApiKey: 'test-key',
  });
  t.after(() => { mem.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { cfg, mem };
}

// plant a fully-formed active row directly (bypasses ingest/embed, pins the vector)
function plantRow(mem, o) {
  const ts = new Date().toISOString();
  const active = o.status === undefined || o.status === 'active';
  const row = {
    id: o.id,
    project_id: mem.projectId,
    agent_id: 'desktop',
    channel: 'desktop',
    provenance: 'user',
    trust_tier: 'user',
    type: 'fact',
    text: o.text,
    embedding: active ? unitVec(o.seed) : null,
    model_pin: active ? 'test-embed-model' : null,
    generation: 'v1',
    dims: active ? 4 : null,
    created_at: ts,
    updated_at: ts,
    status: o.status || 'active',
    injection_risk: 0,
    source_event_id: `plant:${o.id}`,
    evidence: o.evidence || {},
  };
  mem.store.insertMemory(row);
  return row;
}

// Evidence context key follows the ACTIVE flags: 'default' when clustering is
// off, 'cluster-N' when on. Config defaults are now adaptive-on, so resolve
// from the layer's own flags instead of assuming 'default'.
function ev(mem, id) {
  const e = (mem.store.getMemory(id) || {}).evidence || {};
  const key = mem.flags.query_clustering ? require('../../memory/core/policy').contextKey(0) : 'default';
  return e[key] || { S: 0, F: 0, cited_n: 0, packed_n: 0 };
}

// ---------- the chain ----------

test('citation chain: markers sent with instruction, model cites, parser maps ids, /good splits S and F, unpacked rows untouched', async (t) => {
  const { cfg, mem } = setup(t);
  // m1 packs and gets cited. m2 packs and does NOT get cited. m3 is quarantined
  // so the packer hard-filters it and it must never see evidence.
  plantRow(mem, { id: 'm1', text: 'The cat is named Mango', seed: 1 });
  plantRow(mem, { id: 'm2', text: 'Deployment runs via pnpm build', seed: 2 });
  plantRow(mem, { id: 'm3', text: 'quarantined secret note', seed: 3, status: 'quarantined' });

  // the recorded provider reply cites ONLY [c1]
  chatScript.push({ content: 'Your cat is named Mango [c1].' });

  const agent = new Agent(cfg, { onEvent: () => {} });
  agent.attachMemory(mem);

  const res = await agent.run('What is my cat called?');

  // --- 1. what actually reached the model ---
  assert.equal(chatRequests.length, 1, 'one provider call');
  const sent = chatRequests[0].messages;
  const systems = sent.filter(m => m.role === 'system');
  assert.equal(systems.length, 1, 'providers reject a second system message');
  assert.equal(systems[0], sent[0], 'system message stays at position 0');
  const block = systems[0].content;
  assert.match(block, /PROJECT MEMORY/, 'memory block present in the system message');
  assert.match(block, /\[c1\] source=user trust=user The cat is named Mango/, 'marker 1 with provenance and trust labels');
  assert.match(block, /\[c2\] source=user trust=user Deployment runs via pnpm build/, 'marker 2');
  assert.doesNotMatch(block, /\[c3\]/, 'quarantined row never sent');
  assert.match(block, /\[END PROJECT MEMORY\]/, 'block is closed');
  // the instruction is what makes real citations possible at all: markers
  // without a request to use them produce responses that never cite
  assert.match(block, /cite/i, 'model is told to cite the markers');
  assert.match(block, /\[c1\]/, 'citation format is spelled out with a concrete example');

  // positions are deterministic here: m1 outscores m2, so m1 is [c1]
  const turn = mem.store.getTurn(res.memory_turn_id);
  assert.equal(turn.state, 'completed', 'turn completed, so it is grade-eligible');
  assert.deepEqual(turn.citation_map, { 1: 'm1', 2: 'm2' });
  assert.deepEqual(turn.sent_ids, ['m1', 'm2']);

  // --- 2. the citation survived into the agent's returned text ---
  assert.match(res.text, /\[c1\]/);

  // --- 3. parser maps markers to ids, and refuses invented or repeated ones ---
  const parsed = mem.parseCitations(res.text, res.memory_turn_id);
  assert.deepEqual(parsed.citedIds, ['m1'], 'only the cited row is credited');
  assert.deepEqual(parsed.anomalies, []);
  const forged = mem.parseCitations('Mango [c1] plus [c9] again [c1]', res.memory_turn_id);
  assert.deepEqual(forged.citedIds, ['m1'], 'a marker outside the pack credits nothing');
  assert.deepEqual(forged.anomalies, [
    { marker: 'c9', reason: 'unknown_position' },
    { marker: 'c1', reason: 'duplicate' },
  ]);

  // --- 4. /good moves S for the cited row, F for the packed-uncited row ---
  const g = mem.grade(res.memory_turn_id, 1);
  assert.equal(g.ok, true);
  assert.equal(g.applied, true, 'adaptive_ranking is on, so the grade applies');
  // replenish decay runs after each completed turn, so counters sit epsilon
  // away from their integer values. Compare with tolerance, not equality.
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const e1 = ev(mem, 'm1');
  const e2 = ev(mem, 'm2');
  assert.ok(near(e1.S, 1), `cited row gains S, got ${e1.S}`);
  assert.ok(near(e1.F, 0), `cited row gains no F, got ${e1.F}`);
  assert.equal(e1.cited_n, 1);
  assert.ok(near(e2.S, 0), `packed-but-uncited row must NOT gain S, got ${e2.S}`);
  assert.ok(near(e2.F, 0.25), `packed-but-uncited row gains eps*r, got F=${e2.F}`);
  assert.equal(e2.cited_n, 0);
  assert.ok(e2.packed_n >= 1, 'audit counter still records the packing');

  // grading is one-shot and immutable
  assert.equal(mem.grade(res.memory_turn_id, 1).reason, 'already_graded');

  // --- 5. a row that was never packed gets no evidence whatsoever ---
  assert.deepEqual(mem.store.getMemory('m3').evidence, {}, 'unpacked row untouched');
  assert.equal(mem.store.getMemory('m3').status, 'quarantined');

  // and the graded split is visible in the posterior the next turn would use
  // derive() takes the whole context-keyed evidence map, not one counter block
  const { derive } = require('../../memory/core/posterior');
  const ekey = mem.flags.query_clustering ? 'cluster-0' : 'default';
  const p1 = derive(mem.store.getMemory('m1').evidence, ekey, 'fact');
  const p2 = derive(mem.store.getMemory('m2').evidence, ekey, 'fact');
  assert.ok(p1.mu > p2.mu, `cited row now ranks above uncited row (${p1.mu} vs ${p2.mu})`);
});

test('memory block is byte-stable across the send, so the hash check cannot spuriously repack', async (t) => {
  const { cfg, mem } = setup(t);
  plantRow(mem, { id: 'm1', text: 'The cat is named Mango', seed: 1 });
  chatScript.push({ content: 'Mango [c1].' });

  const agent = new Agent(cfg, { onEvent: () => {} });
  agent.attachMemory(mem);
  const res = await agent.run('What is my cat called?');

  const turn = mem.store.getTurn(res.memory_turn_id);
  assert.equal(turn.state, 'completed', 'a stable block means no payload_changed_before_send');
  assert.equal(turn.membership_known, true);
  assert.match(turn.payload_hash, /^sha256:[a-f0-9]{64}$/);
  // the block the agent hashed is what the provider saw
  const seen = chatRequests[chatRequests.length - 1].messages[0].content;
  assert.ok(seen.includes('[c1] source=user'), 'hashed block matches the wire block');
});
