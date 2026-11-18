const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ds-'));
process.env.MUSE_HOME = home;
const ds = require('../datasources');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ds-db-'));
  const file = path.join(dir, 'fixture.db');
  const Database = require('better-sqlite3');
  const db = new Database(file);
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL, region TEXT)');
  const ins = db.prepare('INSERT INTO orders (total, region) VALUES (?, ?)');
  for (let i = 0; i < 250; i++) ins.run(i * 1.5, i % 2 ? 'east' : 'west');
  db.close();
  return { file, dir };
}

test('registry CRUD keeps connections server-side', () => {
  const { file, dir } = makeDb();
  const rec = ds.saveConnection({ name: 'sales', type: 'sqlite', config: { file } });
  assert.ok(rec.id);
  assert.equal(ds.getConnection(rec.id).name, 'sales');
  assert.equal(ds.getConnection('nope'), null);
  assert.equal(ds.testConnection(ds.getConnection(rec.id)).ok, true);
  assert.equal(ds.removeConnection(rec.id), true);
  assert.equal(ds.getConnection(rec.id), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sqlite_run_sql is read-only at the driver and reports unknown connections', async () => {
  const { file, dir } = makeDb();
  const rec = ds.saveConnection({ name: 'sales', type: 'sqlite', config: { file } });
  const [tablesTool, runTool] = ds.dataTools().filter(t => t.name !== 'list_data_sources');

  const bad = await runTool.run({ connection: 'ghost', sql: 'SELECT 1' }, {});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'connection_not_found');

  const write = await runTool.run({ connection: rec.id, sql: 'INSERT INTO orders (total) VALUES (1)' }, {});
  assert.equal(write.ok, false);
  assert.equal(write.code, 'read_only');

  const drop = await runTool.run({ connection: rec.id, sql: 'DROP TABLE orders' }, {});
  assert.equal(drop.ok, false);

  const multi = await runTool.run({ connection: rec.id, sql: 'SELECT 1; DELETE FROM orders' }, {});
  assert.equal(multi.ok, false, 'multi-statement strings must be refused');
  // the data is still intact — nothing wrote through the driver
  const count = ds.sqliteRunSql(ds.getConnection(rec.id), 'SELECT COUNT(*) AS n FROM orders');
  assert.equal(count.rows[0].n, 250);

  const tables = await tablesTool.run({ connection: rec.id }, {});
  assert.equal(tables.ok, true);
  assert.equal(tables.tables[0].name, 'orders');
  assert.deepEqual(tables.tables[0].columns.map(c => c.name), ['id', 'total', 'region']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('row caps differ per caller and set the truncated flag', () => {
  const { file, dir } = makeDb();
  const rec = ds.saveConnection({ name: 'sales', type: 'sqlite', config: { file } });
  const conn = ds.getConnection(rec.id);
  const agent = ds.sqliteRunSql(conn, 'SELECT * FROM orders', { caller: 'agent' });
  assert.equal(agent.rows.length, 200);
  assert.equal(agent.truncated, true);
  const dash = ds.sqliteRunSql(conn, 'SELECT * FROM orders', { caller: 'dashboard' });
  assert.equal(dash.rows.length, 250);
  assert.equal(dash.truncated, false);
  assert.deepEqual(dash.columns, ['id', 'total', 'region']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failures carry machine-readable codes for model retries', async () => {
  const { file, dir } = makeDb();
  const rec = ds.saveConnection({ name: 'sales', type: 'sqlite', config: { file } });
  const runTool = ds.dataTools().find(t => t.name === 'sqlite_run_sql');
  const noArgs = await runTool.run({}, {});
  assert.equal(noArgs.ok, false);
  assert.equal(noArgs.code, 'bad_args');
  const noSql = await runTool.run({ connection: rec.id }, {});
  assert.equal(noSql.ok, false);
  assert.equal(noSql.code, 'bad_args');
  const gone = await ds.withConnection({ connection: rec.id }, () => {
    const e = new Error('boom'); e.code = 'custom_x'; throw e;
  });
  assert.equal(gone.code, 'custom_x', 'inner codes survive the runner');
  fs.rmSync(dir, { recursive: true, force: true });
});
