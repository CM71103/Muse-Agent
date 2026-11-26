'use strict';
// sqlite-worker.js — the SQLite queries live HERE, off the UI thread.
//
// better-sqlite3 is synchronous by design (and fast because of it), so
// asynchrony comes from the thread, not the driver: the main thread posts a
// job and goes back to rendering, this worker runs the query and posts the
// answer. Every rule (read-only driver, query_only, one statement, row caps)
// stays in the shared datasources functions, so this file cannot drift from
// the in-process behavior.
const { parentPort } = require('worker_threads');
const ds = require('./datasources');

parentPort.on('message', (m) => {
  try {
    const conn = { config: { file: m.file } };
    let result;
    if (m.kind === 'run') result = ds.sqliteRunSql(conn, m.sql, { caller: m.caller || 'agent' });
    else if (m.kind === 'tables') result = ds.sqliteTables(conn);
    else if (m.kind === 'test') result = ds.testConnection(conn);
    else throw new Error(`unknown job kind: ${m.kind}`);
    parentPort.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: { message: e.message, code: e.code } });
  }
});