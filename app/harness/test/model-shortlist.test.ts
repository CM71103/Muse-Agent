import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Agent } = require('../agent.js');
const { DEFAULTS, deepMerge, loadConfig, apiKey } = require('../config.js');
const { writeSections } = require('../configWrite.js');
const { originOf } = require('../models.js');
const helpers = require('../../main/connection-settings.ts');
const main = fs.readFileSync(path.join(__dirname, '../../main/index.js'), 'utf8');

function fixture(t: TestContext, options: any = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-shortlist-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.toml');
  const cfg = deepMerge(DEFAULTS, { llm: { base_url: 'https://chat.fixture/v1', model: 'current',
    ...(options.models === undefined ? {} : { visible_models: options.models }) },
    memory: { embed_base_url: 'https://embed.fixture/v1', llm_model: options.extractionModel || '' } });
  writeSections(cfg, file);
  const secure = () => {
    const current = loadConfig(file);
    current.llm.api_key = 'synthetic-chat-key'; current.llm.key_origin = 'https://chat.fixture';
    current.memory.embed_api_key = 'synthetic-embedding-key';
    return current;
  };
  const agent = new Agent(secure());
  agent.history.push({ role: 'user', content: 'Preserve this conversation' });
  agent.sentinel.grants.push('fixture-grant'); agent.tainted = true;
  agent.memory = { cfg: agent.cfg, memCfg: agent.cfg.memory, xllm: helpers.extractionConfig(agent.cfg),
    emb: { baseUrl: cfg.memory.embed_base_url, apiKey: 'synthetic-embedding-key', model: cfg.memory.embed_model,
      generation: cfg.memory.embed_generation || 'v1' },
    close: () => { throw new Error('Model selection must never close memory'); } };
  const writes: string[] = [];
  const context: any = {
    agent: options.noAgent ? null : agent, agentBusy: false, pendingApprovals: new Map(),
    requireTrusted: () => {}, secureConfig: secure, loadConfig: () => loadConfig(file),
    ensureConfigFile: () => { throw new Error('Must use active config path'); }, userConfigFile: () => file,
    apiKeyOf: apiKey, originOf, process, send: () => {},
    require: (name: string) => {
      if (name === './connection-settings.ts') return helpers;
      if (name === '../harness/configWrite') return { writeSections: (next: any, target: string) => {
        if (context.failWrite) throw new Error('fixture persistence failed');
        writes.push(target); writeSections(next, target);
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  // Config:get calls ensureConfigFile to seed missing installs; this fixture
  // already has an active file and never writes outside its temporary root.
  context.ensureConfigFile = () => file;
  const bind = (channel: string, args: string) => {
    const start = `ipcMain.handle('${channel}', async (${args}) => {`;
    const offset = main.indexOf(start); assert.notEqual(offset, -1);
    const body = main.slice(offset + start.length).split('\n});')[0];
    return vm.runInNewContext(`(async(${args})=>{${body}})`, context);
  };
  const select = bind('model:select', 'e, requestedModel');
  const save = bind('settings:save', 'e, patch');
  const settings = bind('settings:get', 'e');
  const summary = bind('config:get', 'e');
  const expiryBody = main.match(/a\.sentinel\.onExpiry\(\(request\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(expiryBody);
  agent.sentinel.onExpiry(vm.runInNewContext(`(request=>{${expiryBody[1]}})`, context));
  return { agent, context, writes, file, select: (model: unknown) => select({}, model),
    save: (patch: any) => save({}, patch), settings: () => settings({}), summary: () => summary({}), reload: () => loadConfig(file) };
}

test('legacy config exposes only its active model by default without exposing keys', async t => {
  const f = fixture(t);
  assert.deepEqual(Array.from((await f.summary()).llm.visible_models), ['current']);
  const settings = await f.settings();
  assert.deepEqual(Array.from(settings.visible_models), ['current']);
  assert.equal(settings.api_key, ''); assert.equal(settings.embed_api_key, '');
  assert.equal((await f.summary()).llm.api_key, undefined);
});

test('explicit empty shortlist survives save/reload and leaves the current model active', async t => {
  const f = fixture(t, { models: ['current', 'alternate'] });
  const result = await f.save({ visible_models: [] });
  assert.equal(result.ok, true); assert.deepEqual(Array.from(result.visible_models), []);
  assert.equal(f.reload().llm.model, 'current'); assert.deepEqual(f.reload().llm.visible_models, []);
  assert.deepEqual(Array.from((await f.settings()).visible_models), []);
  assert.equal((await f.select('current')).ok, false);
});

test('shortlist normalization deduplicates bounded provider IDs and persists their order', async t => {
  const f = fixture(t);
  const ids = [' provider/model:free ', '@cf/provider-model', 'provider/model:free', 'organization/model-v2', 'another/model'];
  assert.equal((await f.save({ visible_models: ids })).ok, true);
  assert.deepEqual(f.reload().llm.visible_models, ['provider/model:free', '@cf/provider-model', 'organization/model-v2', 'another/model']);
  assert.equal(f.reload().llm.model, 'current', 'Current model may be excluded without being silently changed');
});

test('invalid shortlist and hidden model selection never persist or replace the client', async t => {
  const f = fixture(t, { models: ['current'] }); const client = f.agent.llm;
  for (const models of ['current', null, [42], [''], ['line\nbreak'], ['with space'], ['comma,id'], ['x'.repeat(257)], Array(101).fill('id')]) {
    assert.equal((await f.save({ visible_models: models })).ok, false);
  }
  for (const model of ['hidden', {}, null, '', 'current\ninvalid']) assert.equal((await f.select(model)).ok, false);
  assert.equal(f.writes.length, 0); assert.equal(f.agent.llm, client);
});

test('allowed model selection persists before hot-applying and preserves conversation boundaries', async t => {
  const f = fixture(t, { models: ['current', 'provider/alternate:free'] });
  const history = f.agent.history, sentinel = f.agent.sentinel, memory = f.agent.memory;
  const result = await f.select('provider/alternate:free');
  assert.equal(result.ok, true); assert.equal(result.model, 'provider/alternate:free');
  assert.equal(f.reload().llm.model, result.model); assert.deepEqual(f.writes, [f.file]);
  assert.equal(f.context.agent, f.agent); assert.equal(f.agent.history, history);
  assert.equal(f.agent.sentinel, sentinel); assert.equal(f.agent.memory, memory); assert.equal(f.agent.tainted, true);
  assert.equal(f.agent.llm.cfg.model, result.model); assert.equal(memory.xllm.model, result.model);
});

test('explicit extraction model remains pinned when the chat model changes', async t => {
  const f = fixture(t, { models: ['current', 'alternate'], extractionModel: 'fixed-extractor' });
  assert.equal((await f.select('alternate')).ok, true);
  assert.equal(f.agent.memory.xllm.model, 'fixed-extractor');
});

test('busy turns and pending approvals block model switching without touching disk', async t => {
  const f = fixture(t, { models: ['current', 'alternate'] });
  f.context.agentBusy = true; assert.equal((await f.select('alternate')).ok, false);
  f.context.agentBusy = false; f.context.pendingApprovals.set('fixture', {});
  assert.equal((await f.select('alternate')).ok, false);
  assert.equal(f.writes.length, 0); assert.equal(f.agent.llm.cfg.model, 'current');
});

test('failed model persistence preserves the old client, active model and shortlist', async t => {
  const f = fixture(t, { models: ['current', 'alternate'] }); const client = f.agent.llm;
  f.context.failWrite = true; const result = await f.select('alternate');
  assert.equal(result.ok, false); assert.match(result.error, /persistence failed/);
  assert.equal(f.agent.llm, client); assert.equal(f.reload().llm.model, 'current');
});

test('model selection before startup remains lazy and persists for the next process', async t => {
  const f = fixture(t, { noAgent: true, models: ['current', 'alternate'] });
  assert.equal((await f.select('alternate')).ok, true); assert.equal(f.context.agent, null);
  assert.equal(f.reload().llm.model, 'alternate');
});

test('new chat endpoint requires an explicit shortlist instead of inheriting old choices', async t => {
  const f = fixture(t, { models: ['current', 'old-provider/model'] });
  // Supply a key field to pass origin binding; missing shortlist must still
  // fail before a credential vault or any persistence is touched.
  const result = await f.save({ base_url: 'https://new.fixture/v1', api_key: 'explicit-new-key' });
  assert.equal(result.ok, false); assert.match(result.error, /visible models explicitly/);
  assert.equal(f.writes.length, 0); assert.deepEqual(f.reload().llm.visible_models, ['current', 'old-provider/model']);
});

test('actual Sentinel expiry removes only entries for its original request object', async t => {
  const f = fixture(t, { models: ['current', 'alternate'] });
  const request = { tool: 'shell', args: { command: 'fixture expired request' } };
  let denied = false, unrelatedResolved = false;
  f.agent.sentinel.timeoutMs = 5;
  f.agent.sentinel.approver = (original: any) => new Promise(resolve => {
    f.context.pendingApprovals.set('expired', { request: original, resolve: (approved: boolean) => { denied = !approved; resolve(approved); } });
  });
  f.context.pendingApprovals.set('unrelated', { request: structuredClone(request), resolve: () => { unrelatedResolved = true; } });
  const result = await f.agent.sentinel.gate(request);
  assert.equal(result.decision, 'deny'); assert.equal(denied, true);
  assert.equal(f.context.pendingApprovals.has('expired'), false);
  assert.equal(f.context.pendingApprovals.has('unrelated'), true); assert.equal(unrelatedResolved, false);
  assert.equal((await f.select('alternate')).ok, false, 'A genuinely unrelated pending approval still blocks model switching');
});

test('model selection is available after the final pending approval really expires', async t => {
  const f = fixture(t, { models: ['current', 'alternate'] });
  f.agent.sentinel.timeoutMs = 5;
  f.agent.sentinel.approver = (request: any) => new Promise(resolve => {
    f.context.pendingApprovals.set('expired', { request, resolve });
  });
  const gate = f.agent.sentinel.gate({ tool: 'shell', args: { command: 'fixture expired request' } });
  assert.equal((await f.select('alternate')).ok, false);
  assert.equal((await gate).decision, 'deny');
  assert.equal(f.context.pendingApprovals.size, 0);
  assert.equal((await f.select('alternate')).ok, true);
  assert.equal(f.reload().llm.model, 'alternate');
});
