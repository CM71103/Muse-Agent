const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-dash-'));
process.env.MUSE_HOME = home;
const ds = require('../datasources');
const dash = require('../dashboards');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-dash-db-'));
  const file = path.join(dir, 'fixture.db');
  const Database = require('better-sqlite3');
  const db = new Database(file);
  db.exec('CREATE TABLE sales (month TEXT, revenue REAL)');
  db.exec("INSERT INTO sales VALUES ('jan', 10), ('feb', 20), ('mar', 30)");
  db.close();
  return { file, dir };
}

const { file, dir } = makeDb();
const rec = ds.saveConnection({ name: 'sales', type: 'sqlite', config: { file } });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const chart = (over = {}) => ({
  title: 'Revenue by month', type: 'bar', connection: rec.id,
  sql: 'SELECT month, revenue FROM sales', x: 'month', y: ['revenue'], ...over,
});

test('create_dashboard validates charts and stores queries, not data', async () => {
  const tools = dash.dashboardTools();
  const create = tools.find(t => t.name === 'create_dashboard');

  const badType = await create.run({ title: 'x', charts: [chart({ type: 'pie3d' })] }, {});
  assert.equal(badType.ok, false);
  assert.equal(badType.code, 'bad_args');

  const badConn = await create.run({ title: 'x', charts: [chart({ connection: 'ghost' })] }, {});
  assert.equal(badConn.ok, false);
  assert.equal(badConn.code, 'connection_not_found');

  const ok = await create.run({ title: 'Sales overview', description: 'live', charts: [chart(), chart({ title: 'Share', type: 'pie', label: 'month', value: 'revenue' })] }, {});
  assert.equal(ok.ok, true);
  assert.equal(ok.charts, 2);
  const d = dash.getDashboard(ok.id);
  assert.equal(d.charts[0].sql, 'SELECT month, revenue FROM sales');
  assert.equal(d.charts[0].type, 'bar');
});

test('edit_dashboard replaces one chart and leaves the rest alone', async () => {
  const created = await dash.dashboardTools().find(t => t.name === 'create_dashboard')
    .run({ title: 'Edit me', charts: [chart({ title: 'A' }), chart({ title: 'B' })] }, {});
  const d = dash.getDashboard(created.id);
  const chartB = d.charts[1];

  const edit = dash.dashboardTools().find(t => t.name === 'edit_dashboard');
  const res = await edit.run({ id: created.id, chartId: chartB.id, chart: chart({ title: 'B2', type: 'line' }) }, {});
  assert.equal(res.ok, true);
  const after = dash.getDashboard(created.id);
  assert.equal(after.charts[0].title, 'A', 'unchanged chart stays intact');
  assert.equal(after.charts[1].title, 'B2');
  assert.equal(after.charts[1].type, 'line');
  assert.equal(after.charts[1].id, chartB.id, 'chart identity is preserved on replace');

  const removed = await edit.run({ id: created.id, chartId: after.charts[0].id, removeChart: true }, {});
  assert.equal(removed.ok, true);
  assert.equal(dash.getDashboard(created.id).charts.length, 1);

  const del = await dash.dashboardTools().find(t => t.name === 'delete_dashboard').run({ id: created.id }, {});
  assert.equal(del.ok, true);
  assert.equal(dash.getDashboard(created.id), null);
});

test('dashboardData re-runs queries live and maps failures to per-chart errors', async () => {
  const created = await dash.dashboardTools().find(t => t.name === 'create_dashboard')
    .run({ title: 'Live', charts: [chart(), chart({ title: 'Bad', sql: 'SELECT * FROM missing_table' })] }, {});
  const data = dash.dashboardData(created.id);
  assert.equal(data.ok, true);
  assert.deepEqual(data.charts[0].columns, ['month', 'revenue']);
  assert.equal(data.charts[0].rows.length, 3);
  assert.ok(data.charts[1].error.code, 'chart errors carry a machine-readable code');
  assert.match(data.charts[1].error.message, /missing_table/);

  assert.equal(dash.dashboardData('ghost').ok, false);
});

test('chart normalization keeps columns bounded and ids stable', () => {
  const n = dash.normalizeChart(chart({ y: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }), 0);
  assert.equal(n.ok, true);
  assert.equal(n.chart.y.length, 6);
  assert.ok(/^[\w-]+$/.test(n.chart.id));
});
