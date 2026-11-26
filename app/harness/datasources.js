'use strict';
// datasources.js — the SourceTool contract ported from
// thesysdev/opendashboards (lib/sources/types.ts + lib/tools/index.ts),
// zero-dep Muse flavor.
//
// Contract: a data tool is {name, description, parameters(JSON Schema),
// output(example), callers, run(args, ctx)} and every failure comes back as
// {ok:false, error, code} so the MODEL reads it and retries — the turn never
// dies on a tool error.
//
// Security invariants kept from the source repo:
//   - connection ids are resolved HERE, from the server-side registry;
//     credentials never appear in model args (and never in the registry file
//     either — future remote connectors use the OS vault)
//   - read-only is enforced at the DRIVER, not the prompt: the SQLite
//     connector is the analogue of their BEGIN-READ-ONLY cursor trick
//   - per-caller row caps (200 for agent exploration, 10k for dashboards)
//
// Registry: ~/.muse-agent/datasources.json
//   {connections: [{id, name, type, config, created}]}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configDir } = require('./config');

const ROW_CAPS = { agent: 200, dashboard: 10000 };

function fail(code, error) { return { ok: false, error: String(error), code: String(code || 'tool_failed') }; }
function codedError(code, message) { const e = new Error(String(message)); e.code = code; return e; }

// --- connection registry ---

function registryFile() { return path.join(configDir(), 'datasources.json'); }

function listConnections() {
  try {
    const data = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    return Array.isArray(data.connections) ? data.connections : [];
  } catch { return []; }
}

function getConnection(id) {
  return listConnections().find(c => c && c.id === String(id || '')) || null;
}

function saveConnection({ id, name, type, config }) {
  const conns = listConnections();
  const rec = {
    id: /^[\w-]+$/.test(String(id || '')) ? String(id) : crypto.randomUUID(),
    name: String(name || 'unnamed').slice(0, 80),
    type: String(type || 'sqlite'),
    config: config && typeof config === 'object' ? config : {},
    created: new Date().toISOString(),
  };
  const i = conns.findIndex(c => c.id === rec.id);
  if (i >= 0) { rec.created = conns[i].created; conns[i] = rec; } else conns.push(rec);
  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify({ connections: conns }, null, 2));
  return rec;
}

function removeConnection(id) {
  const conns = listConnections();
  const next = conns.filter(c => c.id !== String(id || ''));
  if (next.length === conns.length) return false;
  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify({ connections: next }, null, 2));
  return true;
}

// --- SQLite connector ---
// Read-only at the driver level (their BEGIN READ ONLY analogue):
//   readonly open + fileMustExist + PRAGMA query_only; prepare() refuses
//   multi-statement strings; non-reader statements are refused explicitly.

function openSqlite(conn) {
  const file = conn && conn.config && conn.config.file;
  if (!file || typeof file !== 'string') throw codedError('bad_config', 'connection has no database file');
  if (!fs.existsSync(file)) throw codedError('connection_unavailable', `database file not found: ${file}`);
  const Database = require('better-sqlite3');
  return new Database(file, { readonly: true, fileMustExist: true });
}

function sqliteRunSql(conn, sql, { caller = 'agent' } = {}) {
  const text = String(sql || '');
  if (!text.trim()) throw codedError('bad_args', 'sql is required');
  const db = openSqlite(conn);
  try {
    db.pragma('query_only = ON');
    const stmt = db.prepare(text);   // better-sqlite3: exactly one statement
    if (!stmt.reader) throw codedError('read_only', 'only read queries are allowed (this connection is read-only)');
    const cap = ROW_CAPS[caller] || ROW_CAPS.agent;
    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate()) {
      if (rows.length >= cap) { truncated = true; break; }
      rows.push(row);
    }
    let columns;
    try { columns = stmt.columns().map(c => c.name); }
    catch { columns = rows.length ? Object.keys(rows[0]) : []; }
    return { columns, rows, truncated };
  } finally { db.close(); }
}

function sqliteTables(conn) {
  const db = openSqlite(conn);
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all();
    return tables.slice(0, 200).map(t => {
      let columns = [];
      try {
        columns = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all()
          .map(c => ({ name: c.name, type: c.type || '', pk: !!c.pk }));
      } catch { /* virtual tables may refuse pragma — name only */ }
      return { name: t.name, columns };
    });
  } finally { db.close(); }
}

function testConnection(conn) {
  try {
    const db = openSqlite(conn);
    try { db.prepare('SELECT 1 AS ok').get(); return { ok: true }; }
    finally { db.close(); }
  } catch (e) { return { ok: false, error: e.message, code: e.code || 'connection_invalid' }; }
}

// --- async facade ----------------------------------------------------------
// The driver is synchronous by design (that is why it is fast), so asynchrony
// comes from the thread, not the API: tool calls go to a worker and the UI
// thread never waits on a query. Workers unavailable (or dying mid-job) fall
// back to the same functions in-process: behavior is identical, only the
// latency lands on the caller instead of the whole app.
const { Worker } = require('worker_threads');
let sqliteWorker = null;
let jobSeq = 0;
const jobs = new Map();

function sqliteWorkerRef() {
  if (sqliteWorker) return sqliteWorker;
  // execArgv: [] — a worker inherits the parent's node flags otherwise, and
  // under the test runner that means booting the worker as another test
  // runner (a ~30s stall per call). This worker needs zero flags.
  const w = new Worker(path.join(__dirname, 'sqlite-worker.js'), { execArgv: [] });
  w.on('message', (m) => {
    const job = jobs.get(m.id);
    if (!job) return;
    jobs.delete(m.id);
    if (!jobs.size) idleWorker(w);
    if (m.ok) { job.resolve(m.result); return; }
    const err = new Error((m.error && m.error.message) || 'query failed');
    if (m.error && m.error.code) err.code = m.error.code;
    job.reject(err);
  });
  w.on('error', () => {
    sqliteWorker = null;
    for (const [, job] of jobs) job.reject(new Error('sqlite worker stopped'));
    jobs.clear();
  });
  w.on('exit', () => {
    if (sqliteWorker === w) sqliteWorker = null;
    for (const [, job] of jobs) job.reject(new Error('sqlite worker stopped'));
    jobs.clear();
  });
  sqliteWorker = w;
  idleWorker(w);
  return w;
}

// The message channel counts as an active handle the moment a listener is
// attached, so an idle worker would keep the whole process alive forever.
// Ref only while jobs are pending: the loop is free between queries, and a
// waiting caller still holds the process through its own work.
function busyWorker(w) { if (typeof w.ref === 'function') w.ref(); }
function idleWorker(w) { if (typeof w.unref === 'function') w.unref(); }

function callSqliteWorker(kind, payload) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = sqliteWorkerRef(); } catch (e) { reject(e); return; }
    const id = ++jobSeq;
    jobs.set(id, { resolve, reject });
    busyWorker(w);
    w.postMessage({ id, kind, ...payload });
  });
}

async function sqliteRunSqlAsync(conn, sql, opts = {}) {
  try {
    return await callSqliteWorker('run', { file: conn && conn.config && conn.config.file, sql, caller: opts.caller || 'agent' });
  } catch (e) {
    if (e && e.code) throw e;                 // a real query failure: surface it
    return sqliteRunSql(conn, sql, opts);      // infrastructure fell back
  }
}

async function sqliteTablesAsync(conn) {
  try {
    return await callSqliteWorker('tables', { file: conn && conn.config && conn.config.file });
  } catch (e) {
    if (e && e.code) throw e;
    return sqliteTables(conn);
  }
}

async function testConnectionAsync(conn) {
  try {
    return await callSqliteWorker('test', { file: conn && conn.config && conn.config.file });
  } catch (e) {
    return testConnection(conn);
  }
}

// --- uniform runner: resolve the connection server-side, map every failure ---

function withConnection(args, fn) {
  const id = args && typeof args.connection === 'string' ? args.connection : '';
  if (!id) return fail('bad_args', 'connection id is required (from list_data_sources)');
  const conn = getConnection(id);
  if (!conn) return fail('connection_not_found', `no data source with id "${id}": ids come from list_data_sources`);
  try {
    const r = fn(conn);
    return r && typeof r.then === 'function' ? r.catch((e) => fail(e.code || 'query_failed', e.message)) : r;
  }
  catch (e) { return fail(e.code || 'query_failed', e.message); }
}

// --- agent-facing SourceTools ---

function dataTools() {
  return [
    {
      name: 'list_data_sources',
      description: 'List registered data sources ({id, name, type}). Pass the id to sqlite_tables / sqlite_run_sql. Data sources are read-only.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: { ok: true, connections: [{ id: 'src-…', name: 'sales', type: 'sqlite', detail: 'D:/data/sales.db' }] },
      callers: ['agent'],
      async run() {
        const connections = listConnections().map(c => ({
          id: c.id, name: c.name, type: c.type,
          detail: c.type === 'sqlite' ? (c.config && c.config.file) || '' : '',
        }));
        return { ok: true, connections, ...(connections.length ? {} : { note: 'no data sources registered yet: the user can add one from the command palette' }) };
      },
    },
    {
      name: 'sqlite_tables',
      description: 'List tables/views and columns of a registered SQLite data source. Explore the schema before writing SQL.',
      parameters: {
        type: 'object',
        properties: { connection: { type: 'string', description: 'data source id from list_data_sources' } },
        required: ['connection'],
      },
      output: { ok: true, tables: [{ name: 'orders', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'total', type: 'REAL', pk: false }] }] },
      callers: ['agent'],
      async run(args) {
        return withConnection(args, async (conn) => ({ ok: true, tables: await sqliteTablesAsync(conn) }));
      },
    },
    {
      name: 'sqlite_run_sql',
      description: 'Run ONE read-only SQL SELECT against a registered SQLite data source. Returns {columns, rows, truncated}. Writes and DDL are refused by the driver, not by policy.',
      parameters: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'data source id from list_data_sources' },
          sql: { type: 'string', description: 'a single SELECT statement' },
        },
        required: ['connection', 'sql'],
      },
      output: { ok: true, columns: ['id', 'total'], rows: [{ id: 1, total: 42.5 }], truncated: false },
      callers: ['agent', 'dashboard'],
      async run(args, ctx) {
        return withConnection(args, async (conn) => ({
          ok: true,
          ...await sqliteRunSqlAsync(conn, args.sql, { caller: (ctx && ctx.dataCaller) || 'agent' }),
        }));
      },
    },
  ];
}

module.exports = {
  ROW_CAPS,
  listConnections, getConnection, saveConnection, removeConnection, testConnection,
  sqliteRunSql, sqliteTables, withConnection, fail,
  sqliteRunSqlAsync, sqliteTablesAsync, testConnectionAsync,
  dataTools,
};
