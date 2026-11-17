'use strict';
/* Dashboard template logic — sample data plus real filter/sort/paginate behaviour.
   Replace SEED with a fetch() against your own endpoint before shipping. */

const SEED = [
  ['Northwind Traders', 'Active', 128, 4200, '2026-03-04'],
  ['Aurora Labs', 'Paused', 42, 1180, '2026-02-11'],
  ['Kestrel Group', 'Active', 310, 9840, '2026-03-22'],
  ['Blue Harbor', 'Closed', 7, 210, '2025-12-01'],
  ['Fernwood Media', 'Active', 96, 3050, '2026-03-18'],
  ['Solstice AI', 'Active', 214, 7420, '2026-03-27'],
  ['Riverbend Co', 'Paused', 31, 690, '2026-01-30'],
  ['Copperfield', 'Active', 158, 5110, '2026-03-09'],
  ['Larkspur Health', 'Active', 87, 2440, '2026-02-26'],
  ['Ironwood', 'Closed', 12, 380, '2025-11-14'],
  ['Windward Sea', 'Active', 173, 6030, '2026-03-21'],
  ['Pinehollow', 'Paused', 54, 1320, '2026-02-05'],
];

const COLUMNS = [
  { key: 'name', label: 'Account', numeric: false },
  { key: 'status', label: 'Status', numeric: false },
  { key: 'orders', label: 'Orders', numeric: true },
  { key: 'revenue', label: 'Revenue', numeric: true },
  { key: 'last', label: 'Last order', numeric: false },
];

const PAGE_SIZE = 8;
const view = { sortKey: 'revenue', sortDir: 'desc', page: 1, failed: false };

const numberFormat = new Intl.NumberFormat();
const moneyFormat = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const $ = (id) => document.getElementById(id);

function records() {
  const query = $('search').value.trim().toLowerCase();
  const status = $('status').value;
  const cutoff = Date.now() - Number($('range').value) * 86400000;
  const rows = SEED.map(([name, statusValue, orders, revenue, last]) => ({ name, status: statusValue, orders, revenue, last }))
    .filter(row => (!query || row.name.toLowerCase().includes(query))
      && (!status || row.status === status)
      && Date.parse(row.last) >= cutoff);
  const column = COLUMNS.find(item => item.key === view.sortKey);
  rows.sort((a, b) => {
    const left = a[column.key], right = b[column.key];
    const lower = column.numeric ? left - right : String(left).localeCompare(String(right));
    return view.sortDir === 'asc' ? lower : -lower;
  });
  return rows;
}

function metricCard(label, value, note, tone) {
  const card = document.createElement('div');
  card.className = 'card metric';
  const caption = document.createElement('span'); caption.textContent = label;
  const strong = document.createElement('strong'); strong.textContent = value;
  const footnote = document.createElement('em'); footnote.textContent = note;
  if (tone) footnote.className = tone;
  card.append(caption, strong, footnote);
  return card;
}

function renderMetrics(rows) {
  const orders = rows.reduce((total, row) => total + row.orders, 0);
  const revenue = rows.reduce((total, row) => total + row.revenue, 0);
  $('metrics').replaceChildren(
    metricCard('Accounts', numberFormat.format(rows.length), 'of ' + SEED.length + ' total'),
    metricCard('Orders', numberFormat.format(orders), '+8.4% vs prior period', 'up'),
    metricCard('Revenue', moneyFormat.format(revenue), 'net of refunds'),
    metricCard('Active', numberFormat.format(rows.filter(row => row.status === 'Active').length),
      'paused ' + rows.filter(row => row.status === 'Paused').length),
  );
}

function renderChart(rows) {
  const top = rows.slice(0, 8);
  const total = top.reduce((sum, row) => sum + row.revenue, 0) || 1;
  const width = 100 / Math.max(top.length, 1);
  const bars = top.map((row, index) => {
    const height = Math.max(2, row.revenue / total * 100);
    return '<rect x="' + (index * width + width * 0.15).toFixed(2) + '" y="' + (100 - height).toFixed(2)
      + '" width="' + (width * 0.7).toFixed(2) + '" height="' + height.toFixed(2)
      + '" rx="1"><title>' + row.name + ': ' + moneyFormat.format(row.revenue) + '</title></rect>';
  }).join('');
  $('chart').innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">'
    + '<line x1="0" y1="99.7" x2="100" y2="99.7" stroke="#e3dfd8" stroke-width="0.6"/>' + bars + '</svg>';
}

function renderHead() {
  $('head').replaceChildren(...COLUMNS.map(column => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.setAttribute('aria-sort', view.sortKey === column.key ? (view.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'sort';
    trigger.textContent = column.label;
    trigger.title = 'Sort by ' + column.label;
    trigger.addEventListener('click', () => {
      if (view.sortKey === column.key) view.sortDir = view.sortDir === 'asc' ? 'desc' : 'asc';
      else { view.sortKey = column.key; view.sortDir = column.numeric ? 'desc' : 'asc'; }
      render();
    });
    cell.append(trigger);
    return cell;
  }));
}

function renderRows(rows) {
  const page = rows.slice((view.page - 1) * PAGE_SIZE, view.page * PAGE_SIZE);
  $('rows').replaceChildren(...page.map(row => {
    const tr = document.createElement('tr');
    COLUMNS.forEach(column => {
      const td = document.createElement('td');
      if (column.numeric) td.className = 'num';
      if (column.key === 'status') {
        const pill = document.createElement('span');
        pill.className = 'pill' + (row.status === 'Active' ? '' : ' pill--warn');
        pill.textContent = row.status;
        td.append(pill);
      } else if (column.key === 'revenue') td.textContent = moneyFormat.format(row.revenue);
      else if (column.key === 'orders') td.textContent = numberFormat.format(row.orders);
      else td.textContent = row[column.key];
      tr.append(td);
    });
    return tr;
  }));
}

function renderPager(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const previous = Object.assign(document.createElement('button'), { className: 'control', type: 'button', textContent: 'Previous' });
  previous.disabled = view.page === 1;
  previous.addEventListener('click', () => { view.page--; render(); });
  const label = document.createElement('span');
  label.textContent = 'Page ' + view.page + ' of ' + pages;
  const next = Object.assign(document.createElement('button'), { className: 'control', type: 'button', textContent: 'Next' });
  next.disabled = view.page >= pages;
  next.addEventListener('click', () => { view.page++; render(); });
  $('pager').replaceChildren(previous, label, next);
}

function showState(title, body, error) {
  const box = $('state');
  $('table').hidden = true;
  $('pager').hidden = true;
  box.hidden = false;
  box.className = 'state' + (error ? ' state--error' : '');
  box.replaceChildren();
  const heading = document.createElement('h2'); heading.textContent = title;
  const copy = document.createElement('p'); copy.textContent = body;
  box.append(heading, copy);
}

function render() {
  renderHead();
  if (view.failed) {
    showState('Could not load records', 'The data source did not respond. Check the connection and reload.', true);
    $('count').textContent = '';
    renderMetrics([]);
    renderChart([]);
    return;
  }
  const rows = records();
  $('count').textContent = rows.length + ' of ' + SEED.length + ' accounts';
  renderMetrics(rows);
  renderChart(rows);
  if (!rows.length) { showState('No records match these filters', 'Widen the date range or clear the search.'); return; }
  $('table').hidden = false;
  $('pager').hidden = false;
  $('state').hidden = true;
  renderRows(rows);
  renderPager(rows);
}

['search', 'status', 'range'].forEach(id => $(id).addEventListener('input', () => { view.page = 1; render(); }));
$('reload').addEventListener('click', () => { view.failed = !view.failed; render(); });
render();
