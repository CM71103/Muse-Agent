const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Agent } = require('../agent.js');
const { DEFAULTS, deepMerge, apiKey } = require('../config.js');
const { LlmClient } = require('../llm.js');
const { originOf } = require('../models.js');
const helpers = require('../../main/connection-settings.ts');
const source = fs.readFileSync(path.join(__dirname, '../../main/index.js'), 'utf8');

function fixture(options: any = {}) {
  let disk = deepMerge(DEFAULTS, {
    llm: { base_url: 'https://chat.fixture/v1', model: 'chat-old', api_key: '' },
    memory: { enabled: true, embed_base_url: 'https://embed.fixture/v1', embed_model: 'embed-fixture', embed_api_key: '', embed_dims: 0, ...options.memory },
  });
  let credentials = { llm: 'saved-chat', llm_origin: 'https://chat.fixture', embed: 'saved-embed', ...options.keys };
  const trace: string[] = [];
  const persistedPaths: string[] = [];
  if (options.configFile) disk._configFile = options.configFile;
  const cfg = () => {
    const value = structuredClone(disk);
    value.llm.api_key = credentials.llm;
    value.llm.key_origin = credentials.llm_origin;
    value.memory.embed_api_key = credentials.embed;
    return value;
  };
  let finishDrain: (() => void) | null = null;
  const memoryFor = (value: any) => ({
    cfg: value, memCfg: value.memory, xllm: helpers.extractionConfig(value),
    emb: { baseUrl: value.memory.embed_base_url || value.llm.base_url, apiKey: value.memory.embed_api_key || value.llm.api_key,
      model: value.memory.embed_model, dims: 1024, generation: value.memory.embed_generation || 'v1' },
    close: () => {
      trace.push('close');
      return options.pendingDrain ? new Promise<void>(resolve => { finishDrain = () => { trace.push('closed'); resolve(); }; }) : undefined;
    },
  });
  const original = new Agent(cfg());
  original.history.push({ role: 'user', content: 'keep conversation' });
  original.tainted = true;
  original.sentinel.grants.push('fixture-grant');
  original.memory = memoryFor(original.cfg);
  original.endSessionExtract = async () => { trace.push('extract'); return { ok: true }; };
  original._sourceEvents.push({ text: 'keep extraction window' });
  const context: any = {
    requireTrusted: () => {}, agentBusy: false, agent: options.noAgent ? null : original,
    secureConfig: cfg, loadConfig: () => structuredClone(disk), apiKeyOf: apiKey,
    safeStorage: {}, configDir: () => 'unused-fixture', ensureConfigFile: () => 'unused-fixture', userConfigFile: () => 'unused-fixture', originOf,
    currentProjectDir: 'fixture-project', process,
    setBusyState: (busy: boolean) => { context.agentBusy = busy; trace.push(`busy:${busy}`); },
    mkAgent: async (opts: any) => {
      trace.push('rebuild');
      const next = new Agent(cfg());
      next.memory = memoryFor(next.cfg);
      next.history = opts.history || [];
      next.sessionId = opts.sessionId;
      next.tainted = opts.tainted;
      next.lastMemoryTurnId = opts.memoryTurnId;
      return next;
    },
    require: (name: string) => {
      if (name === './connection-settings.ts') return helpers;
      if (name === '../harness/llm') return { LlmClient };
      if (name === '../harness/configWrite') return { writeSections: (value: any, file: string) => {
        trace.push('persist');
        persistedPaths.push(file);
        if (options.failWrite) throw new Error('fixture write failed');
        disk = structuredClone(value); disk.llm.api_key = ''; disk.memory.embed_api_key = '';
      } };
      if (name === '../harness/credentials') return { vault: () => ({
        read: () => structuredClone(credentials),
        write: (value: any) => { trace.push('vault-write'); credentials = structuredClone(value); },
      }) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  const saveBody = source.match(/ipcMain\.handle\('settings:save', async \(e, patch\) => \{([\s\S]*?)\n\}\);/);
  const getBody = source.match(/ipcMain\.handle\('settings:get', async \(e\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(saveBody && getBody);
  const save = vm.runInNewContext(`(async(e,patch)=>{${saveBody[1]}})`, context);
  const get = vm.runInNewContext(`(async(e)=>{${getBody[1]}})`, context);
  return { save: (patch: any) => save({}, patch), get: () => get({}), original, context, trace, persistedPaths,
    keys: () => credentials, finish: () => finishDrain!() };
}

test('unchanged save keeps the same memory and never starts or drains extraction', async () => {
  const f = fixture({ pendingDrain: true });
  const memory = f.original.memory, sentinel = f.original.sentinel, history = f.original.history, events = f.original._sourceEvents;
  const result = await f.save({ api_key: '', embed_api_key: '' });
  assert.equal(result.ok, true); assert.equal(result.memory_reinitialized, false);
  assert.equal(f.context.agent, f.original); assert.equal(f.original.memory, memory);
  assert.equal(f.original.sentinel, sentinel); assert.equal(f.original.history, history);
  assert.equal(f.original._sourceEvents, events); assert.equal(f.original.tainted, true);
  assert.deepEqual(f.trace, ['persist']);
});

test('chat model/token updates hot-apply while an extraction may still be running', async () => {
  const f = fixture({ pendingDrain: true });
  const result = await f.save({ model: 'chat-new', temperature: 0.7, max_tokens: 4096, context_tokens: 50000 });
  assert.equal(result.ok, true); assert.equal(f.original.llm.cfg.model, 'chat-new');
  assert.equal(f.original.ctxBudget, 50000); assert.equal(f.original.memory.xllm.model, 'chat-new');
  assert.equal(f.original.llm.key, 'saved-chat'); assert.equal(result.has_key, true);
  assert.deepEqual(f.trace, ['persist']);
});

test('dedicated embedding endpoint and key isolate chat connection changes', async () => {
  const f = fixture();
  const result = await f.save({ base_url: 'https://new-chat.fixture/v1', api_key: 'new-chat', embed_api_key: '', visible_models: ['chat-old'] });
  assert.equal(result.ok, true); assert.equal(result.memory_reinitialized, false);
  assert.equal(f.original.llm.base, 'https://new-chat.fixture/v1'); assert.equal(f.original.llm.key, 'new-chat');
  assert.equal(f.original.memory.emb.apiKey, 'saved-embed'); assert.equal(f.keys().embed, 'saved-embed');
  assert.equal(f.original.memory.xllm.apiKey, 'new-chat'); assert.equal(f.original.memory.xllm.baseUrl, 'https://new-chat.fixture/v1');
  assert.equal(f.trace.includes('close'), false);
});

test('blank embedding key preserves saved credentials on repeated saves and reports presence', async () => {
  const f = fixture();
  for (let n = 0; n < 2; n++) assert.equal((await f.save({ embed_api_key: '  ', api_key: '' })).ok, true);
  assert.equal(f.keys().embed, 'saved-embed'); assert.equal(f.trace.includes('vault-write'), false);
  const summary = await f.get();
  assert.equal(summary.embed_key_set, true); assert.equal(summary.has_key, true);
  assert.equal(summary.api_key, ''); assert.equal(summary.embed_api_key, '');
});

test('real embedding changes await the existing drain before rebuilding', async () => {
  const f = fixture({ pendingDrain: true });
  const sentinel = f.original.sentinel;
  const pending = f.save({ embed_model: 'different-embedding' });
  assert.ok(f.trace.includes('close')); assert.equal(f.trace.includes('rebuild'), false); assert.equal(f.context.agentBusy, true);
  const concurrent = await f.save({ model: 'should-not-race' });
  assert.equal(concurrent.ok, false); assert.match(concurrent.error, /busy/);
  f.finish(); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.memory_reinitialized, true);
  assert.ok(f.trace.indexOf('closed') < f.trace.indexOf('rebuild'));
  assert.equal(f.context.agent.sentinel, sentinel); assert.equal(f.context.agent.history, f.original.history);
  assert.equal(f.context.agent.tainted, true); assert.equal(f.context.agentBusy, false);
});

for (const change of ['base_url', 'api_key']) {
  test(`chat ${change} changes rebuild memory when embeddings use that fallback`, async () => {
    const f = fixture({ memory: { embed_base_url: '' }, keys: { embed: '' } });
    const result = await f.save({ [change]: change === 'base_url' ? 'https://different.fixture/v1' : 'different-key', api_key: 'different-key', visible_models: ['chat-old'] });
    assert.equal(result.ok, true); assert.equal(result.memory_reinitialized, true); assert.ok(f.trace.includes('rebuild'));
  });
}

test('auto-detected dimensions do not trigger an unnecessary memory rebuild', async () => {
  const f = fixture(); assert.equal(f.original.memory.emb.dims, 1024);
  assert.equal((await f.save({ embed_base_url: 'https://embed.fixture/v1/' })).memory_reinitialized, false);
  assert.equal(f.trace.includes('close'), false);
});

test('endpoint and key fallback are evaluated independently', async () => {
  for (const scenario of [
    { memory: {}, keys: { embed: '' }, patch: { api_key: 'new-chat' }, changed: true },
    { memory: { embed_base_url: '' }, keys: {}, patch: { base_url: 'https://chat.fixture/other/v1' }, changed: true },
    { memory: {}, keys: { embed: '' }, patch: { base_url: 'https://chat.fixture/other/v1' }, changed: false },
    { memory: { embed_base_url: '' }, keys: {}, patch: { api_key: 'new-chat' }, changed: false },
  ]) {
    const f = fixture(scenario); const result = await f.save({ ...scenario.patch, visible_models: ['chat-old'] });
    assert.equal(result.ok, true); assert.equal(result.memory_reinitialized, scenario.changed);
  }
});

test('invalid inputs are refused before persistence or credential writes', async () => {
  for (const patch of [{ base_url: 'file:///fixture' }, { base_url: 'http://public.fixture/v1' },
    { embed_base_url: 'http://public.fixture/v1' }, { base_url: 'https://user:password@chat.fixture/v1' },
    { embed_base_url: 'https://user:password@embed.fixture/v1' },
    { temperature: NaN }, { max_tokens: 1.5 }, { embed_api_key: 42 }, []]) {
    const f = fixture(); const result = await f.save(patch);
    assert.equal(result.ok, false); assert.deepEqual(f.trace, []);
  }
});

test('persistence failure rolls back new credentials and leaves the active client intact', async () => {
  const f = fixture({ failWrite: true }); const client = f.original.llm;
  const result = await f.save({ api_key: 'new-chat', embed_api_key: 'new-embed' });
  assert.equal(result.ok, false); assert.equal(f.keys().llm, 'saved-chat'); assert.equal(f.keys().embed, 'saved-embed');
  assert.equal(f.original.llm, client); assert.equal(f.trace.includes('close'), false);
});

test('saving before the first conversation stays lazy instead of initializing memory', async () => {
  const f = fixture({ noAgent: true }); const result = await f.save({ model: 'next-chat' });
  assert.equal(result.ok, true); assert.equal(f.context.agent, null); assert.deepEqual(f.trace, ['persist']);
});

test('new chat origin cannot inherit a saved old-origin key through blank fields', async () => {
  for (const api_key of ['', undefined]) {
    const f = fixture(); const result = await f.save({ base_url: 'https://different.fixture/v1', api_key });
    assert.equal(result.ok, false); assert.match(result.error, /Enter an API key/);
    assert.deepEqual(f.trace, []); assert.equal(f.original.llm.key, 'saved-chat');
  }
});

test('new embedding origin cannot inherit a saved key without explicit replacement', async () => {
  for (const embed of ['saved-embed', '']) {
    const f = fixture({ keys: { embed } });
    const result = await f.save({ embed_base_url: 'https://different-embed.fixture/v1', embed_api_key: '' });
    assert.equal(result.ok, false); assert.match(result.error, /embedding API key/); assert.deepEqual(f.trace, []);
  }
});

test('explicit new embedding key permits saving a different embedding origin', async () => {
  const f = fixture();
  const result = await f.save({ embed_base_url: 'https://different-embed.fixture/v1', embed_api_key: 'explicit-embed-key' });
  assert.equal(result.ok, true); assert.equal(f.keys().embed, 'explicit-embed-key');
  assert.equal(result.memory_reinitialized, true);
});

test('loopback HTTP endpoints remain valid with explicit credentials', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const f = fixture(); const result = await f.save({ base_url: `http://${host}:11434/v1`, api_key: 'explicit-local-key', visible_models: ['chat-old'] });
    assert.equal(result.ok, true);
  }
});

test('active loaded config path is persisted instead of selecting a different file', async () => {
  const f = fixture({ configFile: 'active-config-fixture.toml' });
  assert.equal((await f.save({ model: 'new-chat' })).ok, true);
  assert.deepEqual(f.persistedPaths, ['active-config-fixture.toml']);
});
