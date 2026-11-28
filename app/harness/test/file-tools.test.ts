'use strict';
// file-tools.test.ts - edit_file, paged read_file, grep, glob, and their gate class.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildTools } = require('../tools');
const { Sentinel } = require('../sentinel');

function sandbox(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tools-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  const { map } = buildTools({}, { disableSubagent: true });
  const ctx: any = { cwd: root, cfg: {}, checkpoint: { recordFile: async () => {} } };
  return { root, tool: (name: string) => map.get(name), ctx };
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

test('read_file pages a large file by line', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const { tool, ctx } = sandbox({ 'a.txt': lines });
  const res = await tool('read_file').run({ path: 'a.txt', offset: 5, limit: 3 }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.content, 'line 5\nline 6\nline 7');
  assert.equal(res.first_line, 5);
  assert.equal(res.last_line, 7);
  assert.equal(res.next_offset, 8);
});

test('edit_file replaces one unique block and checkpoints the pre-image', async () => {
  const { root, tool, ctx } = sandbox({ 'src/a.js': 'function a() {\n  return 1;\n}\n' });
  const recorded: string[] = [];
  ctx.checkpoint = { recordFile: async (p: string) => { recorded.push(p); } };
  const res = await tool('edit_file').run({ path: 'src/a.js', old_string: '  return 1;', new_string: '  return 2;' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.replacements, 1);
  assert.equal(read(root, 'src/a.js'), 'function a() {\n  return 2;\n}\n');
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0].endsWith(path.join('src', 'a.js')));
});

test('edit_file refuses an ambiguous match and leaves the file alone', async () => {
  const { root, tool, ctx } = sandbox({ 'b.txt': 'x\nx\n' });
  const bad = await tool('edit_file').run({ path: 'b.txt', old_string: 'x', new_string: 'y' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /matches 2 places/);
  assert.equal(read(root, 'b.txt'), 'x\nx\n');

  const all = await tool('edit_file').run({ path: 'b.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
  assert.equal(all.ok, true);
  assert.equal(all.replacements, 2);
  assert.equal(read(root, 'b.txt'), 'y\ny\n');
});

test('edit_file reports a missing old_string instead of writing', async () => {
  const { root, tool, ctx } = sandbox({ 'c.txt': 'hello\n' });
  const res = await tool('edit_file').run({ path: 'c.txt', old_string: 'goodbye', new_string: 'hi' }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
  assert.equal(read(root, 'c.txt'), 'hello\n');
});

test('grep finds lines, skips dependency folders, and honours a glob filter', async () => {
  const { tool, ctx } = sandbox({
    'src/a.js': 'const a = 1;\nconst needle = 2;\n',
    'src/b.ts': 'const needle = 3;\n',
    'node_modules/pkg/x.js': 'needle\n',
  });
  const all = await tool('grep').run({ pattern: 'needle' }, ctx);
  assert.equal(all.ok, true);
  const paths = all.matches.map((m: any) => m.path).sort();
  assert.deepEqual(paths, ['src/a.js', 'src/b.ts']);
  assert.deepEqual(all.matches.find((m: any) => m.path === 'src/a.js'), { path: 'src/a.js', line: 2, text: 'const needle = 2;' });

  const js = await tool('grep').run({ pattern: 'needle', glob: '**/*.js' }, ctx);
  assert.deepEqual(js.matches.map((m: any) => m.path), ['src/a.js']);
});

test('grep rejects an invalid regular expression', async () => {
  const { tool, ctx } = sandbox({ 'a.txt': 'x\n' });
  const res = await tool('grep').run({ pattern: '(' }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid regular expression/);
});

test('glob finds files by pattern with ** and braces', async () => {
  const { tool, ctx } = sandbox({ 'e.js': '', 'a/b/c.js': '', 'a/b/d.ts': '' });
  const all = await tool('glob').run({ pattern: '**/*.js' }, ctx);
  assert.deepEqual(all.matches, ['a/b/c.js', 'e.js']);

  const both = await tool('glob').run({ pattern: 'a/**/*.{js,ts}' }, ctx);
  assert.deepEqual(both.matches, ['a/b/c.js', 'a/b/d.ts']);
});

test('gate: edit_file is a side effect, grep and glob are reads', () => {
  const s = new Sentinel({ sentinel: { mode: 'ask', deny_rules: [] }, agent: {} });
  assert.equal(s.decide({ tool: 'edit_file', args: {} }).decision, 'ask');
  assert.equal(s.decide({ tool: 'grep', args: {} }).decision, 'ask');   // outside any granted scope
  assert.equal(s.decide({ tool: 'glob', args: {} }).decision, 'ask');
  s.mode = 'auto';
  assert.equal(s.decide({ tool: 'edit_file', args: {} }).decision, 'allow');
});
