import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MemoryLayer } = require('../../memory/layer.js');
const { DEFAULTS, deepMerge } = require('../config.js');
const llmAdapter = require('../../memory/adapters/llm.js');

function setup(t: TestContext, memory = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-scope-'));
  // The developer's home may itself be a Git repository. Keep fixture
  // detection below this boundary instead of inheriting that unrelated root.
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = temp;
  const folders = ['one', 'two'].map(name => path.join(temp, name));
  for (const folder of folders) fs.mkdirSync(folder);
  const cfg = deepMerge(DEFAULTS, {
    memory: { enabled: true, project_id_strategy: 'auto', project_id: '', embed_model: 'scope-test', embed_dims: 2,
      adaptive_ranking: false, adaptive_budget: false, query_clustering: false, ...memory },
    llm: { base_url: 'http://unused.invalid/v1', model: 'fixture', api_key: 'fixture' },
  });
  const embed = async (_cfg: unknown, texts: string[]) => ({ model: 'scope-test', vectors: texts.map(() => ({ vector: [1, 0] })), usage: { total_tokens: 0 } });
  const mem = new MemoryLayer(cfg, { dataDir: path.join(temp, 'db'), cwd: null, allowFolderScope: true, embed });
  t.after(() => {
    mem.close(); fs.rmSync(temp, { recursive: true, force: true });
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  });
  return { mem, folders, temp, cfg };
}

const event = (text: string, id = 'same-source') => ({ source_event_id: id, text, provenance: 'user' });

test('desktop auto memory starts suspended and never falls back to process.cwd', async t => {
  const { mem } = setup(t);
  assert.equal(mem.projectId, null);
  assert.deepEqual(await mem.ingest([event('must not store')]), [{ ok: false, reason: 'memory_scope_required' }]);
  assert.equal(mem.store.listAllMemories().length, 0);
  const context = await mem.requestContext('query');
  assert.equal(context.clamp_reason, 'memory_scope_required');
  assert.equal(context.turn_id, null);
});

test('non-Git folders isolate memory, dedupe per scope, and preserve prior rows', async t => {
  const { mem, folders } = setup(t);
  const store = mem.store;
  mem.setProjectScope(folders[0]);
  const first = mem.projectId;
  await mem.ingest([event('first folder')]);
  mem.setProjectScope(folders[1]);
  const second = mem.projectId;
  assert.notEqual(first, second);
  assert.equal(mem.listMemories().length, 0);
  await mem.ingest([event('second folder')]);
  assert.equal(mem.listMemories()[0].text, 'second folder');
  mem.setProjectScope(folders[0]);
  assert.equal(mem.projectId, first);
  assert.equal(mem.listMemories()[0].text, 'first folder');
  mem.setProjectScope(null);
  assert.equal(mem.projectId, null);
  assert.equal(mem.listMemories().length, 0);
  assert.equal(mem.store.listAllMemories().length, 2);
  assert.equal(mem.store, store, 'scope switching keeps the same open DB');
});

test('canonical folder aliases reuse scope instead of creating duplicate namespaces', t => {
  const { mem, folders, temp } = setup(t);
  const alias = path.join(temp, 'alias');
  fs.symlinkSync(folders[0], alias, process.platform === 'win32' ? 'junction' : 'dir');
  mem.setProjectScope(folders[0]);
  const first = mem.projectId;
  const same = mem.setProjectScope(alias);
  assert.equal(mem.projectId, first);
  assert.equal(same.changed, false);
});

for (const strategy of ['manual', '_default']) {
  test(`${strategy}: explicit memory scope survives folder selection and clearing`, async t => {
    const { mem, folders } = setup(t, { project_id_strategy: strategy, project_id: 'explicit-personal' });
    await mem.ingest([event('personal fact')]);
    mem.setProjectScope(folders[0]);
    assert.equal(mem.projectId, 'explicit-personal');
    mem.setProjectScope(null);
    assert.equal(mem.projectId, 'explicit-personal');
    assert.equal(mem.listMemories()[0].text, 'personal fact');
    const store = mem.store;
    mem.setScope('auto', '', folders[0]);
    assert.notEqual(mem.projectId, 'explicit-personal');
    mem.setScope(strategy, 'explicit-personal', null);
    assert.equal(mem.projectId, 'explicit-personal');
    assert.equal(mem.listMemories()[0].text, 'personal fact');
    assert.equal(mem.store, store);
  });
}

test('existing Git-root registry IDs remain compatible', t => {
  const { mem, folders } = setup(t);
  execFileSync('git', ['init', '--quiet', folders[0]], { windowsHide: true });
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: folders[0], encoding: 'utf8', windowsHide: true }).trim();
  const existing = mem.store.registerProject(gitRoot);
  const child = path.join(folders[0], 'subdir');
  fs.mkdirSync(child);
  mem.setProjectScope(child);
  assert.equal(mem.projectId, existing);
});

test('session-end extraction keeps its original scope across a project switch', async t => {
  const { mem, folders } = setup(t);
  mem.setProjectScope(folders[0]);
  const first = mem.projectId;
  await mem.ingest([event('raw original project')]);
  const originalChat = llmAdapter.chat;
  let release!: (value: object) => void;
  t.after(() => { llmAdapter.chat = originalChat; });
  llmAdapter.chat = () => new Promise(resolve => { release = resolve; });
  const pending = mem.extractSession([event('raw original project')]);
  mem.setProjectScope(folders[1]);
  await mem.ingest([event('new project raw')]);
  release({ text: JSON.stringify({ records: [{ text: 'distilled original project', source_event_ids: ['same-source'], provenance: 'user', type: 'fact' }] }), usage: { total_tokens: 0 } });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(mem.listMemories().length, 1);
  assert.equal(mem.listMemories()[0].text, 'new project raw');
  assert.equal(mem.listMemories()[0].status, 'pending_embed');
  const oldRows = mem.store.listMemories(first);
  assert.equal(oldRows.find((row: any) => row.text === 'raw original project').status, 'superseded');
  assert.equal(oldRows.find((row: any) => row.text === 'distilled original project').status, 'active');
});

test('scope changes during query embedding discard old retrieved context', async t => {
  const { mem, folders } = setup(t);
  mem.setProjectScope(folders[0]);
  await mem.ingest([event('project-specific memory')]);
  await mem.embedPending();
  let release!: (value: object) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  mem.embed = () => new Promise(resolve => { release = resolve; entered(); });
  const pending = mem.requestContext('project memory');
  await started;
  mem.setProjectScope(folders[1]);
  release({ model: 'scope-test', vectors: [{ vector: [1, 0] }], usage: { total_tokens: 0 } });
  const context = await pending;
  assert.equal(context.clamp_reason, 'memory_scope_changed');
  assert.equal(context.records.length, 0);
  assert.equal(context.turn_id, null);
});

test('prepared context cannot be committed after scope selection changes', async t => {
  const { mem, folders } = setup(t);
  mem.setProjectScope(folders[0]);
  await mem.ingest([event('project-specific memory')]);
  const context = await mem.requestContext('project memory');
  assert.equal(context.records.length, 1);
  mem.setProjectScope(folders[1]);
  assert.throws(() => mem.commitPrepared(context), /scope changed/);
});

test('closing drains existing extraction before releasing the SQLite owner', async t => {
  const { mem, folders } = setup(t);
  mem.setProjectScope(folders[0]);
  const originalChat = llmAdapter.chat;
  let release!: (value: object) => void;
  t.after(() => { llmAdapter.chat = originalChat; });
  llmAdapter.chat = () => new Promise(resolve => { release = resolve; });
  const extraction = mem.extractSession([event('raw original project')]);
  const closing = mem.close();
  assert.ok(closing instanceof Promise);
  assert.equal(mem.store.sql.open, true);
  assert.equal(mem.close(), closing, 'concurrent closes reuse the same drain');
  assert.equal((await mem.extractSession([event('too late')])).reason, 'memory_closing');
  release({ text: JSON.stringify({ records: [{ text: 'persisted before close', source_event_ids: ['same-source'], provenance: 'user', type: 'fact' }] }), usage: { total_tokens: 0 } });
  assert.equal((await extraction).extracted, 1);
  await closing;
  assert.equal(mem.store.sql.open, false);
});

test('idle close remains synchronous for callers and test cleanup', t => {
  const { mem } = setup(t);
  assert.equal(mem.close(), undefined);
  assert.equal(mem.store.sql.open, false);
});
