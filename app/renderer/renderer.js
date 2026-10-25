'use strict';
// renderer.js - sidebar sessions, settings modal, transcript, approvals.
// No framework, no deps.

const t = (key, fallback) => (window.MuseI18n ? window.MuseI18n.t(key, fallback) : (fallback !== undefined ? fallback : key));
const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const input = $('input');
const sendBtn = $('send');
const approvalBox = $('approval');
const composer = $('composer');

let busy = false;
let currentApproval = null;
let settingsOpen = false;
let loadingSession = false;
let restoredEvents = [];
let activeSessionId = null;
let crumbTitle = 'New session';   // declared: assigned in strict mode at 5 places (load/new/reset paths)
let sessionCache = [];
let activeProjectId = null;
let projectCache = [];
let projectHomeVisible = false;
let showArchivedProjects = false;
let projectEditorId = null;
let transcriptMessages = [];
const prefs = { compact: false, tools: true, enter: true };
let dialogReturnFocus = null;
function reportError(e) { addSysNote(String(e && e.message || e), true); }
function guarded(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(reportError); }
/* Entrance reveal for new transcript children. WAAPI when available, class
   fallback otherwise; skipped under prefers-reduced-motion and in test DOMs. */
const REDUCED_MOTION = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function reveal(el, fromY) {
  if (!el || REDUCED_MOTION) return el;
  el.classList.add('reveal');
  if (typeof el.animate === 'function') {
    try { el.animate([{ opacity: 0, transform: `translateY(${fromY || 14}px) scale(.985)` }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 340, easing: 'cubic-bezier(.22,.9,.32,1)' }); }
    catch { /* older engine: class fallback only */ }
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => el.classList.add('reveal-in'));
  else el.classList.add('reveal-in');
  return el;
}
function resetTranscript() { transcript.replaceChildren(); transcriptMessages = []; thinkingEl = null; renderEmpty(); }
function renderEmpty() {
  if (projectHomeVisible && activeProjectId) { renderProjectHome(); return; }
  if (transcript.children.length) return;
  const box = document.createElement('section'); box.id = 'empty';
  const hero = buildHeroEmblem();
  const title = document.createElement('h1'); title.textContent = 'What are we working on?' ; title.style.whiteSpace = 'pre-line';
  const text = document.createElement('p'); text.textContent = 'A place for your projects, questions and next steps. Start a conversation or pick a task below.';
  const starters = document.createElement('div'); starters.className = 'starters';
  for (const [label, task, hint] of [
    ['Understand a project', 'List the files here and summarize the README.', 'Files & context'],
    ['Make a plan', 'Help me turn an idea into a practical implementation plan.', 'Think it through'],
    ['Review my work', 'Help me review a change. Ask which files to inspect first.', 'A fresh perspective']
  ]) {
    const b = document.createElement('button'); b.className = 'starter'; b.append(document.createTextNode(label));
    const small = document.createElement('span'); small.textContent = hint; b.append(small);
    b.addEventListener('click', () => { if (!busy && !loadingSession) { input.value = task; autosize(); input.focus(); } }); starters.append(b);
  }
  box.append(hero, title, text, starters); transcript.append(box);
}

// Mini spark mark: the agent's logo chip (sidebar brand + message pip).
// Reuses the hero emblem geometry at small scale; colors via CSS vars so
// themes restyle. Pure geometry — no text, safe anywhere.
function mkSparkSvg(size = 16) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const mk = (tag, attrs) => {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  // 8 rays around center (16,16): long at 0/90/180/270, short diagonals
  for (let k = 0; k < 8; k++) {
    const long = k % 2 === 0;
    const lime = k === 0;
    const len = long ? 9.5 : 5.5;
    const halfW = long ? 1.7 : 1.25;
    const a = Math.PI * 2 * k / 8 - Math.PI / 2;
    const tipX = 16 + len * Math.cos(a), tipY = 16 + len * Math.sin(a);
    // base two points perpendicular to ray direction
    const px = Math.cos(a + Math.PI / 2), py = Math.sin(a + Math.PI / 2);
    const baseC = 3.2;   // distance from center where ray starts
    const bx1 = 16 + baseC * Math.cos(a) + halfW * px, by1 = 16 + baseC * Math.sin(a) + halfW * py;
    const bx2 = 16 + baseC * Math.cos(a) - halfW * px, by2 = 16 + baseC * Math.sin(a) - halfW * py;
    const path = mk('path', {
      d: `M${bx1.toFixed(2)} ${by1.toFixed(2)} L${tipX.toFixed(2)} ${tipY.toFixed(2)} L${bx2.toFixed(2)} ${by2.toFixed(2)} Z`,
    });
    path.setAttribute('fill', lime ? 'currentColor' : 'currentColor');
    if (lime) path.setAttribute('data-lime', '1');
    svg.append(path);
  }
  const center = mk('circle', { cx: 16, cy: 16, r: 1.9 });
  center.setAttribute('data-lime', '1');
  svg.append(center);
  return svg;
}

// Hero emblem: charcoal ring, white disc, 8-ray spark mark with lime accents.
// Colors come from CSS vars (--hero-ink/disc/lime) so themes restyle it.
function buildHeroEmblem() {
  const wrap = document.createElement('div');
  wrap.className = 'hero';
  const glow = document.createElement('div');
  glow.className = 'edge-glow';
  glow.append(document.createElement('b'));
  wrap.append(glow);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 440 440');
  svg.setAttribute('aria-hidden', 'true');

  const defs = document.createElementNS(svgNS, 'defs');
  const filter = document.createElementNS(svgNS, 'filter');
  filter.setAttribute('id', 'heroGlow');
  filter.setAttribute('x', '-60%'); filter.setAttribute('y', '-60%');
  filter.setAttribute('width', '220%'); filter.setAttribute('height', '220%');
  const blur = document.createElementNS(svgNS, 'feGaussianBlur');
  blur.setAttribute('in', 'SourceGraphic'); blur.setAttribute('stdDeviation', '4.2');
  blur.setAttribute('result', 'b');
  const merge = document.createElementNS(svgNS, 'feMerge');
  for (const node of ['b', 'b', 'SourceGraphic']) {
    const mn = document.createElementNS(svgNS, 'feMergeNode');
    mn.setAttribute('in', node);
    merge.append(mn);
  }
  filter.append(blur, merge);
  defs.append(filter);
  svg.append(defs);

  const mk = (tag, attrs) => {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  // disc + ring
  svg.append(mk('circle', { class: 'disc', cx: '220', cy: '220', r: '158' }));
  svg.append(mk('circle', { class: 'ring', cx: '220', cy: '220', r: '158', fill: 'none', 'stroke-width': '13', pathLength: '1000', 'stroke-dasharray': '1000', 'stroke-dashoffset': '0' }));

  // micro-orbit
  const orbit = document.createElementNS(svgNS, 'g');
  orbit.setAttribute('class', 'orbit');
  const orbRing = mk('circle', { cx: '220', cy: '220', r: '137', fill: 'none', 'stroke-width': '1.2', 'stroke-dasharray': '1.5 6', 'stroke-opacity': '.22' });
  orbRing.setAttribute('class', 'charfill');
  orbRing.setAttribute('stroke', 'var(--hero-ink)');
  orbit.append(orbRing);
  for (const [cx, cy, op] of [['325.1', '131.9', '.35'], ['85.5', '251.4', '.3']]) {
    const c = mk('circle', { cx, cy, r: '2.6', 'fill-opacity': op });
    c.setAttribute('class', 'charfill');
    orbit.append(c);
  }
  const limeNode = document.createElementNS(svgNS, 'g');
  limeNode.setAttribute('class', 'glowme');
  const ln = mk('circle', { cx: '153.9', cy: '95.2', r: '3.2' });
  ln.setAttribute('class', 'limefill');
  limeNode.append(ln);
  orbit.append(limeNode);
  svg.append(orbit);

  // spark: 8 tapered rays (long cardinal w/ tip nodes, short diagonal), top ray lime
  const spark = document.createElementNS(svgNS, 'g');
  spark.setAttribute('class', 'spark');
  const rayLong = 'M212 186 L220 96 L228 186 Z';
  const rayShort = 'M213.8 187.4 L220 124 L226.2 187.4 Z';
  const mkRay = (d, rotate, cls, tipNode, lime) => {
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'ray');
    let body;
    if (lime) {
      const lg = document.createElementNS(svgNS, 'g');
      lg.setAttribute('class', 'glowme');
      const path = mk('path', { d });
      path.setAttribute('class', 'limefill');
      lg.append(path);
      if (tipNode) {
        const c = mk('circle', { cx: '220', cy: '96', r: '4.6' });
        c.setAttribute('class', 'limefill');
        lg.append(c);
      }
      body = lg;
    } else {
      const path = mk('path', { d });
      path.setAttribute('class', 'charfill');
      if (tipNode) {
        const c = mk('circle', { cx: '220', cy: '96', r: '4.6' });
        c.setAttribute('class', 'charfill');
        const holder = document.createElementNS(svgNS, 'g');
        holder.append(path, c);
        body = holder;
      } else body = path;
    }
    if (rotate) body.setAttribute('transform', `rotate(${rotate} 220 220)`);
    g.append(body);
    return g;
  };
  spark.append(mkRay(rayLong, 0, null, true, true));        // top: lime
  spark.append(mkRay(rayShort, 45, null, false, false));
  spark.append(mkRay(rayLong, 90, null, true, false));
  spark.append(mkRay(rayShort, 135, null, false, false));
  spark.append(mkRay(rayLong, 180, null, true, false));
  spark.append(mkRay(rayShort, 225, null, false, false));
  spark.append(mkRay(rayLong, 270, null, true, false));
  spark.append(mkRay(rayShort, 315, null, false, false));
  const center = document.createElementNS(svgNS, 'g');
  center.setAttribute('class', 'glowme');
  const cd = mk('circle', { cx: '220', cy: '220', r: '8.5' });
  cd.setAttribute('class', 'limefill center-dot');
  center.append(cd);
  spark.append(center);
  svg.append(spark);
  wrap.append(svg);
  return wrap;
}

/* ---------- transcript rendering ---------- */

function scrollDown() {
  const main = $('mainlog');
  main.scrollTop = main.scrollHeight;
}

function clearEmpty() {
  projectHomeVisible = false;
  const home = document.getElementById('project-home');
  if (home && home.parentNode) home.remove();
  const e = $('empty');
  if (e) e.remove();
}

function addMsg(role, text) {
  clearEmpty();
  transcriptMessages.push({ role, text: String(text || '') });
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const who = document.createElement('div');
  who.className = 'who';
  if (role === 'assistant') {
    const i = document.createElement('i');
    i.setAttribute('aria-hidden', 'true');
    i.append(mkSparkSvg());
    who.append(i, document.createTextNode('Muse'));
  } else {
    who.textContent = 'You';
  }
  const body = document.createElement('div');
  body.className = role === 'user' ? 'bubble' : 'abody';
  if (role === 'assistant') {
    renderMarkdown(body, String(text || ''));
    addCopyAll(body, text);
  } else {
    body.textContent = text;
  }
  div.append(who, body);
  transcript.append(div);
  reveal(div, role === 'user' ? 10 : 16);
  scrollDown();
}

/* ---------- markdown rendering (offline, DOM-built, injection-safe) ----------
   Everything is document.createElement/textContent — no innerHTML with
   message-derived strings, so model output can never inject markup.
   Supported: fenced code with lang header + copy, inline code, headings,
   bold/italic, unordered/ordered lists, tables, blockquotes, hr, links. */

const KW = new Set(('abstract as assert async await base bool break byte case catch char checked class const constructor ' +
  'continue dark default delegate delete do double dynamic else enum event explicit export extends extern false final finally ' +
  'float fn for func function get go goto if impl implements import in inline instanceOf int interface internal is lateinit ' +
  'let lock long match mod mut namespace native new nil nonlocal null object operator out override package partial pass print ' +
  'private protected public raise readonly record ref register return sealed self set short signed sizeof static string struct ' +
  'super switch synchronized template this throw throws trait transient true try type typedef typeof union unsafe use using val ' +
  'var virtual void volatile when where while with yield').split(' '));

function mdText(el, s) {
  // inline pass: `code`, **bold**, *italic*, [text](url) — DOM only
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) el.append(document.createTextNode(s.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('`')) {
      const c = document.createElement('code');
      c.className = 'inline';
      c.textContent = tok.slice(1, -1);
      el.append(c);
    } else if (tok.startsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = tok.slice(2, -2);
      el.append(b);
    } else if (tok.startsWith('*')) {
      const em = document.createElement('em');
      em.textContent = tok.slice(1, -1);
      el.append(em);
    } else {
      const a = document.createElement('a');
      const cut = tok.indexOf('](');
      a.textContent = tok.slice(1, cut);
      const url = tok.slice(cut + 2, -1);
      if (/^https?:\/\//i.test(url)) a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.append(a);
    }
    last = re.lastIndex;
  }
  if (last < s.length) el.append(document.createTextNode(s.slice(last)));
}

// tiny syntax tint for the code body — comments, strings, numbers, keywords.
// Tokenizes with one regex pass; escapes nothing because everything lands via textContent.
function mdCode(container, code) {
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\w+)|(\n|.)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[1]) { const s = document.createElement('span'); s.className = 'tok-com'; s.textContent = m[1]; container.append(s); }
    else if (m[2]) { const s = document.createElement('span'); s.className = 'tok-str'; s.textContent = m[2]; container.append(s); }
    else if (m[3]) { const s = document.createElement('span'); s.className = 'tok-num'; s.textContent = m[3]; container.append(s); }
    else if (m[4]) {
      if (KW.has(m[4])) { const s = document.createElement('span'); s.className = 'tok-kw'; s.textContent = m[4]; container.append(s); }
      else container.append(document.createTextNode(m[4]));
    } else container.append(document.createTextNode(m[5]));
  }
}

function addCopyAll(body, rawText) {
  // small "copy" affordance under assistant replies — copies the raw markdown
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;justify-content:flex-end;margin-top:6px;';
  const btn = document.createElement('button');
  btn.className = 'cb-copy';
  btn.textContent = 'copy all';
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(String(rawText || body.textContent || '')); btn.textContent = 'copied'; }
    catch { btn.textContent = 'failed'; }
    btn.classList.add('ok');
    setTimeout(() => { btn.textContent = 'copy all'; btn.classList.remove && btn.classList.remove('ok'); }, 1400);
  });
  bar.append(btn);
  body.append(bar);
}

function renderMarkdown(root, text) {
  root.classList.add('md');
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const flushList = (items, ordered) => {
    if (!items.length) return;
    const ul = document.createElement(ordered ? 'ol' : 'ul');
    for (const it of items) {
      const li = document.createElement('li');
      mdText(li, it);
      ul.append(li);
    }
    root.append(ul);
  };
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^\s*```(\w[\w+#.-]*)?\s*$/);
    if (fence) {
      const lang = fence[1] || 'code';
      const block = document.createElement('div');
      block.className = 'codeblock';
      const head = document.createElement('div');
      head.className = 'cb-head';
      const lb = document.createElement('span');
      lb.className = 'cb-lang';
      lb.textContent = lang;
      const cp = document.createElement('button');
      cp.className = 'cb-copy';
      cp.textContent = 'copy';
      head.append(lb, cp);
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      const bodyLines = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { bodyLines.push(lines[i]); i++; }
      i++;   // skip closing fence
      const codeText = bodyLines.join('\n');
      mdCode(codeEl, codeText);
      pre.append(codeEl);
      block.append(head, pre);
      cp.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(codeText); cp.textContent = 'copied'; }
        catch { cp.textContent = 'failed'; }
        cp.classList.add('ok');
        setTimeout(() => { cp.textContent = 'copy'; if (cp.classList.remove) cp.classList.remove('ok'); }, 1400);
      });
      root.append(block);
      continue;
    }
    // heading
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const el = document.createElement('h' + h[1].length);
      mdText(el, h[2]);
      root.append(el);
      i++;
      continue;
    }
    // hr
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      root.append(document.createElement('hr'));
      i++;
      continue;
    }
    // table: | a | b | / | - | - | / rows...
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const heads = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      for (const c of heads) { const th = document.createElement('th'); mdText(th, c); trh.append(th); }
      thead.append(trh);
      const tbody = document.createElement('tbody');
      for (const r of rows) {
        const tr = document.createElement('tr');
        for (const c of r) { const td = document.createElement('td'); mdText(td, c); tr.append(td); }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      root.append(table);
      continue;
    }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const q = document.createElement('blockquote');
      const parts = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { parts.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      mdText(q, parts.join(' '));
      root.append(q);
      continue;
    }
    // lists (gather consecutive)
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))) {
        items.push(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ''));
        i++;
      }
      flushList(items, ordered);
      continue;
    }
    // blank
    if (!line.trim()) { i++; continue; }
    // paragraph: gather until blank/structural
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() &&
      !/^\s*```/.test(lines[i]) && !/^#{1,3}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) && !/^\s*\|/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    const p = document.createElement('p');
    mdText(p, para.join('\n'));
    root.append(p);
  }
}

const TOOL_HUE = { read_file: 'tw-fs', write_file: 'tw-fs', list_dir: 'tw-fs', web_fetch: 'tw-web', shell: 'tw-shell', hands: 'tw-hands' };

function addToolRow(ev) {
  clearEmpty();
  const row = document.createElement('div');
  row.className = 'tool-row' + (TOOL_HUE[ev.name] ? ' ' + TOOL_HUE[ev.name] : '');
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'tname';
  name.textContent = ev.name;
  sum.append(name, ' ', document.createTextNode(JSON.stringify(ev.args || {}).slice(0, 160)));
  det.append(sum);

  if (ev.restored) {
    sum.append(document.createTextNode(' (restored)'));
  }
  if (ev.result !== undefined) {
    const pre = document.createElement('pre');
    const r = ev.result || {};
    pre.textContent = typeof r === 'string' ? r : JSON.stringify(r, null, 2).slice(0, 4000);
    det.append(pre);
    if (r && r.ok === false) {
      row.classList.add('denied');
      const tag = document.createElement('span');
      tag.className = 'err';
      tag.textContent = ' failed';
      sum.append(tag);
    }
  }
  row.append(det);
  transcript.append(row);
  reveal(row, 8);
  scrollDown();
}

function addDeniedRow(toolName, reason) {
  clearEmpty();
  const row = document.createElement('div');
  row.className = 'tool-row denied';
  const tag = document.createElement('span');
  tag.className = 'tname';
  tag.textContent = toolName;
  row.append(tag, ' ', document.createTextNode(`denied — ${reason}`));
  transcript.append(row);
  reveal(row, 8);
  scrollDown();
}

function addSysNote(text, warn, cls) {
  clearEmpty();
  const div = document.createElement('div');
  div.className = 'sysnote' + (warn ? ' warn' : '') + (cls ? ' ' + cls : '');
  div.textContent = text;
  transcript.append(div);
  reveal(div, 6);
  scrollDown();
}

let thinkingEl = null;
function showThinking(on) {
  if (on && !thinkingEl) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    const label = document.createElement('span');
    label.className = 'thinking-label';
    label.textContent = 'LLM';
    // Two-layer shimmer: a masked gradient sweeps the text (wensity
    // text-shimmer port); falls back to plain label when motion is reduced.
    const shimmer = document.createElement('span');
    shimmer.className = 'shimmer-text';
    shimmer.setAttribute('data-text', 'LLM');
    shimmer.textContent = 'LLM';
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.append(document.createElement('i'), document.createElement('i'), document.createElement('i'), document.createElement('i'));
    thinkingEl.append(label, shimmer, bar);
    transcript.append(thinkingEl);
    reveal(thinkingEl, 8);
    scrollDown();
  } else if (!on && thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

/* ---------- agent events ---------- */

function handleAgentEvent(ev) {
  if (loadingSession && ev.type.startsWith('restored_')) { restoredEvents.push(ev); return; }
  switch (ev.type) {
    case 'message':
      if (ev.text && ev.text.trim()) addMsg('assistant', ev.text);
      break;
    case 'tool_call':
      addToolRow({ name: ev.name, args: ev.args });
      wbCounters.tools++; wbUpdateDetails(); wbEvent('tool: ' + ev.name, 'tool');
      break;
    case 'tool_result':
      if (ev.denied) addDeniedRow(ev.name, ev.reason);
      else addToolRow({ name: ev.name, args: null, result: ev.result });
      break;
    case 'info':
      if (/compaction/.test(ev.text)) addSysNote(ev.text, false, 'mem');
      else addSysNote(ev.text, ev.text.startsWith('sentinel'));
      break;
    case 'error':
      // Errors do NOT clear busy: the owning send promise decides the terminal
      // state. Memory hiccups arrive as info (main remaps them); this is for
      // real errors mid-run, which the turn will also report as error→done.
      wbEvent('error: ' + ev.text, 'err');
      addSysNote(`error: ${ev.text}`, true);
      break;
    case 'question':
      break;   // handled by onQuestion listener
    case 'question_resolved':
      break;   // handled by onQuestion listener
    case 'cancelled':
      addSysNote('cancelling current task…');
      break;
    case 'done':
      showThinking(false);
      setBusy(false);
      refreshSessions();
      break;
    case 'restored_user': addMsg('user', ev.text); break;
    case 'restored_assistant': addMsg('assistant', ev.text); break;
    case 'restored_tool': addToolRow({ name: ev.name, args: null, restored: true }); break;
    case 'session-restored': addSysNote(`session loaded: ${ev.title}`, false, 'mem'); crumbTitle = ev.title || 'Session'; wbUpdateDetails(); break;
  }
}
window.muse.onAgentEvent(handleAgentEvent);

/* ---------- approval flow ---------- */

window.muse.onApprovalRequest((req) => {
  currentApproval = req;
  composer.style.display = 'none';
  approvalBox.classList.add('active');
  $('approval-args').textContent = `${req.tool}\n${JSON.stringify(req.args, null, 2)}`;
  $('btn-deny').focus();
});

// Approval timed out server-side: restore composer so the agent is never stuck.
window.muse.onApprovalExpired(() => {
  if (!currentApproval) return;
  currentApproval = null;
  approvalBox.classList.remove('active');
  composer.style.display = 'flex';
  addSysNote('approval timed out — request denied automatically', true);
  if (busy) setBusy(false);
});

async function answerApproval(approved) {
  if (!currentApproval) return;
  const req = currentApproval;
  $('btn-allow').disabled = $('btn-deny').disabled = true;
  try {
    const res = await window.muse.respondApproval(req.id, approved);
    if (!res || !res.ok) throw new Error(res && res.error || 'Approval response failed. Retry or deny.');
    currentApproval = null;
    approvalBox.classList.remove('active'); composer.style.display = 'flex';
    addSysNote(approved ? 'approved' : 'denied by you', !approved);
  } catch (e) { reportError(e); }
  finally { $('btn-allow').disabled = $('btn-deny').disabled = false; }
}
$('btn-allow').addEventListener('click', () => answerApproval(true));
$('btn-deny').addEventListener('click', () => answerApproval(false));

/* ---------- agent questions (human-in-the-loop) ---------- */

let currentQuestion = null;

window.muse.onQuestion((q) => {
  currentQuestion = q;
  const box = $('question');
  $('question-text').textContent = q.question || 'The agent has a question.';
  const opts = $('question-options');
  opts.replaceChildren();
  for (const o of (q.options || [])) {
    const b = document.createElement('button');
    b.className = 'q-opt';
    b.textContent = o;
    b.addEventListener('click', () => answerQuestion(o));
    opts.append(b);
  }
  opts.style.display = (q.options || []).length ? 'flex' : 'none';
  composer.style.display = 'none';
  box.classList.add('active');
  $('question-answer').focus();
});

async function answerQuestion(answer, cancelled) {
  if (!currentQuestion) return;
  const q = currentQuestion;
  currentQuestion = null;
  $('question').classList.remove('active');
  composer.style.display = 'flex';
  try { await window.muse.answerQuestion(q.id, cancelled ? '' : (answer || ''), !!cancelled); }
  catch (e) { reportError(e); }
  if (cancelled) addSysNote('question skipped — the agent continues without it');
}
$('question-answer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); answerQuestion($('question-answer').value.trim()); }
});
$('question-send').addEventListener('click', () => answerQuestion($('question-answer').value.trim()));
$('question-skip').addEventListener('click', () => answerQuestion('', true));

/* ---------- cancel button ---------- */
const cancelBtn = $('btn-cancel-turn');
cancelBtn.addEventListener('click', async () => {
  if (!busy) return;
  cancelBtn.disabled = true;
  try { await window.muse.cancel(); } catch {}
  setTimeout(() => { cancelBtn.disabled = false; }, 500);
});

/* ---------- composer ---------- */

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b || loadingSession;
  cancelBtn.style.display = b ? 'inline-block' : 'none';
  input.disabled = b || loadingSession;
  $('btn-new').disabled = b || loadingSession;
  if (!b) { input.focus(); autosize(); }
}

async function submit() {
  const text = input.value.trim();
  if (!text || busy || loadingSession || currentApproval) return;
  input.value = '';
  autosize();
  addMsg('user', text);
  setBusy(true);
  showThinking(true);
  $('crumb').textContent = t('crumb.working', 'WORKING…'); wbSetStatus(t('wb.working', 'Working…'));
  refreshStatus();
  try {
    const res = await window.muse.send(text);
    if (!res || !res.ok) addSysNote(`agent error: ${res && res.error || 'No response'}`, true);
    else if (res.cancelled) addSysNote('task cancelled — partial progress kept');
  } catch (e) { reportError(e); }
  finally {
    showThinking(false); setBusy(false);
    $('crumb').textContent = activeSessionId ? crumbTitle : t('crumb.new', 'New session');
    refreshStatus(); refreshSessions();
  }
}

sendBtn.addEventListener('click', submit);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (prefs.enter || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submit();
  }
});
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
input.addEventListener('input', autosize);

/* ---------- sidebar sessions ---------- */

async function refreshSessions() {
  try { sessionCache = await window.muse.listSessions(); renderSessions(); if(window.muse.listProjects)renderProjects(); if(projectHomeVisible)renderProjectHome(); }
  catch (e) { $('sessions-empty').textContent = `History unavailable: ${e.message || e}`; $('sessions-empty').style.display = 'block'; }
}
function renderSessions() {
  scheduleHeatmap();
  const query = $('session-search').value.trim().toLowerCase();
  const list = sessionCache.filter(s => (s.projectId || null) === activeProjectId && (s.title || 'Untitled').toLowerCase().includes(query) && ($('session-filter').value !== 'active' || s.id === activeSessionId));
  const wrap = $('sessions-list'); wrap.replaceChildren();
  $('sessions-empty').style.display = list.length ? 'none' : 'block';
  $('sessions-empty').textContent = sessionCache.length ? t('sidebar.noMatch', 'No matching sessions.') : t('sidebar.empty', 'No saved sessions yet. Complete a task to keep it here.');
  for (const s of list) {
    const li = document.createElement('div'); li.className = 'sess' + (s.id === activeSessionId ? ' active' : '');
    const t = document.createElement('button'); t.className = 't'; t.textContent = s.title || 'Untitled'; t.title = t.textContent;
    if (s.id === activeSessionId) t.setAttribute('aria-current', 'true');
    t.addEventListener('click', () => loadSession(s));
    const m = document.createElement('span'); m.className = 'm'; m.textContent = String(s.turns || 0);
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', `Delete ${s.title || 'Untitled'}`);
    x.addEventListener('click', guarded(async () => {
      if (busy || loadingSession || currentApproval) return;
      if (!window.confirm(`Delete “${s.title || 'Untitled'}”? This removes its saved history and cannot be undone.`)) return;
      loadingSession = true; setBusy(false);
      try {
        const res = await window.muse.deleteSession(s.id);
        if (!res || !res.ok) throw new Error(res && res.error || 'Session could not be deleted');
        if (activeSessionId === s.id) { activeSessionId = null; resetTranscript(); $('crumb').textContent = 'New session'; }
      } finally { loadingSession = false; setBusy(false); }
      await refreshSessions();
    }));
    li.append(t, m, x); wrap.append(li);
  }
}
async function loadSession(s) {
  if (busy || loadingSession || currentApproval) return;
  loadingSession = true; restoredEvents = []; setBusy(false);
  try {
    const res = await window.muse.loadSession(s.id);
    if (!res || !res.ok) throw new Error(res && res.error || 'Session could not be loaded');
    projectHomeVisible = false; transcript.replaceChildren(); transcriptMessages = []; thinkingEl = null;
    const events = restoredEvents; loadingSession = false;
    events.forEach(handleAgentEvent); renderEmpty();
    activeSessionId = s.id; crumbTitle = res.title || 'Session'; $('crumb').textContent = crumbTitle; wbCounters = { msgs: 0, tools: 0 }; wbUpdateDetails(); wbEvent('session loaded: ' + crumbTitle); await refreshProject(); renderSessions();
  } catch (e) { reportError(e); }
  finally { loadingSession = false; restoredEvents = []; setBusy(false); }
}
async function newSession() {
  if (busy || loadingSession || currentApproval) return;
  projectHomeVisible = false; loadingSession = true; setBusy(false);
  try {
    const res = await window.muse.reset();
    if (!res || !res.ok) throw new Error(res && res.error || 'Session reset failed');
    activeSessionId = null; crumbTitle = 'New session';
    wbCounters = { msgs: 0, tools: 0 }; wbUpdateDetails(); wbEvent('new session');
    input.value = ''; resetTranscript(); $('crumb').textContent = crumbTitle;
    await refreshProject(); await refreshSessions();
  } catch (e) { reportError(e); }
  finally { loadingSession = false; setBusy(false); }
}
$('btn-new').addEventListener('click', newSession);
$('session-search').addEventListener('input', renderSessions);
$('session-filter').addEventListener('change', renderSessions);
window.muse.onSessionReset(() => { if (!loadingSession && !busy && !currentApproval) { activeSessionId = null; resetTranscript(); } });

/* ---------- status: pips + tags ---------- */

let statusCache = null;
let statusMem = null;
async function refreshStatus() {
  try {
  const cfg = await window.muse.getConfig();
  statusCache = cfg;
  $('tag-model').textContent = cfg.llm.model || 'no model';
  $('tag-sentinel').textContent = `Safety: ${cfg.sentinel.mode}`;
  $('pip-llm').classList.toggle('on', true);
  $('pip-llm').classList.toggle('blink', busy);
  $('pip-llm').title = `${cfg.llm.base_url} · ${cfg.llm.model}${cfg.llm.has_key ? '' : ' · NO KEY'}`;
  $('pip-hands').classList.toggle('on', !!cfg.hands.enabled);
  $('pip-sent').classList.toggle('on', cfg.sentinel.mode === 'ask');
  const tg = $('hands-toggle');
  tg.classList.toggle('on', !!cfg.hands.enabled);
  tg.setAttribute('aria-pressed', String(!!cfg.hands.enabled));
  $('hands-label').textContent = cfg.hands.enabled ? t('sidebar.handsOn', 'Hands on') : t('sidebar.handsOff', 'Hands off');
  $('tag-model').title = `${cfg.llm.base_url}${cfg.llm.has_key ? '' : ' · NO KEY'}`;
  // memory pip: real layer status (enabled + attached), not session count
  try {
    const ms = await window.muse.memoryStatus();
    statusMem = ms;
    const on = !!(ms && ms.enabled && ms.ready);
    $('pip-mem').classList.toggle('on', on);
    $('pip-mem').title = ms && ms.enabled
      ? `memory ${ms.ready ? 'ready' : 'starting'}${ms.project_id ? ' · project ' + String(ms.project_id).slice(0, 18) : ''}`
      : 'memory disabled — set [memory] enabled = true in config.toml';
  } catch { /* renderer survives a missing memory surface */ }
  } catch (e) { $('tag-model').textContent = 'Connection unavailable'; $('tag-model').title = String(e.message || e); }
  try {
    const cfg2 = await window.muse.getConfig();
    $('wb-model').textContent = cfg2.llm.model || 'no model';
    $('wb-sentinel').textContent = String(cfg2.sentinel.mode).toUpperCase();
  } catch { /* workbench optional */ }
}

$('hands-toggle').addEventListener('click', guarded(async () => {
  const cfg = await window.muse.getConfig();
  const next = !cfg.hands.enabled;
  const res = await window.muse.toggleHands(next);
  if (res.ok) {
    if (!busy) {
      addSysNote(next
        ? 'hands enabled — computer control can now be requested (each action still asks)'
        : 'hands disabled');
    }
    refreshStatus();
  }
}));

/* ---------- settings modal ---------- */

const backdrop = $('backdrop');

async function openSettings() {
  if (settingsOpen) return;
  if (memOpen) closeMemory();
  dialogReturnFocus = document.activeElement;
  settingsOpen = true;
  backdrop.classList.add('active');
  $('settings-err').textContent = '';
  try {
  const s = await window.muse.getSettings();
  $('f-base').value = s.base_url || '';
  $('f-key').value = s.api_key || '';
  $('model-list').value = s.model || '';
  $('btn-eye').textContent = 'show';
  $('f-key').type = 'password';
  $('f-base').focus();
  } catch (e) { $('settings-err').textContent = `Cannot load connection: ${e.message || e}`; }
}

function closeSettings() {
  settingsOpen = false;
  backdrop.classList.remove('active');
  if (dialogReturnFocus) dialogReturnFocus.focus();
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-cancel').addEventListener('click', closeSettings);
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSettings(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsOpen) closeSettings();
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
});

$('btn-eye').addEventListener('click', () => {
  const f = $('f-key');
  const show = f.type === 'password';
  f.type = show ? 'text' : 'password';
  $('btn-eye').textContent = show ? 'hide' : 'show';
});

$('btn-fetch').addEventListener('click', async () => {
  const btn = $('btn-fetch');
  const err = $('settings-err');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  btn.classList.add('busy');
  try {
  const res = await window.muse.fetchModels({
    base_url: $('f-base').value.trim(),
    api_key: $('f-key').value.trim() || undefined, // undefined -> use stored key
  });
  btn.disabled = false;
  btn.textContent = 'Fetch models';
  btn.classList.remove('busy');
  if (!res.ok) {
    err.textContent = `fetch failed: ${res.error}`;
    return;
  }
  const dl = $('models-dl');
  dl.innerHTML = '';
  for (const id of res.models) {
    const o = document.createElement('option');
    o.value = id;
    dl.append(o);
  }
  err.textContent = res.models.length
    ? `found ${res.models.length} models — click the model field to pick one`
    : 'endpoint returned no models';
  } catch (e) { err.textContent = `Fetch failed: ${e.message || e}`; }
  finally { btn.disabled = false; btn.textContent = 'Fetch models'; btn.classList.remove('busy'); }
});

/* Save button 3-state: saving → saved (green, 2s) → failed (red, 2s). */
function saveButtonState(state) {
  const btn = $('btn-save');
  btn.disabled = state === 'saving';
  btn.classList.toggle('ok', state === 'saved');
  btn.classList.toggle('failed', state === 'failed');
  btn.textContent = state === 'saving' ? 'Saving…'
    : state === 'saved' ? 'Saved'
    : state === 'failed' ? 'Save failed'
    : t('settings.saveConnection', 'Save connection');
}
$('btn-save').addEventListener('click', async () => {
  const err = $('settings-err');
  err.textContent = '';
  saveButtonState('saving');
  try {
  const res = await window.muse.saveSettings({
    base_url: $('f-base').value.trim(),
    api_key: $('f-key').value.trim(),
    model: $('model-list').value.trim(),
  });
  if (!res.ok) {
    err.textContent = res.error;
    saveButtonState('failed');
    setTimeout(() => saveButtonState('idle'), 2000);
    return;
  }
  saveButtonState('saved');
  closeSettings();
  addSysNote(`settings saved — now using ${res.model}`);
  refreshStatus();
  } catch (e) {
    err.textContent = `Save failed: ${e.message || e}`;
    saveButtonState('failed');
  } finally {
    setTimeout(() => saveButtonState('idle'), 2000);
  }
});

/* ---------- memory drawer ---------- */

let memOpen = false;

async function openMemory() {
  if (!memOpen) dialogReturnFocus = document.activeElement;
  if (settingsOpen) closeSettings();
  memOpen = true;
  if (typeof setNav === 'function') { setNav('memory'); }
  $('mem-close').focus();
  $('mem-backdrop').classList.add('active');
  const sub = $('mem-status');
  sub.textContent = 'loading…';
  $('mem-rows').innerHTML = '';
  try {
    const st = await window.muse.memoryStatus();
    sub.textContent = !st.enabled
      ? 'disabled — enable [memory] in config.toml'
      : !st.ready ? `layer not attached: ${st.error || 'unknown error'}`
      : `project ${String(st.project_id).slice(0, 24)} · ${st.evidence_version || 'baseline-v1'} · ${Object.keys(st.health && st.health.memories || {}).length || 0} records`;
    if (st.error) {
      const d=document.createElement('div');d.className='mem-empty';d.textContent=st.error;$('mem-rows').append(d);
    }
    if (st.scopes && st.scopes.length) {
      const scopes=document.createElement('div');scopes.className='mem-empty';scopes.textContent='Existing isolated scopes: '+st.scopes.map(x=>x.project_id+' ('+x.records+')').join(', ');$('mem-rows').append(scopes);
    }
    if (st.enabled) {
      const choose=document.createElement('button');choose.className='mr-btn';choose.textContent='Select scope (never merges existing scopes)';
      choose.addEventListener('click',()=>{
        choose.disabled=true;
        const form=document.createElement('div');form.className='field';
        const help=document.createElement('p');help.className='hint';help.textContent='Choose personal or project memory. Reuse an existing scope ID to recall its records. Scopes are never merged.';
        const modes=document.createElement('div');modes.className='row';
        const personal=document.createElement('button');personal.textContent='Personal';
        const project=document.createElement('button');project.textContent='Project';
        let strategy='manual';
        const scopeLabel=document.createElement('label');scopeLabel.textContent='Scope ID';scopeLabel.setAttribute('for','memory-scope-id');
        const scopeInput=document.createElement('input');scopeInput.id='memory-scope-id';scopeInput.value=st.project_id || '';scopeInput.placeholder='e.g. muse-agent';
        const selectMode=(next)=>{strategy=next;personal.setAttribute('aria-pressed',String(next==='_default'));project.setAttribute('aria-pressed',String(next==='manual'));if(!scopeInput.value)scopeInput.value=next==='_default'?'personal':'';};
        personal.addEventListener('click',()=>selectMode('_default'));
        project.addEventListener('click',()=>selectMode('manual'));
        selectMode(strategy);modes.append(personal,project);
        const actions=document.createElement('div');actions.className='row';
        const apply=document.createElement('button');apply.textContent='Attach memory scope';
        const cancel=document.createElement('button');cancel.textContent='Cancel';
        cancel.addEventListener('click',()=>{form.remove();choose.disabled=false;choose.focus();});
        apply.addEventListener('click',async()=>{
          const project_id=scopeInput.value.trim();
          if(!project_id){sub.textContent='Enter a scope ID before attaching memory.';scopeInput.focus();return;}
          apply.disabled=true;apply.textContent='Attaching…';
          try{
            const result=await window.muse.memoryScope({strategy,project_id});
            if(!result || !result.ok)throw new Error(result && (result.error || result.reason) || 'Memory scope could not be attached.');
            await openMemory();refreshStatus();refreshWorkbenchMemory();
          }catch(e){sub.textContent=String(e.message || e);}
          finally{apply.disabled=false;apply.textContent='Attach memory scope';}
        });
        actions.append(apply,cancel);form.append(help,modes,scopeLabel,scopeInput,actions);$('mem-rows').append(form);scopeInput.focus();
      });$('mem-rows').append(choose);
    }
    if (!st.enabled || !st.ready) return;
    renderHealth(st);
    renderFlagToggles(st);
    const res = await window.muse.memoryList();
    if (!res.ok) {
      $('mem-rows').innerHTML = '';
      const d = document.createElement('div');
      d.className = 'mem-empty';
      d.textContent = `could not read memory: ${res.error}`;
      $('mem-rows').append(d);
      return;
    }
    const rows = res.memories || [];
    if (!rows.length) {
      const d = document.createElement('div');
      d.className = 'mem-empty';
      d.textContent = 'nothing stored yet — what you do in sessions lands here as retrievable records.';
      $('mem-rows').append(d);
      return;
    }
    for (const m of rows) {
      const row = document.createElement('div');
      row.className = 'mem-row';
      const txt = document.createElement('div');
      txt.className = 'mr-text';
      txt.textContent = m.text || '';
      const meta = document.createElement('div');
      meta.className = 'mr-meta';
      const pill = document.createElement('span');
      pill.className = `mr-pill ${m.status}`;
      pill.textContent = m.status;
      meta.append(pill);
      for (const k of [m.type, m.provenance, m.trust_tier]) {
        const s = document.createElement('span');
        s.textContent = k;
        meta.append(s);
      }
      if (m.injection_risk > 0) {
        const r = document.createElement('span');
        r.textContent = `risk ${m.injection_risk}`;
        r.style.color = 'var(--amber)';
        meta.append(r);
      }
      // quarantined rows: the ONLY way out is explicit user review (spec §7)
      if (m.status === 'quarantined') {
        const safe = document.createElement('button');
        safe.className = 'mr-btn safe';
        safe.textContent = 'review: safe';
        safe.addEventListener('click', async () => {
          const r=await window.muse.memoryQuarantineReview({ id: m.id, verdict: 'safe' });
          if(!r.ok){sub.textContent=r.error || r.reason;return;}
          openMemory();   // re-render
        });
        meta.append(safe);
      }
      const del = document.createElement('button');
      del.className = 'mr-btn danger';
      del.textContent = 'delete';
      del.addEventListener('click', async () => {
        const r=await window.muse.memoryDelete(m.id);
        if(!r.ok){sub.textContent=r.error || r.reason;return;}
        openMemory();   // re-render
      });
      const acts = document.createElement('span');
      acts.className = 'mr-actions';
      acts.append(del);
      meta.append(acts);
      row.append(txt, meta);
      $('mem-rows').append(row);
    }
  } catch (e) {
    const d = document.createElement('div');
    d.className = 'mem-empty';
    d.textContent = `memory panel error: ${String(e && e.message || e)}`;
    $('mem-rows').append(d);
  }
}

/* ---------- health metrics + policy toggles (memory drawer) ---------- */

function fmtPct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }

function renderHealth(st) {
  const sub = $('mem-status');
  const h = st.health || {};
  const box = document.createElement('div');
  box.className = 'mem-health';
  const line = (label, val) => {
    const d = document.createElement('div');
    const s = document.createElement('span');
    s.className = 'mh-k';
    s.textContent = label;
    d.append(s, document.createTextNode(' ' + val));
    return d;
  };
  const util = h.utilization == null ? '—' : fmtPct(h.utilization) + ` (${h.utilization_turns || 0} turns)`;
  box.append(line('utilization', util));
  box.append(line('c_∅ share', h.c_empty_share == null ? '—' : fmtPct(h.c_empty_share) + ` (${h.requests_packed || 0}/${h.requests_total || 0} packed)`));
  const cap = h.daily_token_cap == null ? 'off' : String(h.daily_token_cap);
  const today = h.usage_today ? `${h.usage_today.embed_tokens + h.usage_today.llm_tokens}` : '0';
  box.append(line('tokens today', `${today} / ${cap} (embed ${h.usage_today ? h.usage_today.embed_tokens : 0}, llm ${h.usage_today ? h.usage_today.llm_tokens : 0})`));
  const cal = h.calibration ? Object.entries(h.calibration).filter(([, b]) => b.n).map(([k, b]) => `${k}: ${b.good}/${b.n}`).join(' · ') : '';
  box.append(line('calibration', cal || 'no graded turns yet'));
  if (h.deletions) box.append(line('deletions logged', String(h.deletions)));
  if (h.budget && h.budget.level) box.append(line('budget ladder', `base ${h.budget.base} · level ${h.budget.level} · allowance ${h.budget.allowance}`));
  const actions = document.createElement('div');
  actions.className = 'mh-actions';
  const exportBtn = document.createElement('button');
  exportBtn.className = 'mr-btn';
  exportBtn.textContent = 'export JSONL';
  exportBtn.addEventListener('click', async () => {
    const r = await window.muse.memoryExport();
    if (r.ok) addSysNote(`memory: exported ${r.rows} rows to ${r.file} (excluded ${r.deleted_excluded} deleted)`, false, 'mem');
    else sub.textContent = r.error || 'export failed';
  });
  const extractBtn = document.createElement('button');
  extractBtn.className = 'mr-btn';
  extractBtn.textContent = 'extract now';
  extractBtn.addEventListener('click', async () => {
    const r = await window.muse.memoryExtractNow();
    if (r && r.ok) { addSysNote(`memory: extraction done (${r.extracted || 0} new)`, false, 'mem'); openMemory(); }
    else if (r) sub.textContent = r.error || r.reason || 'extraction skipped';
  });
  const deletedBtn = document.createElement('button');
  deletedBtn.className = 'mr-btn';
  deletedBtn.textContent = 'deletion inventory';
  deletedBtn.addEventListener('click', async () => {
    const r = await window.muse.memoryDeleted();
    if (!r.ok) { sub.textContent = r.error; return; }
    const d = document.createElement('div');
    d.className = 'mem-empty';
    d.textContent = r.deletions.length
      ? 'Deleted: ' + r.deletions.map(x => `${x.id.slice(0, 20)}… (${x.deleted_at.slice(0, 10)}, ${x.reason || 'no reason'}; limits: pre-existing exports, backups, host transcripts, provider retention)`).join('; ')
      : 'No deletions in this scope.';
    $('mem-rows').prepend(d);
  });
  actions.append(exportBtn, extractBtn, deletedBtn);
  box.append(actions);
  $('mem-rows').prepend(box);
}

function renderFlagToggles(st) {
  const sub = $('mem-status');
  const flags = st.flags || {};
  const names = { adaptive_ranking: 'adaptive ranking', adaptive_budget: 'adaptive budget', query_clustering: 'query clustering' };
  const row = document.createElement('div');
  row.className = 'mem-flags';
  const label = document.createElement('span');
  label.className = 'mh-k';
  label.textContent = 'policy flags';
  row.append(label);
  for (const [k, disp] of Object.entries(names)) {
    const b = document.createElement('button');
    b.className = 'mr-btn' + (flags[k] ? ' safe' : '');
    b.textContent = `${disp}: ${flags[k] ? 'on' : 'off'}`;
    b.title = 'Flag change starts a new evidence version; disabling restores baseline serving (nothing deleted).';
    b.addEventListener('click', async () => {
      const r = await window.muse.memoryFlags({ [k]: !flags[k] });
      if (r.ok) { addSysNote(`memory: ${disp} ${!flags[k] ? 'enabled' : 'disabled'} — evidence version ${r.evidence_version}`, false, 'mem'); openMemory(); }
      else sub.textContent = r.error || 'flag change refused';
    });
    row.append(b);
  }
  $('mem-rows').prepend(row);
}

function closeMemory() {
  memOpen = false;
  if (typeof setNav === 'function') { setNav('chat'); }
  $('mem-backdrop').classList.remove('active');
  if (dialogReturnFocus) dialogReturnFocus.focus();
}

$('btn-memory').addEventListener('click', openMemory);
$('mem-close').addEventListener('click', closeMemory);
$('mem-backdrop').addEventListener('click', (e) => { if (e.target === $('mem-backdrop')) closeMemory(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && memOpen) closeMemory();
});

/* ---------- Studio workspace controls ---------- */
for (const name of ['connection', 'workspace', 'shortcuts']) {
  $('tab-' + name).addEventListener('click', () => {
    for (const section of ['connection', 'workspace', 'shortcuts']) {
      $('tab-' + section).setAttribute('aria-selected', String(name === section));
      $('panel-' + section).hidden = name !== section;
    }
  });
}
for (const [id, key, cls] of [['pref-compact', 'compact', 'compact'], ['pref-tools', 'tools', 'hide-tools'], ['pref-enter', 'enter', null]]) {
  $(id).addEventListener('change', () => {
    prefs[key] = $(id).checked;
    if (cls) document.body.classList.toggle(cls, key === 'tools' ? !prefs[key] : prefs[key]);
    $('send-hint').textContent = prefs.enter ? t('meta.sendHintEnter', 'Enter to send · Shift Enter for a new line') : t('meta.sendHintCtrl', 'Ctrl / ⌘ Enter to send');
  });
}
function toggleFocus() { const on = document.body.classList.toggle('focus-mode'); $('btn-focus').setAttribute('aria-pressed', String(on)); }

/* ---------- workbench (right panel) ---------- */
const wbLogEl = $('wb-log');
let wbCounters = { msgs: 0, tools: 0 };
function wbEvent(text, kind) {
  if (!wbLogEl) return;
  const item = document.createElement('div');
  item.className = 'wb-ev' + (kind ? ' ' + kind : '');
  item.textContent = text;
  wbLogEl.append(item);
  while (wbLogEl.children.length > 80) wbLogEl.firstChild.remove();
  wbLogEl.scrollTop = wbLogEl.scrollHeight;
}
function wbSetStatus(text) { $('wb-status').textContent = text; }
function wbUpdateDetails() {
  $('wb-msgs').textContent = String(wbCounters.msgs);
  $('wb-tools').textContent = String(wbCounters.tools);
  $('wb-session').textContent = activeSessionId ? (crumbTitle || t('wb.savedSession', 'Saved session')) : t('wb.new', 'New');
}
for (const name of ['activity', 'memory', 'details']) {
  $('wb-tab-' + name).addEventListener('click', () => {
    setWorkbenchCollapsed(false);
    for (const sec of ['activity', 'memory', 'details']) {
      $('wb-tab-' + sec).setAttribute('aria-selected', String(name === sec));
      $('wb-panel-' + sec).hidden = name !== sec;
    }
    if (name === 'memory') refreshWorkbenchMemory();
  });
}
function setWorkbenchCollapsed(collapsed) {
  $('workbench').classList.toggle('collapsed', collapsed);
  $('workbench').setAttribute('aria-hidden', String(collapsed));
  $('btn-workbench-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('btn-workbench-toggle').title = collapsed ? 'Show right panel' : 'Hide right panel';
  $('wb-close').textContent = '›';
  if (collapsed) $('btn-workbench-toggle').focus();
}
$('wb-close').addEventListener('click', () => setWorkbenchCollapsed(true));
$('btn-workbench-toggle').addEventListener('click', () => setWorkbenchCollapsed(!$('workbench').classList.contains('collapsed')));

/* ---------- activity heatmap (wensity github-activity-grid port) -----------
   15-week grid fed by sessions:list updatedAt timestamps. Static-friendly:
   renders once per sessions refresh; level buckets mirror the 5-step scale. */
const heatEl = document.getElementById('wb-heat');
let heatTimer = null;
function renderHeatmap() {
  if (!heatEl || !heatEl.isConnected) return;
  const counts = new Map(); // yyyy-mm-dd → session count
  for (const s of sessionCache) {
    if (!s.updatedAt) continue;
    const d = new Date(s.updatedAt);
    if (isNaN(d)) continue;
    const key = d.toISOString ? d.toISOString().slice(0, 10) : d.toDateString();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const today = new Date();
  const cells = [];
  const start = new Date(today);
  start.setDate(start.getDate() - (7 * 15 - 1 - (6 - start.getDay())));
  const max = Math.max(1, ...counts.values());
  for (let i = 0; i < 15 * 7; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = day.toISOString().slice(0, 10);
    const n = counts.get(key) || 0;
    const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
    cells.push({ level, title: `${key}: ${n} session${n === 1 ? '' : 's'}` });
  }
  heatEl.replaceChildren();
  for (const c of cells) {
    const el = document.createElement('i');
    if (c.level) el.dataset.level = String(c.level);
    el.title = c.title;
    heatEl.append(el);
  }
  const countEl = document.getElementById('wb-heat-count');
  if (countEl) countEl.textContent = `${sessionCache.length} sessions`;
}
function scheduleHeatmap() {
  if (heatTimer) return;
  heatTimer = setTimeout(() => { heatTimer = null; renderHeatmap(); }, 400);
}

/* ---------- gooey nav pill (wensity gooey-navigation-menu port) ----------
   One liquid highlight slides behind the active nav link. Buttons toggle
   aria-pressed, which drives both the pill position and the pressed color. */
const navBtns = ['nav-chat', 'nav-projects', 'nav-activity', 'nav-memory'].map(id => $(id));
const navPill = document.querySelector ? document.querySelector('.nav-pill') : null;
function syncPill() {
  if (!navPill || typeof navPill.getBoundingClientRect !== 'function') return; // test mock
  const active = navBtns.find(b => b.getAttribute('aria-pressed') === 'true');
  if (!active) return;
  const r = active.getBoundingClientRect();
  const wrap = active.parentElement.getBoundingClientRect();
  navPill.style.transform = `translateX(${r.left - wrap.left}px)`;
  navPill.style.width = `${r.width}px`;
}
function setNav(name) {
  for (const b of navBtns) b.setAttribute('aria-pressed', String(((b.dataset && b.dataset.nav) || b.id.slice(4)) === name));
  syncPill();
}
const NAV_ACTIONS = {
  chat: () => { if (memOpen) closeMemory(); input.focus(); },
  projects: () => { if (memOpen) closeMemory(); if (activeProjectId) { projectHomeVisible = true; renderProjectHome(); } else { const s = document.getElementById('session-search'); if (s) s.focus(); } },
  activity: () => { if (memOpen) closeMemory(); setWorkbenchCollapsed(false); const tab = $('wb-tab-activity'); if (tab) tab.click(); },
  memory: () => { openMemory(); },
};
for (const b of navBtns) b.addEventListener('click', () => { const name = (b.dataset && b.dataset.nav) || b.id.slice(4); setNav(name); const act = NAV_ACTIONS[name]; if (act) act(); });
if (window.addEventListener) window.addEventListener('resize', syncPill);
syncPill();

/* ---------- model context popover (wensity model-context-switcher port) ---------- */
const modelPop = $('model-pop');
function closeModelPop() {
  if (modelPop) modelPop.hidden = true;
  document.removeEventListener('click', onDocClickPop, true);
  window.removeEventListener('resize', closeModelPop);
  window.removeEventListener('keydown', onPopKey);
}
function onDocClickPop(e) { if (modelPop && !modelPop.contains(e.target) && e.target !== $('tag-model')) closeModelPop(); }
function onPopKey(e) { if (e.key === 'Escape') closeModelPop(); }
function openModelPop() {
  if (!modelPop || !modelPop.hidden) return;
  const cfg = statusCache || {};
  const llm = cfg.llm || {};
  const pop = (v) => (v == null || v === '' ? '—' : String(v));
  const mpModel = $('mp-model'); if (mpModel) mpModel.textContent = pop(llm.model);
  const mpUrl = $('mp-url'); if (mpUrl) mpUrl.textContent = pop(llm.base_url);
  const mpKey = $('mp-key'); if (mpKey) mpKey.textContent = llm.has_key ? 'configured' : 'missing';
  const mpSent = $('mp-sentinel'); if (mpSent) mpSent.textContent = cfg.sentinel ? pop(cfg.sentinel.mode) : '—';
  const mpHands = $('mp-hands'); if (mpHands) mpHands.textContent = cfg.hands ? (cfg.hands.enabled ? 'enabled' : 'off') : '—';
  const mpMem = $('mp-mem'); if (mpMem) mpMem.textContent = statusMem
    ? (statusMem.enabled ? (statusMem.ready ? 'ready' + (statusMem.project_id ? ' · ' + String(statusMem.project_id).slice(0, 10) : '') : 'starting') : 'disabled')
    : '—';
  const anchor = $('tag-model');
  if (anchor && typeof anchor.getBoundingClientRect === 'function') {
    const r = anchor.getBoundingClientRect();
    modelPop.style.top = `${Math.round(r.bottom + 10)}px`;
    modelPop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }
  modelPop.hidden = false;
  document.addEventListener('click', onDocClickPop, true);
  window.addEventListener('resize', closeModelPop);
  window.addEventListener('keydown', onPopKey);
}
const tm = $('tag-model');
if (tm) tm.addEventListener('click', () => { modelPop && modelPop.hidden ? openModelPop() : closeModelPop(); });

/* ---------- tooltips: enrich actionable chrome with data-tip ---------- */
const TIPS = [['btn-project', 'Attach a working folder — reads inside it are automatic'], ['btn-leave-project', 'Detach the current project folder'], ['btn-workbench-toggle', 'Show or hide the right panel'], ['btn-focus', 'Distraction-free conversation view'], ['btn-export', 'Save the transcript as Markdown'], ['btn-command', 'Command palette — every action, one query'], ['btn-memory', 'Memory scopes, evidence and health'], ['btn-settings', 'Connection, workspace and shortcuts'], ['hands-toggle', 'Let the Python hands sidecar act on your machine'], ['btn-new', 'Start a fresh conversation'], ['send', 'Send message'], ['wb-close', 'Collapse the right panel']];
for (const [id, tip] of TIPS) { const el = document.getElementById(id); if (el) el.setAttribute('data-tip', tip); }

$('wb-open-mem').addEventListener('click', openMemory);
async function refreshWorkbenchMemory() {
  try {
    const st = await window.muse.memoryStatus();
    const on = !!(st && st.enabled);
    $('wb-mem').textContent = on ? (st.ready ? 'Ready' : 'Starting') : 'Disabled';
    $('wb-memstat').textContent = on ? (st.ready ? 'Ready' : 'Starting') : 'Disabled';
    $('wb-memcount').textContent = st && st.health && st.health.memories ? String(Object.keys(st.health.memories).length) : '—';
  } catch { $('wb-mem').textContent = '—'; }
}
/* ---------- appearance (session-only) ---------- */
const THEMES = ['nimbus', 'shiva', 'dusk', 'carbon'];
let currentTheme = 'nimbus';
function setTheme(name) {
  if (!THEMES.includes(name)) name = 'shiva';
  currentTheme = name;
  if (name === 'nimbus') document.body.removeAttribute('data-theme');
  else document.body.setAttribute('data-theme', name);
  for (const b of document.querySelectorAll('[data-theme-pick]')) {
    b.setAttribute('aria-checked', String(b.dataset.themePick === name));
  }
  addSysNote(`appearance: ${name}`, false, 'mem');
}
for (const b of document.querySelectorAll('[data-theme-pick]')) {
  b.addEventListener('click', () => setTheme(b.dataset.themePick));
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(currentTheme) + 1) % THEMES.length];
  setTheme(next);
}
function exportTranscript() {
  if (!transcriptMessages.length) { addSysNote('Nothing to export yet. Start a conversation first.'); return; }
  const text = '# Muse transcript\n\n' + transcriptMessages.map(m => `## ${m.role === 'user' ? 'You' : 'Muse'}\n\n${m.text}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'muse-transcript.md'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('btn-workspace').addEventListener('click', () => input.focus());
$('btn-focus').addEventListener('click', toggleFocus);
$('btn-export').addEventListener('click', exportTranscript);

/* ---------- project scope ---------- */
async function refreshProject() {
  try {
    const res = await window.muse.getProjectScope();
    const p = res && res.ok ? res.project : null;
    activeProjectId = res && res.ok ? (res.projectId || null) : null;
    const short = p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    const btn = $('btn-project');
    btn.textContent = activeProjectId ? (res.name + (p ? ' · Folder' : ' · Attach folder')) : p ? `📁 ${short}` : t('header.project', 'Project');
    btn.title = p ? `Project: ${p} — Muse can read and list files inside it without asking` : 'No project — choose a folder so Muse can read files inside it without asking';
    $('btn-leave-project').hidden = !p && !activeProjectId;
    const pathEl = $('project-path');
    if (pathEl) pathEl.value = p || '';
    if (window.muse.listProjects) { projectCache = await window.muse.listProjects(); renderProjects(); }
    renderSessions();
  } catch { /* project surface optional */ }
}
async function pickProject() {
  if (busy || loadingSession || currentApproval) { addSysNote('Finish the current task before changing the project.', true); return; }
  const res = await window.muse.browseProject();
  if (!res || (!res.ok && res.error !== 'cancelled')) { addSysNote(`project: ${res && res.error || 'could not set folder'}`, true); return; }
  if (res.ok) {
    wbEvent('project: ' + (res.project || 'none'));
    addSysNote(`project set: ${res.project} — reads inside it are automatic`);
  }
  refreshProject();
}
$('btn-project').addEventListener('click', pickProject);
const pb = $('btn-project-browse');
if (pb) pb.addEventListener('click', pickProject);
async function leaveProject() {
  projectHomeVisible = false;
  if (busy || loadingSession || currentApproval) { addSysNote('Finish the current task before leaving the project.', true); return; }
  try {
    const res = window.muse.selectProject ? await window.muse.selectProject(null) : await window.muse.setProjectScope(null);
    if (!res || !res.ok) throw new Error(res && res.error || 'Could not leave project');
    await newSession();
    await refreshProject();
    wbEvent('normal chat — no project selected');
  } catch (e) { reportError(e); }
}
$('btn-leave-project').addEventListener('click', leaveProject);
const pc = $('btn-project-clear');
if (pc) pc.addEventListener('click', leaveProject);
function renderProjects() {
  const list = $('projects-list'); list.replaceChildren();
  const query = $('project-search').value.trim().toLowerCase();
  for (const p of projectCache.filter(p => !!p.archived === showArchivedProjects && p.name.toLowerCase().includes(query))) {
    const branch = document.createElement('div'); branch.className = 'project-branch' + (p.id === activeProjectId ? ' selected' : '');
    const row = document.createElement('div'); row.className = 'project-tree-row';
    const button = document.createElement('button'); button.className = 'project-tree-name'; button.textContent = '▱  ' + p.name;
    button.title = p.folder || 'Open project overview'; button.addEventListener('click', guarded(() => openProject(p.id)));
    const chats = sessionCache.filter(s => s.projectId === p.id);
    const count = document.createElement('span'); count.className = 'project-tree-count'; count.textContent = String(chats.length);
    const plus = document.createElement('button'); plus.className = 'project-tree-new'; plus.textContent = '+'; plus.setAttribute('aria-label','New chat in '+p.name);
    plus.addEventListener('click', guarded(() => p.id === activeProjectId ? newSession() : openProject(p.id, true)));
    row.append(button,count,plus); branch.append(row);
    if(p.id===activeProjectId) for(const chat of chats.slice(0,6)) {
      const child=document.createElement('button');child.className='project-child'+(chat.id===activeSessionId?' current':'');child.textContent=chat.title;child.title=chat.title;
      child.addEventListener('click',guarded(()=>loadSession(chat)));branch.append(child);
    }
    list.append(branch);
  }
  if(!list.children.length){const note=document.createElement('p');note.className='hint';note.textContent=query?'No matching projects':showArchivedProjects?'No archived projects':'Create a project to keep related chats together.';list.append(note);}
}
function renderProjectHome() {
  if(!projectHomeVisible)return;
  const p=projectCache.find(p=>p.id===activeProjectId);if(!p)return;
  transcript.replaceChildren();
  const home=document.createElement('section');home.id='project-home';home.className='project-home';
  const top=document.createElement('div');top.className='project-home-top';
  const emblem=document.createElement('div');emblem.className='project-emblem';emblem.textContent='▱';
  const heading=document.createElement('div');const title=document.createElement('h1');title.textContent=p.name;
  const desc=document.createElement('p');desc.className='project-home-description';desc.textContent=p.description||'A dedicated space for this project’s conversations and instructions.';heading.append(title,desc);top.append(emblem,heading);
  const actions=document.createElement('div');actions.className='project-home-actions';
  for(const [label,fn,primary] of [['New conversation',newSession,true],['Project settings',()=>editProject(p.id),false],['Attach folder',pickProject,false]]){const b=document.createElement('button');b.textContent=label;if(primary)b.className='btn-primary';b.addEventListener('click',guarded(fn));actions.append(b);}
  const context=document.createElement('div');context.className='project-context';
  for(const [label,value] of [['Working folder',p.folder||'No folder attached. Chat works without file access.'],['Shared instructions',p.instructions||'No instructions yet. Add conventions and goals in Project settings.']]){const cell=document.createElement('div'),k=document.createElement('strong'),v=document.createElement('p');k.textContent=label;v.textContent=value.length>240?value.slice(0,240)+'…':value;cell.append(k,v);context.append(cell);}
  const label=document.createElement('h2');label.className='project-conversation-heading';label.textContent='Conversations';
  const search=document.createElement('input');search.className='project-chat-search';search.type='search';search.placeholder='Search conversations in this project';search.setAttribute('aria-label',search.placeholder);
  const rows=document.createElement('div');
  const draw=()=>{rows.replaceChildren();const chats=sessionCache.filter(s=>s.projectId===p.id&&(s.title||'').toLowerCase().includes(search.value.toLowerCase()));for(const c of chats){const b=document.createElement('button');b.className='project-conversation';const t=document.createElement('span'),meta=document.createElement('small');t.textContent=c.title;meta.textContent=c.updatedAt?new Date(c.updatedAt).toLocaleDateString():'';b.append(t,meta);b.addEventListener('click',guarded(()=>loadSession(c)));rows.append(b);}if(!chats.length){const n=document.createElement('p');n.className='hint';n.textContent=search.value?'No matching conversations.':'No conversations yet. Start one above.';rows.append(n);}};
  search.addEventListener('input',draw);draw();home.append(top,actions,context,label,search,rows);transcript.append(home);
}
async function openProject(id, fresh = false) {
  if (busy || loadingSession || currentApproval) return;
  const res = await window.muse.selectProject(id);
  if (!res || !res.ok) throw Error(res && res.error || 'Could not open project');
  projectHomeVisible=false;await refreshProject();await refreshSessions();
  if(fresh){await newSession();return;}
  activeSessionId=null;transcriptMessages=[];thinkingEl=null;projectHomeVisible=true;
  $('crumb').textContent=res.name||'Project';renderProjectHome();
}
function editProject(id){
 if(busy||loadingSession||currentApproval)return;
 const p=projectCache.find(p=>p.id===id);if(!p)return;projectEditorId=id;
 $('edit-project-name').value=p.name;$('edit-project-description').value=p.description||'';$('edit-project-instructions').value=p.instructions||'';
 $('edit-project-folder').textContent=p.folder||'No folder attached';$('project-editor-error').textContent='';$('project-editor-archive').textContent=p.archived?'Restore project':'Archive project';
 $('project-editor').showModal();$('edit-project-name').focus();
}
$('project-editor-close').addEventListener('click',()=>$('project-editor').close());
$('project-editor-form').addEventListener('submit',guarded(async e=>{
 e.preventDefault();if(busy||loadingSession||currentApproval)return;
 const res=await window.muse.updateProject(projectEditorId,{name:$('edit-project-name').value,description:$('edit-project-description').value,instructions:$('edit-project-instructions').value});
 if(!res||!res.ok){$('project-editor-error').textContent=res&&res.error||'Could not save';return;}
 $('project-editor').close();await refreshProject();if(projectHomeVisible)renderProjectHome();
}));
$('edit-project-browse').addEventListener('click',guarded(async()=>{await pickProject();const r=await window.muse.getProjectScope();$('edit-project-folder').textContent=r.project||'No folder attached';}));
$('project-editor-archive').addEventListener('click',guarded(async()=>{
 if(busy||loadingSession||currentApproval)return;const p=projectCache.find(p=>p.id===projectEditorId);if(!p)return;
 const res=await window.muse.updateProject(p.id,{archived:!p.archived});if(!res||!res.ok){$('project-editor-error').textContent=res&&res.error||'Could not archive';return;}
 $('project-editor').close();if(!p.archived)await leaveProject();await refreshProject();
}));
$('project-search').addEventListener('input',renderProjects);
$('btn-archived-projects').addEventListener('click',()=>{showArchivedProjects=!showArchivedProjects;$('btn-archived-projects').setAttribute('aria-pressed',String(showArchivedProjects));$('btn-archived-projects').textContent=showArchivedProjects?'Show active projects':'Show archived projects';renderProjects();});
$('btn-normal-chat').addEventListener('click', leaveProject);
$('btn-create-project').addEventListener('click', () => { $('project-create').hidden = false; $('project-name').focus(); });
$('btn-project-create-cancel').addEventListener('click', () => { $('project-create').hidden = true; });
$('btn-project-create-save').addEventListener('click', guarded(async () => {
  if (busy || loadingSession || currentApproval) return;
  const res = await window.muse.createProject($('project-name').value.trim());
  if (!res || !res.ok) throw Error(res && res.error || 'Could not create project');
  $('project-name').value = ''; $('project-create').hidden = true;
  await openProject(res.record.id);
}));
const commands = [['New session', newSession, 'Ctrl N'], ['Open settings', openSettings, 'Ctrl ,'], ['Open memory', openMemory, ''], ['Toggle focus mode', toggleFocus, ''], ['Export transcript as Markdown', exportTranscript, 'Ctrl ⇧ E'], ['Focus composer', () => input.focus(), ''], ['Cycle appearance', cycleTheme, ''], ['Appearance: Nimbus', () => setTheme('nimbus'), ''], ['Appearance: Shiva Blue', () => setTheme('shiva'), ''], ['Appearance: Dusk', () => setTheme('dusk'), ''], ['Appearance: Carbon', () => setTheme('carbon'), ''], ['Toggle right panel', () => setWorkbenchCollapsed(!$('workbench').classList.contains('collapsed')), ''], ['Open activity panel', () => { setWorkbenchCollapsed(false); const tab = $('wb-tab-activity'); if (tab) tab.click(); }, '']];
let paletteReturnFocus = null;
function closePalette() { $('palette').classList.remove('active'); if (paletteReturnFocus) paletteReturnFocus.focus(); }
function renderCommands() {
  const wrap = $('palette-results'); wrap.replaceChildren();
  const matches = commands.filter(([label]) => label.toLowerCase().includes($('palette-query').value.toLowerCase()));
  for (const [label, action, keys] of matches) {
    const b = document.createElement('button');
    const span = document.createElement('span');
    span.textContent = label;
    b.append(span);
    if (keys) { const k = document.createElement('kbd'); k.textContent = keys; b.append(k); }
    b.addEventListener('click', guarded(() => { closePalette(); return action(); }));
    wrap.append(b);
  }
  if (!matches.length) wrap.textContent = 'No matching commands.';
}
function openPalette() {
  if (settingsOpen || memOpen) return;
  paletteReturnFocus = document.activeElement; $('palette').classList.add('active'); $('palette-query').value = ''; renderCommands(); $('palette-query').focus();
}
$('btn-command').addEventListener('click', openPalette);
$('palette-query').addEventListener('input', renderCommands);
$('palette-query').addEventListener('keydown', e => { if (e.key === 'Enter') { const first = $('palette-results').querySelector('button'); if (first) first.click(); } if (e.key === 'ArrowDown') { e.preventDefault(); const first = $('palette-results').querySelector('button'); if (first) first.focus(); } });
$('palette').addEventListener('click', e => { if (e.target === $('palette')) closePalette(); });
window.addEventListener('keydown', e => {
  const paletteOpen = $('palette').classList.contains('active');
  if (e.key === 'Escape' && paletteOpen) closePalette();
  const dialog = paletteOpen ? $('palette-dialog') : settingsOpen ? $('settings') : memOpen ? $('mem-drawer') : null;
  if (e.key === 'Tab' && dialog) {
    const nodes = [...dialog.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter(n => !n.disabled && !n.closest('[hidden]'));
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  if ($('project-editor').open) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen ? closePalette() : openPalette(); }
  if (!dialog && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
  if (!dialog && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); exportTranscript(); }
});

/* ---------- boot ---------- */
if (window.MuseI18n) window.MuseI18n.applyDom();
renderEmpty();
// Swap the sidebar brand glyph for the spark mark (theme-aware via CSS).
try {
  const brandMark = document.querySelector('.brand-mark');
  if (brandMark) {
    brandMark.replaceChildren();
    brandMark.append(mkSparkSvg(20));
  }
} catch {}
setWorkbenchCollapsed(typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1100px)').matches);

refreshStatus();
refreshSessions();
refreshProject();
input.focus();

/* ---------- pointer highlight on starter cards ------------------------------- */
document.body.addEventListener('pointermove', (e) => {
  const card = e.target && e.target.closest && e.target.closest('.starter');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${((e.clientX - r.left) / Math.max(1, r.width)) * 100}%`);
  card.style.setProperty('--my', `${((e.clientY - r.top) / Math.max(1, r.height)) * 100}%`);
}, { passive: true });
