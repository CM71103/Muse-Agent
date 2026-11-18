// charts.ts — hand-rolled SVG chart renderer for live dashboards.
// Deliberate divergence from the opendashboards port plan: no echarts option
// blobs and no OpenUI Lang — our chart spec ({type, x, y, value, label}) plus
// a QueryResult ({columns, rows}) renders straight to SVG. Zero dependencies,
// CSP-'self' compatible, native <title> tooltips, theme-neutral palette.

type ChartSpec = {
  id?: string; title?: string; type: string;
  x?: string; y?: string[]; value?: string; label?: string;
};
type QueryData = {
  columns?: string[]; rows?: Record<string, unknown>[];
  truncated?: boolean;
  error?: { code?: string; message?: string };
};

const PALETTE = ['#62d1b8', '#efc46d', '#7aa2f7', '#e0a0c0', '#9ece6a', '#f7768e'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 480, H = 300, PAD = { l: 44, r: 12, t: 16, b: 34 };

function svgEl(name: string, attrs: Record<string, string | number> = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
function html(name: string, cls?: string, text?: string) {
  const n = document.createElement(name);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}
function fmt(n: number): string {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n * 100) / 100);
}
function tip(node: Element, text: string) {
  const t = svgEl('title');
  t.textContent = text;
  node.append(t);
}

// --- axis helpers (categorical x, numeric y) ---

function yScale(values: number[], height: number) {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  return (v: number) => PAD.t + height - ((v - min) / span) * height;
}
function drawYAxis(g: Element, min: number, max: number, height: number) {
  const span = max - min || 1;
  for (let i = 0; i <= 3; i++) {
    const v = min + (span * i) / 3;
    const y = PAD.t + height - (i / 3) * height;
    g.append(svgEl('line', { x1: PAD.l, y1: y, x2: W - PAD.r, y2: y, class: 'mc-grid' }));
    const label = svgEl('text', { x: PAD.l - 6, y: y + 3, 'text-anchor': 'end', class: 'mc-tick' });
    label.textContent = fmt(v);
    g.append(label);
  }
}
function drawXLabels(g: Element, labels: string[], step: number, y: number) {
  const every = Math.max(1, Math.ceil(labels.length / 8));
  labels.forEach((lb, i) => {
    if (i % every) return;
    const t = svgEl('text', { x: PAD.l + step * (i + 0.5), y, 'text-anchor': 'middle', class: 'mc-tick' });
    t.textContent = String(lb).length > 12 ? String(lb).slice(0, 11) + '…' : String(lb);
    g.append(t);
  });
}

// --- chart renderers (each returns an SVG element) ---

function renderBars(c: ChartSpec, d: QueryData) {
  const rows = d.rows || [];
  const xKey = c.x || d.columns?.[0] || 'x';
  const yKeys = (c.y && c.y.length ? c.y : [d.columns?.[1] || 'y']).filter(k => d.columns?.includes(k));
  const all = rows.flatMap(r => yKeys.map(k => num(r[k])));
  const max = Math.max(0, ...all), min = Math.min(0, ...all), span = max - min || 1;
  const innerH = H - PAD.t - PAD.b;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mc-svg', role: 'img' });
  const g = svgEl('g');
  drawYAxis(g, min, max, innerH);
  const step = (W - PAD.l - PAD.r) / Math.max(1, rows.length);
  const barW = Math.max(2, (step * 0.72) / yKeys.length);
  rows.forEach((r, i) => {
    yKeys.forEach((k, j) => {
      const v = num(r[k]);
      const h = (v / span) * innerH;
      const y = PAD.t + innerH - ((v - min) / span) * innerH;
      const rect = svgEl('rect', {
        x: PAD.l + step * i + step * 0.14 + barW * j, y,
        width: barW, height: Math.max(1, Math.abs(h)), rx: 2,
        fill: PALETTE[j % PALETTE.length],
      });
      tip(rect, `${r[xKey]} · ${k}: ${fmt(v)}`);
      g.append(rect);
    });
  });
  drawXLabels(g, rows.map(r => String(r[xKey] ?? '')), step, H - PAD.b + 16);
  svg.append(g);
  return svg;
}

function renderLine(c: ChartSpec, d: QueryData, area: boolean) {
  const rows = d.rows || [];
  const xKey = c.x || d.columns?.[0] || 'x';
  const yKeys = (c.y && c.y.length ? c.y : [d.columns?.[1] || 'y']).filter(k => d.columns?.includes(k));
  const all = rows.flatMap(r => yKeys.map(k => num(r[k])));
  const max = Math.max(0, ...all), min = Math.min(0, ...all), span = max - min || 1;
  const innerH = H - PAD.t - PAD.b;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mc-svg', role: 'img' });
  const g = svgEl('g');
  drawYAxis(g, min, max, innerH);
  const step = rows.length > 1 ? (W - PAD.l - PAD.r) / (rows.length - 1) : 0;
  const cx = (i: number) => PAD.l + (rows.length > 1 ? step * i : (W - PAD.l - PAD.r) / 2);
  const cy = (v: number) => PAD.t + innerH - ((v - min) / span) * innerH;
  yKeys.forEach((k, j) => {
    const pts = rows.map((r, i) => `${cx(i)},${cy(num(r[k]))}`);
    if (area && rows.length) {
      const base = cy(min);
      const poly = svgEl('polygon', {
        points: `${cx(0)},${base} ${pts.join(' ')} ${cx(rows.length - 1)},${base}`,
        fill: PALETTE[j % PALETTE.length], opacity: 0.18,
      });
      g.append(poly);
    }
    if (rows.length > 1) {
      g.append(svgEl('polyline', {
        points: pts.join(' '), fill: 'none',
        stroke: PALETTE[j % PALETTE.length], 'stroke-width': 2, 'stroke-linejoin': 'round',
      }));
    }
    rows.forEach((r, i) => {
      const dot = svgEl('circle', { cx: cx(i), cy: cy(num(r[k])), r: 3, fill: PALETTE[j % PALETTE.length] });
      tip(dot, `${r[xKey]} · ${k}: ${fmt(num(r[k]))}`);
      g.append(dot);
    });
  });
  drawXLabels(g, rows.map(r => String(r[xKey] ?? '')), rows.length > 1 ? step : W - PAD.l - PAD.r, H - PAD.b + 16);
  svg.append(g);
  return svg;
}

function renderPie(c: ChartSpec, d: QueryData) {
  const rows = d.rows || [];
  const labelKey = c.label || d.columns?.[0] || 'label';
  const valueKey = c.value || c.y?.[0] || d.columns?.[1] || 'value';
  const total = rows.reduce((s, r) => s + Math.abs(num(r[valueKey])), 0) || 1;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mc-svg', role: 'img' });
  const g = svgEl('g');
  const cx = W * 0.36, cy = H / 2, R = Math.min(W, H) * 0.32;
  let angle = -Math.PI / 2;
  rows.slice(0, 12).forEach((r, i) => {
    const frac = Math.abs(num(r[valueKey])) / total;
    const sweep = frac * Math.PI * 2;
    const x1 = cx + R * Math.cos(angle), y1 = cy + R * Math.sin(angle);
    angle += sweep;
    const x2 = cx + R * Math.cos(angle), y2 = cy + R * Math.sin(angle);
    const arc = svgEl('path', {
      d: `M ${cx} ${cy} L ${x1} ${y1} A ${R} ${R} 0 ${frac > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`,
      fill: PALETTE[i % PALETTE.length],
    });
    tip(arc, `${r[labelKey]}: ${fmt(num(r[valueKey]))} (${Math.round(frac * 100)}%)`);
    g.append(arc);
  });
  rows.slice(0, 12).forEach((r, i) => {
    const y = PAD.t + 18 + i * 22;
    g.append(svgEl('rect', { x: W * 0.68, y: y - 9, width: 11, height: 11, rx: 2, fill: PALETTE[i % PALETTE.length] }));
    const t = svgEl('text', { x: W * 0.68 + 17, y, class: 'mc-tick' });
    const label = String(r[labelKey] ?? '');
    t.textContent = `${label.length > 14 ? label.slice(0, 13) + '…' : label} · ${fmt(num(r[valueKey]))}`;
    g.append(t);
  });
  svg.append(g);
  return svg;
}

function renderStat(c: ChartSpec, d: QueryData) {
  const valueKey = c.value || c.y?.[0] || d.columns?.[d.columns.length - 1] || 'value';
  const first = (d.rows || [])[0] || {};
  const wrap = html('div', 'mc-stat');
  wrap.append(html('div', 'mc-stat-value', fmt(num(first[valueKey]))));
  const sub = String(first[c.label || d.columns?.[0] || ''] ?? '');
  if (sub) wrap.append(html('div', 'mc-stat-sub', sub));
  return wrap;
}

function renderTable(c: ChartSpec, d: QueryData) {
  const wrap = html('div', 'mc-table-wrap');
  const table = html('table', 'mc-table');
  const thead = html('thead');
  const trh = html('tr');
  for (const col of d.columns || []) trh.append(html('th', undefined, col));
  thead.append(trh);
  const tbody = html('tbody');
  for (const row of (d.rows || []).slice(0, 100)) {
    const tr = html('tr');
    for (const col of d.columns || []) {
      const v = row[col];
      tr.append(html('td', undefined, v == null ? '' : String(v).length > 120 ? String(v).slice(0, 119) + '…' : String(v)));
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

// --- public surface ---

function renderChart(host: Element, chart: ChartSpec, data: QueryData) {
  host.replaceChildren();
  const card = html('div', 'mc-card');
  card.append(html('h3', 'mc-title', chart.title || 'Chart'));
  const body = html('div', 'mc-body');
  if (data && data.error) {
    body.classList.add('mc-error');
    body.append(html('p', undefined, `Chart failed: ${data.error.message || data.error.code || 'query error'}`));
  } else if (!data || !(data.rows || []).length) {
    body.append(html('p', 'mc-empty', 'No rows returned.'));
  } else {
    try {
      switch (chart.type) {
        case 'bar': body.append(renderBars(chart, data)); break;
        case 'line': body.append(renderLine(chart, data, false)); break;
        case 'area': body.append(renderLine(chart, data, true)); break;
        case 'pie': body.append(renderPie(chart, data)); break;
        case 'stat': body.append(renderStat(chart, data)); break;
        case 'table': body.append(renderTable(chart, data)); break;
        default: body.append(html('p', 'mc-empty', `Unknown chart type: ${chart.type}`));
      }
    } catch (err) {
      body.classList.add('mc-error');
      body.append(html('p', undefined, `Chart failed to render: ${String(err && (err as Error).message || err)}`));
    }
  }
  card.append(body);
  if (data && data.truncated) card.append(html('small', 'mc-note', 'rows truncated at the display cap'));
  host.append(card);
}

function renderDashboard(container: Element, dashboard: { title?: string; charts?: ChartSpec[] }, datasets: Record<string, QueryData>) {
  container.replaceChildren();
  const head = html('div', 'mc-dash-head');
  head.append(html('h2', 'mc-dash-title', dashboard.title || 'Dashboard'));
  container.append(head);
  const grid = html('div', 'mc-grid-wrap');
  for (const chart of dashboard.charts || []) {
    const cell = html('div', `mc-cell mc-t-${chart.type}`);   // mc-t-* avoids colliding with inner chart classes (e.g. .mc-stat)
    renderChart(cell, chart, datasets[chart.id || ''] || {});
    grid.append(cell);
  }
  container.append(grid);
}

(window as any).MuseCharts = { renderChart, renderDashboard };
