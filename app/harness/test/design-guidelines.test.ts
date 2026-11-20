const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-guidelines-'));
process.env.MUSE_HOME = home;

const design = require('../design.ts');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function makeProject(name) {
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'design-templates'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.od'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.od', 'project.json'), JSON.stringify({ name, kind: 'web', template_id: 'venue' }));
  return dir;
}

test('registry entries report whether they carry a guidelines spec', () => {
  const dir = makeProject('p1');
  const entryDir = path.join(dir, 'design-templates', 'venue');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'TEMPLATE.md'), 'name: Venue\ndescription: A venue template\n');
  fs.writeFileSync(path.join(entryDir, 'GUIDELINES.md'), 'Rules: no invented numbers.\n');

  const list = design.listRegistry(dir, 'design-templates');
  const venue = list.find(e => e.id === 'venue');
  assert.ok(venue, 'entry listed');
  assert.equal(venue.guidelinesFile, 'GUIDELINES.md');
  assert.ok(venue.files.includes('GUIDELINES.md'));
});

test('the active template guidelines are injected into the design context', () => {
  const dir = makeProject('p2');
  const entryDir = path.join(dir, 'design-templates', 'venue');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'TEMPLATE.md'), 'name: Venue\ndescription: A venue template\n');
  fs.writeFileSync(path.join(entryDir, 'GUIDELINES.md'), 'RULES-THAT-MUST-APPEAR: cite the experiment log.\n');

  const ctx = design.designContext(dir);
  assert.ok(ctx && ctx.active);
  assert.match(ctx.text, /RULES-THAT-MUST-APPEAR/);
  assert.match(ctx.text, /Template guidelines \(venue\)/);
  assert.match(ctx.text, /override your own defaults/);
});

test('a template without guidelines does not inject a spec block', () => {
  const dir = makeProject('p3');
  const entryDir = path.join(dir, 'design-templates', 'plain');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'TEMPLATE.md'), 'name: Plain\ndescription: no spec\n');

  const ctx = design.designContext(dir);
  assert.ok(ctx && ctx.active);
  assert.ok(!/Template guidelines/.test(ctx.text), 'no guidelines block without a spec file');
  assert.match(ctx.text, /plain — no spec/, 'the template is still listed');
});

test('applying a template materializes its guidelines into the project', () => {
  const dir = makeProject('p4');
  const entryDir = path.join(dir, 'design-templates', 'venue');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'TEMPLATE.md'), 'name: Venue\ndescription: d\n');
  fs.writeFileSync(path.join(entryDir, 'GUIDELINES.md'), 'SPEC-CONTENT\n');
  fs.writeFileSync(path.join(entryDir, 'index.html'), '<html></html>');

  const res = design.applyTemplate(dir, 'venue');
  assert.ok(res.written.includes('GUIDELINES.md'), 'guidelines copied into the project');
  assert.ok(fs.existsSync(path.join(dir, 'GUIDELINES.md')));

  // A scaffolded project without a registry entry still gets the spec.
  const only = path.join(home, 'p5');
  fs.mkdirSync(only, { recursive: true });
  fs.mkdirSync(path.join(only, '.od'), { recursive: true });
  fs.writeFileSync(path.join(only, '.od', 'project.json'), JSON.stringify({ name: 'p5', kind: 'web' }));
  fs.writeFileSync(path.join(only, 'GUIDELINES.md'), 'SPEC-FROM-PROJECT\n');
  const ctx = design.designContext(only);
  assert.match(ctx.text, /SPEC-FROM-PROJECT/);
});

test('bundled templates ship a guidelines spec', () => {
  const bundled = path.join(__dirname, '..', '..', 'design', 'design-templates');
  const dirs = fs.readdirSync(bundled, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  assert.ok(dirs.length >= 3, 'bundled templates exist');
  for (const name of dirs) {
    const file = path.join(bundled, name, 'GUIDELINES.md');
    assert.ok(fs.existsSync(file), `${name} should carry GUIDELINES.md`);
    assert.match(fs.readFileSync(file, 'utf8'), /\.md|guidelines/i);
  }
});
