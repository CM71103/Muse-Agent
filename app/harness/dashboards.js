'use strict';
// dashboards.js — live dashboards as JSON (opendashboards pattern, our spec).
// A dashboard stores QUERIES, not data: the renderer re-runs each chart's SQL
// through the datasources runner at view time (their interpreter route
// pattern) — charts stay live without the agent in the loop.
//
// Deliberate divergence from the source repo: the chart spec is ours
// ({title, type, connection, sql, x, y, value, label}) rendered by the local
// SVG chart bundle — no OpenUI Lang, no echarts option blob, no cloud.
//
// Store: ~/.muse-agent/dashboards.json
//   {dashboards: [{id, title, description, created, charts: [chart, …]}]}
// chart = {id, title, type: bar|line|area|pie|stat|table, connection, sql,
//          x?, y?[], value?, label?}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configDir } = require('./config');
const ds = require('./datasources');

const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'stat', 'table'];

function storeFile() { return path.join(configDir(), 'dashboards.json'); }
function fail(code, error) { return { ok: false, error: String(error), code: String(code || 'tool_failed') }; }

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(data.dashboards) ? data.dashboards : [];
  } catch { return []; }
}
function saveStore(dashboards) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify({ dashboards }, null, 2));
}

function listDashboards() {
  return loadStore().map(d => ({ id: d.id, title: d.title, description: d.description || '', charts: (d.charts || []).length, created: d.created }));
}
function getDashboard(id) { return loadStore().find(d => d.id === String(id || '')) || null; }

function saveDashboard(d) {
  const dashboards = loadStore();
  const rec = {
    id: /^[\w-]+$/.test(String(d.id || '')) ? String(d.id) : crypto.randomUUID(),
    title: String(d.title || 'Untitled dashboard').slice(0, 120),
    description: String(d.description || '').slice(0, 2000),
    created: d.created || new Date().toISOString(),
    charts: Array.isArray(d.charts) ? d.charts : [],
  };
  const i = dashboards.findIndex(x => x.id === rec.id);
  if (i >= 0) dashboards[i] = rec; else dashboards.push(rec);
  saveStore(dashboards);
  return rec;
}

function removeDashboard(id) {
  const dashboards = loadStore();
  const next = dashboards.filter(d => d.id !== String(id || ''));
  if (next.length === dashboards.length) return false;
  saveStore(next);
  return true;
}

// Validate + normalize one chart block. Failures name the problem so the
// model can fix the chart instead of the turn dying.
function normalizeChart(raw, index) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const type = String(c.type || '');
  if (!CHART_TYPES.includes(type)) return fail('bad_args', `chart ${index}: type must be one of ${CHART_TYPES.join(', ')}`);
  const connection = String(c.connection || '');
  if (!connection) return fail('bad_args', `chart ${index}: connection id is required (from list_data_sources)`);
  if (!ds.getConnection(connection)) return fail('connection_not_found', `chart ${index}: no data source with id "${connection}"`);
  const sql = String(c.sql || '').trim();
  if (!sql) return fail('bad_args', `chart ${index}: sql is required`);
  return {
    ok: true, chart: {
      id: /^[\w-]+$/.test(String(c.id || '')) ? String(c.id) : crypto.randomUUID(),
      title: String(c.title || `Chart ${index + 1}`).slice(0, 120),
      type, connection, sql,
      x: typeof c.x === 'string' ? c.x : undefined,
      y: Array.isArray(c.y) ? c.y.filter(v => typeof v === 'string').slice(0, 6) : (typeof c.y === 'string' ? [c.y] : undefined),
      value: typeof c.value === 'string' ? c.value : undefined,
      label: typeof c.label === 'string' ? c.label : undefined,
    },
  };
}

// Interpreter: run every chart's query live (caller 'dashboard' row cap).
// The dashboard id is resolved server-side; nothing from the request grants
// extra access — the connection registry is the only authority.
function dashboardData(id) {
  const d = getDashboard(id);
  if (!d) return fail('not_found', `no dashboard with id "${id}"`);
  const charts = [];
  for (const c of d.charts || []) {
    try {
      const conn = ds.getConnection(c.connection);
      if (!conn) { charts.push({ chartId: c.id, error: { code: 'connection_not_found', message: `data source ${c.connection} is gone` } }); continue; }
      const result = ds.sqliteRunSql(conn, c.sql, { caller: 'dashboard' });
      charts.push({ chartId: c.id, ...result });
    } catch (e) {
      charts.push({ chartId: c.id, error: { code: e.code || 'query_failed', message: String(e.message || e) } });
    }
  }
  return { ok: true, dashboard: d, charts };
}

// --- agent-facing tools ---

function dashboardTools() {
  return [
    {
      name: 'list_dashboards',
      description: 'List existing dashboards ({id, title, charts}).',
      parameters: { type: 'object', properties: {}, required: [] },
      output: { ok: true, dashboards: [{ id: 'dsh-…', title: 'Sales overview', charts: 3 }] },
      callers: ['agent'],
      async run() { return { ok: true, dashboards: listDashboards() }; },
    },
    {
      name: 'create_dashboard',
      description: 'Create a live dashboard. Each chart is ONE read-only SQL query that re-runs when the user opens the dashboard. Chart types: bar, line, area (x + one or more y columns), pie (label + value), stat (single number), table (raw rows).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          charts: {
            type: 'array', minItems: 1, maxItems: 12,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' }, type: { type: 'string', enum: CHART_TYPES },
                connection: { type: 'string', description: 'data source id from list_data_sources' },
                sql: { type: 'string' },
                x: { type: 'string' }, y: { type: 'array', items: { type: 'string' } },
                value: { type: 'string' }, label: { type: 'string' },
              },
              required: ['title', 'type', 'connection', 'sql'],
            },
          },
        },
        required: ['title', 'charts'],
      },
      output: { ok: true, id: 'dsh-…', charts: 3, note: 'open the Dashboards tab to view' },
      callers: ['agent'],
      async run(args) {
        const raw = Array.isArray(args.charts) ? args.charts.slice(0, 12) : [];
        if (!raw.length) return fail('bad_args', 'charts: at least one chart is required');
        const charts = [];
        for (let i = 0; i < raw.length; i++) {
          const n = normalizeChart(raw[i], i);
          if (!n.ok) return n;
          charts.push(n.chart);
        }
        const d = saveDashboard({ title: args.title, description: args.description, charts });
        return { ok: true, id: d.id, title: d.title, charts: charts.length, note: 'open the Dashboards tab to view' };
      },
    },
    {
      name: 'edit_dashboard',
      description: 'Edit a dashboard in place: update title/description, replace one chart (pass chartId), append a chart (no chartId), or remove one (removeChart: true). Charts not mentioned stay untouched.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' }, description: { type: 'string' },
          chartId: { type: 'string' },
          chart: {
            type: 'object',
            properties: {
              title: { type: 'string' }, type: { type: 'string', enum: CHART_TYPES },
              connection: { type: 'string' }, sql: { type: 'string' },
              x: { type: 'string' }, y: { type: 'array', items: { type: 'string' } },
              value: { type: 'string' }, label: { type: 'string' },
            },
          },
          removeChart: { type: 'boolean' },
        },
        required: ['id'],
      },
      output: { ok: true, charts: 3 },
      callers: ['agent'],
      async run(args) {
        const d = getDashboard(args.id);
        if (!d) return fail('not_found', `no dashboard with id "${args.id}"`);
        if (typeof args.title === 'string') d.title = args.title.slice(0, 120);
        if (typeof args.description === 'string') d.description = args.description.slice(0, 2000);
        d.charts = d.charts || [];
        if (args.chartId && args.removeChart) {
          const before = d.charts.length;
          d.charts = d.charts.filter(c => c.id !== String(args.chartId));
          if (d.charts.length === before) return fail('not_found', `no chart with id "${args.chartId}"`);
        } else if (args.chart) {
          const n = normalizeChart(args.chart, d.charts.length);
          if (!n.ok) return n;
          if (args.chartId) {
            const i = d.charts.findIndex(c => c.id === String(args.chartId));
            if (i < 0) return fail('not_found', `no chart with id "${args.chartId}"`);
            n.chart.id = String(args.chartId);
            d.charts[i] = n.chart;
          } else {
            d.charts.push(n.chart);
          }
        }
        saveDashboard(d);
        return { ok: true, charts: d.charts.length };
      },
    },
    {
      name: 'delete_dashboard',
      description: 'Delete a dashboard the user asked to remove. Do not delete unless asked.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: { ok: true },
      callers: ['agent'],
      async run(args) {
        return removeDashboard(args.id) ? { ok: true } : fail('not_found', `no dashboard with id "${args.id}"`);
      },
    },
  ];
}

module.exports = {
  CHART_TYPES,
  listDashboards, getDashboard, saveDashboard, removeDashboard,
  normalizeChart, dashboardData, dashboardTools,
};
