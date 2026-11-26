'use strict';
// The async SQLite facade: the same rules as the in-process functions (read
// only, one statement, row caps), but the query runs off the calling thread.
// The third test is the contract that matters: while a query works, the
// calling thread keeps ticking. That is what "asynchronous" means here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ds = require('../datasources');
const Database = require('better-sqlite3');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sqlite-async-'));
  const file = path.join(dir, 't.db');
  const db = new Database(file);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  const ins = db.prepare('INSERT INTO t (name) VALUES (?)');
  // bulk inserts in one transaction: per-insert commits let real-time virus
  // scanning rewrite the file thousands of times and stretch this to ~30s
  db.transaction(() => { for (let i = 0; i < 50; i++) ins.run(`row-${i}`); })();
  db.exec('CREATE TABLE big (x INTEGER)');
  const insBig = db.prepare('INSERT INTO big (x) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < 3000; i++) insBig.run(i); })();
  db.close();
  return { dir, file };
}

test('the async facade returns the same rows as the in-process functions', async () => {
  const { dir, file } = tempDb();
  try {
    const conn = { config: { file } };
    const r = await ds.sqliteRunSqlAsync(conn, 'SELECT id, name FROM t ORDER BY id');
    assert.equal(r.rows.length, 50);
    assert.deepEqual(r.columns, ['id', 'name']);
    const tables = await ds.sqliteTablesAsync(conn);
    assert.deepEqual(tables.map((t) => t.name).sort(), ['big', 't']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('read-only refusal survives the worker boundary with its code', async () => {
  const { dir, file } = tempDb();
  try {
    const conn = { config: { file } };
    await assert.rejects(() => ds.sqliteRunSqlAsync(conn, 'DELETE FROM t'), (e) => e.code === 'read_only');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a slow query runs off-thread: the caller keeps ticking while it works', async () => {
  const { dir, file } = tempDb();
  try {
    const conn = { config: { file } };
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const r = await ds.sqliteRunSqlAsync(conn, 'SELECT count(*) AS n FROM big a, big b');
      assert.equal(r.rows[0].n, 9000000);
    } finally { clearInterval(timer); }
    assert.ok(ticks > 0, `the calling thread kept running during the query (ticks=${ticks})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});