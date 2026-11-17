const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// The personal design registry lives under MUSE_HOME; point it at a scratch
// folder so these tests never read the developer's real design entries.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-design-home-'));
process.env.MUSE_HOME = home;
const design = require('../design.ts');
const { designContext, listProjectFiles, readProjectFile, projectRevision } = design;

const scratch: string[] = [home];
function workspace(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
test.after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

function designProject(dir: string, metadata: Record<string, any> = {}) {
  fs.mkdirSync(path.join(dir, '.od'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.od/project.json'), JSON.stringify({ name: 'Demo', kind: 'prototype', ...metadata }));
  return dir;
}

test('no-op when project folder has no design files', () => {
  const dir = workspace('muse-design-none-');
  // Bundled content always exists, so activation must depend on the folder
  // itself; an ordinary checkout gets no design block in its prompt.
  assert.ok(design.listRegistry(null, 'design-systems').length, 'bundled design systems should ship with the app');
  assert.equal(designContext(dir), null);
});

test('loads root DESIGN.md and project.json', () => {
  const dir = designProject(workspace('muse-design-root-'), { design_system_id: 'airbnb', skill_id: 'ui-patterns' });
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), '# Demo design\nUse warm colors.');
  fs.mkdirSync(path.join(dir, 'skills', 'ui-patterns'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'ui-patterns/SKILL.md'), '# UI Patterns\nPrefer cards.');
  const ctx = designContext(dir);
  assert.ok(ctx);
  assert.match(ctx.text, /Demo design/);
  assert.match(ctx.text, /Selected design system \(root\)/);
  assert.match(ctx.text, /Prefer cards/);
  assert.match(ctx.text, /Artifact contract/);
});

test('selects active design system when project.json references it', () => {
  const dir = designProject(workspace('muse-design-select-'), { design_system_id: 'minimal' });
  fs.mkdirSync(path.join(dir, 'design-systems', 'minimal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'design-systems/minimal/DESIGN.md'), '# Minimal\nClean lines.');
  const ctx = designContext(dir);
  assert.match(ctx.text, /# Minimal/);
});

test('ignores non-existent referenced directories', () => {
  const dir = designProject(workspace('muse-design-missing-'), { design_system_id: 'missing' });
  const ctx = designContext(dir);
  assert.ok(ctx);
  assert.match(ctx.text, /Artifact contract/);
});

test('project browser lists readable files but skips generated folders and symlinks', () => {
  const dir = workspace('muse-design-files-');
  const outside = workspace('muse-design-outside-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/app.ts'), 'export const app = true;');
  fs.writeFileSync(path.join(dir, 'node_modules/ignored/dep.js'), 'ignored');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  try { fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction'); } catch { /* Symlinks may be unavailable on this host. */ }
  const result = listProjectFiles(dir);
  assert.deepEqual(result.files.map((file: any) => file.path), ['src/app.ts']);
  assert.equal(result.truncated, false);
  assert.equal(readProjectFile(dir, 'src/app.ts').text, 'export const app = true;');
  assert.throws(() => readProjectFile(dir, path.join(outside, 'secret.txt')), /outside the project folder/);
  if (fs.existsSync(path.join(dir, 'linked'))) assert.throws(() => readProjectFile(dir, 'linked/secret.txt'), /outside the project folder/);
});

test('project revision changes when a non-entry file is edited', () => {
  const dir = workspace('muse-design-revision-');
  fs.writeFileSync(path.join(dir, 'index.html'), '<main>demo</main>');
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{color:red}');
  const before = projectRevision(dir);
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{color:blue}');
  assert.notEqual(projectRevision(dir), before);
});

// --- registries -------------------------------------------------------------

test('registry lists bundled design systems, templates, skills and craft rules', () => {
  const dir = designProject(workspace('muse-design-bundled-'));
  for (const kind of design.KINDS) {
    const entries = design.listRegistry(dir, kind);
    assert.ok(entries.length, `expected bundled ${kind} entries`);
    assert.ok(entries.every(entry => entry.id && entry.name && entry.source), `malformed ${kind} entry`);
  }
  const deck = design.listRegistry(dir, 'design-templates').find(entry => entry.id === 'deck');
  assert.ok(deck, 'bundled deck template missing');
  assert.ok(deck.files.includes('index.html'));
});

test('project entries shadow personal entries with the same id', () => {
  const dir = designProject(workspace('muse-design-shadow-'));
  const personal = path.join(home, 'design', 'design-systems', 'muse-default');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'DESIGN.md'), 'name: Personal default\ndescription: mine\n\n# Personal wins over bundled');
  const local = path.join(dir, 'design-systems', 'muse-default');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'DESIGN.md'), 'name: Project default\n\n# Project wins over personal');

  const entries = design.listRegistry(dir, 'design-systems');
  const match = entries.filter(entry => entry.id === 'muse-default');
  assert.equal(match.length, 1, 'same id must collapse to one entry');
  assert.equal(match[0].source, 'project');
  assert.deepEqual(match[0].shadowedSources, ['user', 'bundled']);

  // Without the project copy, the personal entry wins over the bundled one.
  fs.rmSync(local, { recursive: true, force: true });
  const next = design.listRegistry(dir, 'design-systems').find(entry => entry.id === 'muse-default');
  assert.equal(next.source, 'user');
  assert.match(design.readRegistryFile(dir, 'design-systems', 'muse-default').text, /Personal wins/);
  fs.rmSync(personal, { recursive: true, force: true });
});

test('registry reads are confined to the entry folder', () => {
  const dir = designProject(workspace('muse-design-read-'));
  assert.throws(() => design.readRegistryFile(dir, 'design-systems', 'nope'), /No design system/);
  assert.throws(() => design.readRegistryFile(dir, 'design-systems', 'muse-default', '../../config.toml'), /outside the entry folder/);
  assert.throws(() => design.listRegistry(dir, 'secrets'), /Unknown design registry/);
});

test('design context names the template and craft selections and stays bounded', () => {
  const dir = designProject(workspace('muse-design-compose-'), { craft: ['design-quality'], template_id: 'deck' });
  const ctx = designContext(dir);
  assert.match(ctx.text, /Craft rules \(design-quality\)/);
  assert.match(ctx.text, /Design templates available: .*deck/);
  assert.ok(ctx.text.length < 40000, 'design context must respect the prompt budget');
});

// --- artifact contract ------------------------------------------------------

test('manifest validation rejects traversal and missing files, then accepts a real entry', () => {
  const dir = designProject(workspace('muse-design-manifest-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<main>hi</main>');
  assert.equal(design.normalizeArtifact(dir, { entry: '../outside.html' }), null);
  assert.equal(design.normalizeArtifact(dir, { entry: 'missing.html' }), null);
  assert.equal(design.normalizeArtifact(dir, { entry: 'C:/Windows/win.ini' }), null);
  const manifest = design.writeArtifact(dir, { entry: 'index.html', kind: 'html', title: 'Hi', supportingFiles: ['../nope', 'app.css'] });
  assert.equal(manifest.entry, 'index.html');
  assert.deepEqual(manifest.supportingFiles, ['app.css'], 'traversal must be dropped, in-project names kept');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.od/artifact.json'), 'utf8')).title, 'Hi');
  assert.equal(design.readArtifact(dir).detected, false);
});

test('artifact detection previews a project that ignored the manifest', () => {
  const dir = workspace('muse-design-detect-');
  assert.equal(design.readArtifact(dir), null);
  fs.writeFileSync(path.join(dir, 'index.html'), '<main>demo</main>');
  const artifact = design.readArtifact(dir);
  assert.equal(artifact.entry, 'index.html');
  assert.equal(artifact.detected, true);
});

test('inline artifact blocks are materialized into the workspace', () => {
  const dir = designProject(workspace('muse-design-capture-'));
  const text = [
    'Here you go.',
    '<artifact identifier="page.html" type="code/html" title="Release page">',
    '<!doctype html><main>Release</main>',
    '</artifact>',
    '<artifact identifier="../escape.html">nope</artifact>',
    'done',
  ].join('\n');
  assert.equal(design.parseArtifactBlocks(text).length, 2);
  const result = design.captureArtifacts(dir, text);
  assert.deepEqual(result.written, ['page.html']);
  assert.match(fs.readFileSync(path.join(dir, 'page.html'), 'utf8'), /Release/);
  assert.equal(fs.existsSync(path.join(dir, '..', 'escape.html')), false);
  assert.equal(result.artifact.entry, 'page.html');
  assert.equal(result.artifact.title, 'Release page');
  assert.equal(design.captureArtifacts(dir, 'nothing here').written.length, 0);
});

// --- templates --------------------------------------------------------------

test('template scaffolding writes starter files and keeps existing ones', () => {
  const dir = designProject(workspace('muse-design-template-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<main>mine</main>');
  const result = design.applyTemplate(dir, 'deck');
  assert.equal(result.id, 'deck');
  assert.ok(result.skipped.includes('index.html'), 'existing files must survive');
  assert.ok(fs.readFileSync(path.join(dir, 'index.html'), 'utf8') === '<main>mine</main>');
  assert.equal(design.readProjectJson(dir).template_id, 'deck');
  const forced = design.applyTemplate(dir, 'deck', { force: true });
  assert.ok(forced.written.includes('index.html'));
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /<html/i);
  assert.equal(design.readArtifact(dir).entry, 'index.html');
  assert.throws(() => design.applyTemplate(dir, 'not-a-template'), /No design template/);
});

test('project metadata ignores unknown keys and validates craft lists', () => {
  const dir = designProject(workspace('muse-design-meta-'));
  const saved = design.saveDesignProject(dir, { design_system_id: 'editorial-flat', craft: ['design-quality'], evil: 'x', __proto__: { polluted: true } });
  assert.equal(saved.design_system_id, 'editorial-flat');
  assert.deepEqual(saved.craft, ['design-quality']);
  assert.equal(saved.evil, undefined);
  assert.equal((design.readProjectJson(dir) as any).polluted, undefined);
  assert.throws(() => design.saveDesignProject(dir, { craft: 'nope' }), /list of rule ids/);
});

// --- agent tools ------------------------------------------------------------

test('design tools expose status, registry, configure, scaffold and artifact to the model', async () => {
  const dir = designProject(workspace('muse-design-tools-'));
  const { mkDesignTools, DESIGN_TOOL_NAMES } = require('../design-tools.ts');
  const tools = new Map(mkDesignTools({}).map((tool: any) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], DESIGN_TOOL_NAMES);
  const ctx = { cwd: dir, agent: { replaceDesignContext() { } } };

  const status = await tools.get('design_status').run({}, ctx);
  assert.equal(status.ok, true);
  assert.equal(status.projectDir, dir);
  assert.ok(status.counts['design-templates'] > 0);
  assert.ok(!JSON.stringify(status).includes('# Muse default'), 'registry text must not leak into status');

  const listed = await tools.get('design_registry').run({ kind: 'design-systems' }, ctx);
  assert.ok(listed.entries.some((entry: any) => entry.id === 'muse-default'));
  const read = await tools.get('design_registry').run({ kind: 'craft', id: 'design-quality' }, ctx);
  assert.match(read.text, /Craft/);

  const applied = await tools.get('design_configure').run({ design_system: 'editorial-flat', craft: ['design-quality'] }, ctx);
  assert.equal(applied.ok, true);
  assert.equal(applied.project.design_system_id, 'editorial-flat');
  const bad = await tools.get('design_configure').run({ design_system: 'invented' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown design system/);

  const scaffolded = await tools.get('design_scaffold').run({ template: 'landing-page' }, ctx);
  assert.equal(scaffolded.ok, true);
  assert.ok(scaffolded.written.includes('index.html'));

  const published = await tools.get('design_artifact').run({ entry: 'index.html', kind: 'html', title: 'Landing' }, ctx);
  assert.equal(published.ok, true);
  assert.equal(published.manifest.title, 'Landing');
  const escape = await tools.get('design_artifact').run({ entry: '../outside.html' }, ctx);
  assert.equal(escape.ok, false);

  const noProject = await tools.get('design_status').run({}, { cwd: workspace('muse-design-plain-') });
  assert.equal(noProject.ok, true);
  assert.equal(noProject.project, null);
});

test('sentinel classifies design tools instead of failing closed', () => {
  const { Sentinel } = require('../sentinel.js');
  const policy = (mode: string) => new Sentinel({ sentinel: { mode, deny_rules: [] }, agent: {} });
  const dir = designProject(workspace('muse-design-sentinel-'));
  const granted = (mode: string) => { const sentinel = policy(mode); sentinel.addGrant(dir); return sentinel; };
  for (const name of ['design_status', 'design_registry']) {
    const decision = granted('ask').decide({ tool: name, args: {}, resolvedPath: dir });
    assert.equal(decision.decision, 'allow', `${name}: ${decision.reason}`);
    // Registry reads still ask when the scope was never granted.
    assert.equal(policy('ask').decide({ tool: name, args: {}, resolvedPath: dir }).decision, 'ask', name + ' outside scope must ask');
  }
  for (const name of ['design_configure', 'design_scaffold', 'design_artifact']) {
    assert.equal(policy('ask').decide({ tool: name, args: {}, resolvedPath: dir }).decision, 'ask', name + ' must ask in ask mode');
    assert.equal(policy('plan').decide({ tool: name, args: {}, resolvedPath: dir }).decision, 'deny', name + ' must be blocked in plan mode');
    assert.equal(policy('auto').decide({ tool: name, args: {}, resolvedPath: dir }).decision, 'allow', name + ' must run in auto mode');
    assert.equal(granted('accept_edits').decide({ tool: name, args: {}, resolvedPath: dir }).decision, 'allow', name + ' must auto-approve inside the granted project');
    assert.equal(granted('accept_edits').decide({ tool: name, args: {}, resolvedPath: workspace('muse-design-other-') }).decision, 'ask', name + ' outside scope must ask');
  }
});

test('agent gains and loses design tools with the project scope', () => {
  const dir = designProject(workspace('muse-design-agent-'));
  const plain = workspace('muse-design-agent-plain-');
  const { Agent } = require('../agent.js');
  const { DEFAULTS } = require('../config');
  const agent = new Agent(structuredClone(DEFAULTS), { onEvent: () => {} });
  assert.equal(agent.tools.some((tool: any) => tool.name === 'design_status'), false);
  agent.setProjectScope(dir);
  assert.ok(agent.tools.some((tool: any) => tool.name === 'design_status'), 'design project must publish design tools');
  assert.ok(agent.toolSchemas().some((schema: any) => schema.name === 'design_registry'));
  agent.setProjectScope(plain);
  assert.equal(agent.tools.some((tool: any) => tool.name === 'design_status'), false, 'ordinary folder must not publish them');
  agent.setProjectScope(null);
  assert.equal(agent.tools.some((tool: any) => tool.name === 'design_status'), false);
});

test('replaceDesignContext swaps the live prompt block without touching the rest', () => {
  const { Agent } = require('../agent.js');
  const { DEFAULTS } = require('../config');
  const agent = new Agent(structuredClone(DEFAULTS), { onEvent: () => {} });
  agent.history.push({ role: 'system', content: 'Base rules.\n\n--- Design workspace (Muse Design Studio) ---\nold text\n\nArtifact contract: x' });
  agent.replaceDesignContext('--- Design workspace (Muse Design Studio) ---\nnew text');
  assert.match(agent.history[0].content, /^Base rules\.\n\n--- Design workspace \(Muse Design Studio\) ---\nnew text$/);
  agent.replaceDesignContext('');
  assert.equal(agent.history[0].content, 'Base rules.');
  // A session that began outside the Design Studio gets the block appended.
  agent.replaceDesignContext('--- Design workspace (Muse Design Studio) ---\nnew text');
  assert.equal(agent.history[0].content, 'Base rules.\n\n--- Design workspace (Muse Design Studio) ---\nnew text');
  agent.replaceDesignContext('--- Design workspace (Muse Design Studio) ---\nnewest text');
  assert.equal(agent.history[0].content, 'Base rules.\n\n--- Design workspace (Muse Design Studio) ---\nnewest text', 'repeated swaps must not stack blocks');
});
