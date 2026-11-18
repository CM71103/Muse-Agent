const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ckpt-'));
process.env.MUSE_HOME = home;
const checkpoint = require('../checkpoint');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function proj() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ckpt-proj-'));
}

test('undo restores run-edited files and deletes files the run created', async () => {
  const dir = proj();
  const edited = path.join(dir, 'edited.txt');
  fs.writeFileSync(edited, 'v1');
  const created = path.join(dir, 'created.txt');

  const ck = checkpoint.begin('run-undo-1', 'sess');
  await ck.recordFile(edited);
  fs.writeFileSync(edited, 'v2');            // the run edits it
  await ck.recordFile(created);
  fs.writeFileSync(created, 'new file');     // the run creates it
  const entries = ck.finalize();
  assert.equal(entries.length, 2);

  const res = checkpoint.undo('run-undo-1');
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(edited, 'utf8'), 'v1');
  assert.equal(fs.existsSync(created), false);
  assert.equal(res.restored.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('files changed after the run are skipped, never clobbered', async () => {
  const dir = proj();
  const f = path.join(dir, 'f.txt');
  fs.writeFileSync(f, 'v1');
  const ck = checkpoint.begin('run-undo-2', 'sess');
  await ck.recordFile(f);
  fs.writeFileSync(f, 'v2');                 // the run edits it
  ck.finalize();
  fs.writeFileSync(f, 'v3 — user kept working');   // later change must win

  const res = checkpoint.undo('run-undo-2');
  assert.equal(res.ok, true);
  assert.equal(res.restored.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.equal(fs.readFileSync(f, 'utf8'), 'v3 — user kept working');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('write_file records pre-images through ctx.checkpoint (undo round trip)', async () => {
  const { buildTools } = require('../tools');
  const { tools } = buildTools({}, {});
  const write = tools.find((t) => t.name === 'write_file');
  assert.ok(write);
  const dir = proj();
  const f = path.join(dir, 'w.txt');
  fs.writeFileSync(f, 'before');

  const ck = checkpoint.begin('run-undo-3', 'sess');
  await write.run({ path: f, content: 'after' }, { cwd: dir, checkpoint: ck });
  ck.finalize();
  assert.equal(fs.readFileSync(f, 'utf8'), 'after');

  const res = checkpoint.undo('run-undo-3');
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'before');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('undo of an unknown or unfinalized run fails closed', () => {
  assert.equal(checkpoint.undo('run-does-not-exist').ok, false);
  const ck = checkpoint.begin('run-unfinalized', 'sess');
  assert.deepEqual(ck.finalize(), []);       // nothing recorded -> nothing written
  assert.equal(checkpoint.undo('run-unfinalized').ok, false);
});
