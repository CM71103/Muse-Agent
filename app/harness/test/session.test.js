'use strict';
// session.test.js — append-only JSONL rollout roundtrip + edge cases.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sess-'));
process.env.MUSE_HOME = home;
const session = require('../session');

const msg = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });

test('save/load roundtrip, append grows file not rewrites', () => {
  const id = session.newId();
  session.save({ id, history: [msg(0), msg(1)] });
  const f = path.join(session.sessionsDir(), `${id}.jsonl`);
  const size2 = fs.statSync(f).size;
  session.save({ id, history: [msg(0), msg(1), msg(2), msg(3)] });
  const size4 = fs.statSync(f).size;
  assert.ok(size4 > size2, 'file grows');
  const s = session.load(id);
  assert.strictEqual(s.history.length, 4);
  assert.deepStrictEqual(s.history[3], msg(3));
  // every saved message appears exactly once on disk (append path, no rewrite)
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(lines.filter(l => l.kind === 'm').length, 4);
});

test('list() returns metadata; remove() deletes jsonl+legacy', () => {
  const id = session.newId();
  session.save({ id, title: 'hello', projectId: 'p1', history: [msg(0)] });
  const entry = session.list().find(e => e.id === id);
  assert.strictEqual(entry.title, 'hello');
  assert.strictEqual(entry.projectId, 'p1');
  assert.strictEqual(entry.turns, 1);
  fs.writeFileSync(path.join(session.sessionsDir(), `${id}.json`), '{}'); // legacy sibling
  assert.strictEqual(session.remove(id), true);
  assert.strictEqual(session.load(id), null);
});

test('snapshot supersedes on compaction-style rewrite', () => {
  const id = session.newId();
  session.save({ id, history: [msg(0), msg(1), msg(2)] });
  const compacted = { role: 'user', name: 'compacted', content: 'S' };
  session.save({ id, history: [compacted, msg(2)] });
  const s = session.load(id);
  assert.strictEqual(s.history.length, 2);
  assert.strictEqual(s.history[0].name, 'compacted');
});

test('torn tail line skipped', () => {
  const id = session.newId();
  session.save({ id, history: [msg(0)] });
  const f = path.join(session.sessionsDir(), `${id}.jsonl`);
  fs.appendFileSync(f, '{"kind":"m","seq":1,"msg":{"role":"assistant","con'); // crash mid-write
  const s = session.load(id);
  assert.strictEqual(s.history.length, 1);
});

test('duplicate seq deduped (idempotent replay)', () => {
  const id = session.newId();
  session.save({ id, history: [msg(0)] });
  const f = path.join(session.sessionsDir(), `${id}.jsonl`);
  fs.appendFileSync(f, JSON.stringify({ kind: 'm', seq: 0, msg: msg(99) }) + '\n'); // replayed append
  assert.strictEqual(session.load(id).history[0].content, 'm0');
});

test('legacy .json loads and first save migrates to .jsonl', () => {
  const id = session.newId();
  fs.mkdirSync(session.sessionsDir(), { recursive: true });
  fs.writeFileSync(path.join(session.sessionsDir(), `${id}.json`),
    JSON.stringify({ id, title: 'old', created: '2020-01-01T00:00:00.000Z', history: [msg(0)] }));
  let s = session.load(id);
  assert.strictEqual(s.title, 'old');
  session.save({ id, title: 'old', history: [msg(0), msg(1)] });
  s = session.load(id);
  assert.strictEqual(s.history.length, 2);
  assert.ok(fs.existsSync(path.join(session.sessionsDir(), `${id}.jsonl`)));
});

test('summary caps 280/60, revision bumps, keyed by turnKey', () => {
  const id = session.newId();
  session.save({ id, history: [msg(0)] });
  const r1 = session.saveSummary(id, { turnKey: 't1', full: 'x'.repeat(400), compact: 'y'.repeat(100) });
  assert.strictEqual(r1.full.length, session.SUMMARY_FULL_MAX);
  assert.strictEqual(r1.compact.length, session.SUMMARY_COMPACT_MAX);
  assert.strictEqual(r1.revision, 0);
  const r2 = session.saveSummary(id, { turnKey: 't1', full: 'z', compact: 'z' });
  assert.strictEqual(r2.revision, 1);
  const s = session.load(id);
  assert.strictEqual(s.summaries.t1.revision, 1);
  assert.strictEqual(s.summaries.t1.full, 'z');
});

test('bad ids rejected (traversal guard)', () => {
  assert.throws(() => session.load('../evil'), /bad session id/);
  assert.throws(() => session.remove('a/b'), /bad session id/);
});

test('meta change (taint) appends meta line, replay keeps latest', () => {
  const id = session.newId();
  session.save({ id, history: [msg(0)] });
  session.save({ id, history: [msg(0)], tainted: true });
  assert.strictEqual(session.load(id).tainted, true);
});
