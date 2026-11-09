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
let switchingModel = false;
let modelRevision = 0;
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
    try { el.animate([{ opacity: 0, transform: `translateY(${fromY || 16}px) scale(.985)` }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)' }); }
    catch { /* older engine: class fallback only */ }
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => el.classList.add('reveal-in'));
  else el.classList.add('reveal-in');
  return el;
}
function resetTranscript() { subagentUI?.reset(); openCards.clear(); transcript.replaceChildren(); transcriptMessages = []; thinkingEl = null; renderEmpty(); }
function renderEmpty() {
  if (projectHomeVisible && activeProjectId) { renderProjectHome(); return; }
  if (transcript.children.length) return;
  const box = document.createElement('section'); box.id = 'empty';
  const hero = buildHeroEmblem();
  attachSparkReplay(hero, false);
  const eyebrow = document.createElement('div'); eyebrow.className = 'empty-eyebrow'; eyebrow.textContent = 'A little spark. A clear next step.';
  const title = document.createElement('h1'); title.textContent = 'What are we working on?' ; title.style.whiteSpace = 'pre-line';
  const text = document.createElement('p'); text.textContent = 'Think it through, build something, or pick up where you left off.';
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
  box.append(hero, eyebrow, title, text, starters); transcript.append(box);
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

// Hover replay (OpenDesign-style vanish/reappear): wrapper gets .replaying
// (fades + freezes child animations), then .reborn (children restart entrance).
// Guarded so it can't double-trigger while a replay is running.
const _replaying = new WeakSet();
function attachSparkReplay(holderEl, small) {
  if (!holderEl) return;
  holderEl.classList.add('spark-holder');
  if (small) holderEl.classList.add('sm');
  holderEl.addEventListener('mouseenter', () => {
    if (_replaying.has(holderEl)) return;
    _replaying.add(holderEl);
    holderEl.classList.remove('reborn');
    holderEl.classList.add('replaying');
    const t1 = setTimeout(() => {
      holderEl.classList.remove('replaying');
      holderEl.classList.add('reborn');
      const t2 = setTimeout(() => {
        holderEl.classList.remove('reborn');
        _replaying.delete(holderEl);
      }, small ? 400 : 1600);
      holderEl._replayT2 = t2;
    }, small ? 180 : 240);
    holderEl._replayT1 = t1;
  });
  holderEl.addEventListener('mouseleave', () => {
    // early exit: snap to final state, allow next replay
    clearTimeout(holderEl._replayT1); clearTimeout(holderEl._replayT2);
    holderEl.classList.remove('replaying', 'reborn');
    _replaying.delete(holderEl);
  });
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
  // heat layer: heatmap-style glow tracing the spark silhouette (see shaders)
  const heat = document.createElement('canvas');
  heat.className = 'heat-layer';
  heat.setAttribute('aria-hidden', 'true');
  wrap.append(heat);
  if (typeof window.__museHeatAttach === 'function') window.__museHeatAttach(heat);
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
    attachSparkReplay(i, true);
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

// Execution cards share the existing call-id map with transcript lifecycle handling.
const openCards = new Map();
const activityUI = window.MuseActivity.create({ transcript, openCards, clearEmpty, reveal, scrollDown });
function addToolRow(event) { activityUI.add(event); }
function addDeniedRow(name, reason) { activityUI.denied(name, reason); }

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

const subagentUI = window.MuseSubagents?.create({ transcript, clearEmpty,
  activity: text => wbEvent(text, 'tool'),
  count: count => { $('subagent-count').textContent = count ? `${count} running` : 'Ready'; },
});

function handleAgentEvent(ev) {
  if (loadingSession && ev.type.startsWith('restored_')) { restoredEvents.push(ev); return; }
  if (ev.subagent || ev.type === 'subagent_start' || ev.type === 'subagent_done') {
    subagentUI?.handle(ev);
    return;
  }
  switch (ev.type) {
    case 'message':
      if (ev.text && ev.text.trim()) addMsg('assistant', ev.text);
      break;
    case 'tool_call':
      if (ev.name !== 'spawn_agent') addToolRow({ id: ev.id, name: ev.name, args: ev.args });
      wbCounters.tools++; wbUpdateDetails(); wbEvent('tool: ' + ev.name, 'tool');
      break;
    case 'tool_result':
      if (ev.name === 'spawn_agent' && !ev.denied) {
        if (ev.result && !ev.result.ok && !ev.result.subagentId) addSysNote(ev.result.error || 'Subagent could not start.', true);
        break;
      }
      if (ev.denied) addDeniedRow(ev.name, ev.reason);
      else addToolRow({ id: ev.id, name: ev.name, args: null, result: ev.result });
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
  $('approval-title').textContent = req.subagent ? `${subagentUI?.label(req.subagentId) || 'Subagent'} needs approval` : 'Your approval is required';
  currentApproval = req;
  composer.style.display = 'none';
  approvalBox.classList.add('active');
  const action = window.MuseActivity.describe(req.tool, req.args || {});
  $('approval-action').textContent = action.title;
  $('approval-tool').textContent = `${action.category} · ${req.tool}`;
  $('approval-description').textContent = req.tool === 'shell' ? 'Muse wants to run this command on your device.'
    : req.tool === 'write_file' ? 'Muse wants to write the following content to this file.'
    : req.tool === 'read_file' || req.tool === 'list_dir' ? 'Muse wants to access this location.' : 'Muse wants to use this tool. Review the request before continuing.';
  $('approval-args').textContent = action.input;
  $('approval-raw').textContent = JSON.stringify(req.args || {}, null, 2);
  $('btn-deny').focus();
});

window.muse.onApprovalResolved((result) => {
  if (!currentApproval || currentApproval.id !== result.id) return;
  currentApproval = null;
  approvalBox.classList.remove('active');
  composer.style.display = 'flex';
  $('btn-allow').disabled = $('btn-deny').disabled = false;
  addSysNote(result.decision === 'allow'
    ? 'permission mode changed — request approved by the current policy'
    : 'permission mode changed — request blocked by the current policy', result.decision === 'deny');
  // Resolving approval does not finish the turn; terminal agent events own busy.
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
    if (!currentApproval || currentApproval.id !== req.id) return;
    if (!res || !res.ok) throw new Error(res && res.error || 'Approval response failed. Retry or deny.');
    currentApproval = null;
    approvalBox.classList.remove('active'); composer.style.display = 'flex';
    addSysNote(approved ? 'approved' : 'denied by you', !approved);
  } catch (e) { if (currentApproval && currentApproval.id === req.id) reportError(e); }
  finally { $('btn-allow').disabled = $('btn-deny').disabled = false; }
}
$('btn-allow').addEventListener('click', () => answerApproval(true));
$('btn-deny').addEventListener('click', () => answerApproval(false));

/* ---------- agent questions (human-in-the-loop) ---------- */

let currentQuestion = null;

window.muse.onQuestion((q) => {
  $('question-title').textContent = q.subagent ? `${subagentUI?.label(q.subagentId) || 'Subagent'} has a question` : 'The agent has a question';
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
  sendBtn.disabled = b || loadingSession || switchingModel;
  modelUI?.busyChanged();
  cancelBtn.style.display = b ? 'inline-block' : 'none';
  input.disabled = b || loadingSession;
  $('btn-new').disabled = b || loadingSession;
  if (!b) { input.focus(); autosize(); }
}

async function submit() {
  const text = input.value.trim();
  if (!text || busy || loadingSession || currentApproval || switchingModel) return;
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
    projectHomeVisible = false; subagentUI?.reset(); openCards.clear(); transcript.replaceChildren(); transcriptMessages = []; thinkingEl = null;
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
  const revision = modelRevision;
  const cfg = await window.muse.getConfig();
  if (revision !== modelRevision) return;
  statusCache = cfg;
  modelUI?.sync(cfg.llm || {});
  $('tag-model').textContent = cfg.llm.model || 'no model';
  $('tag-sentinel').textContent = `Safety: ${cfg.sentinel.mode}`;
  $('stat-permissions').textContent = cfg.sentinel.mode === 'accept_edits' ? 'Edits' : cfg.sentinel.mode === 'auto' ? 'Auto' : cfg.sentinel.mode === 'plan' ? 'Plan' : 'Ask';
  $('mode-safety-note').textContent = cfg.sentinel.mode === 'auto' ? 'Auto runs tools and commands without approval prompts.' : cfg.sentinel.mode === 'plan' ? 'Plan mode is read-only. Side effects are blocked.' : cfg.sentinel.mode === 'accept_edits' ? 'Project edits run automatically. Other actions ask.' : 'Tools ask before they act. You stay in control.';
  $('pip-llm').classList.toggle('on', true);
  $('pip-llm').classList.toggle('blink', busy);
  $('pip-llm').title = `${cfg.llm.base_url} · ${cfg.llm.model}${cfg.llm.has_key ? '' : ' · NO KEY'}`;
  $('pip-sent').classList.toggle('on', cfg.sentinel.mode === 'ask');
  const mt = $('mode-toggle');
  if (mt) {
    const m = MODES.includes(cfg.sentinel.mode) ? cfg.sentinel.mode : 'ask';
    mt.classList.toggle('on', m !== 'ask');
    mt.setAttribute('aria-pressed', String(m !== 'ask'));
    $('mode-label').textContent = `Mode: ${m}`;
    mt.title = MODE_TIPS[m] || 'Click to cycle permission modes';
  }
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

/* ---------- permission mode ---------- */

const MODES = ['ask', 'accept_edits', 'plan', 'auto'];
const MODE_TIPS = {
  ask: 'Every side effect asks for approval. Safest.',
  accept_edits: 'File writes inside the project folder auto-approve; shell/web still ask.',
  plan: 'Read-only. Writes, shell and web are blocked outright.',
  auto: 'All tools and commands run without approval. Deny rules still block matching calls.',
};

$('mode-toggle').addEventListener('click', guarded(async () => {
  const cfg = await window.muse.getConfig();
  const cur = MODES.includes(cfg.sentinel.mode) ? cfg.sentinel.mode : 'ask';
  const next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
  const res = await window.muse.setMode(next);
  if (res && res.ok) {
    if (!busy) addSysNote(`permission mode → ${next}${next === 'plan' ? ' — side effects blocked; ask me to plan instead of act' : next === 'auto' ? ' — all tools and commands run without approval; deny rules still apply' : next === 'accept_edits' ? ' — writes inside the project folder auto-approve' : ' — every side effect asks'}`);
    refreshStatus();
  }
}));

/* ---------- settings modal ---------- */

const backdrop = $('backdrop');
const settingsUI = window.MuseSettings?.create({ visibleModels: () => modelUI?.draftModels() || [] });
const modelUI = window.MuseModelPicker.create({
  changed: () => settingsUI?.changed(),
  busy: () => busy || loadingSession || !!currentApproval,
  switching: active => { switchingModel = active; if (active) modelRevision++; sendBtn.disabled = active || busy || loadingSession; },
  select: async model => {
    const result = await window.muse.selectModel(model);
    if (result?.ok) { $('tag-model').textContent = result.model; $('wb-model').textContent = result.model; if (statusCache?.llm) statusCache.llm.model = result.model; }
    return result;
  },
  manage: async () => { await openSettings(); modelUI.showSettings(); },
});
$('f-base').addEventListener('input', () => { modelUI.changedEndpoint($('f-base').value); settingsUI?.changed(); });
let modelFetchVersion = 0;

async function openSettings() {
  if (settingsOpen || switchingModel) return;
  if (memOpen) closeMemory();
  dialogReturnFocus = document.activeElement;
  settingsOpen = true;
  backdrop.classList.add('active');
  $('settings-err').textContent = '';
  modelFetchVersion++;
  settingsUI?.loading();
  modelUI.setLocked(true);
  try {
  const s = await window.muse.getSettings();
  $('f-base').value = s.base_url || '';
  $('f-key').value = s.api_key || '';
  $('model-list').value = s.model || '';
  $('btn-eye').textContent = 'show';
  $('f-key').type = 'password';
  $('chat-key-hint').textContent = s.has_key
    ? 'A key is saved securely or supplied by your environment. Leave empty to keep it.'
    : 'Stored securely on this device. Enter a key, or use your environment key.';
  // embeddings section
  $('f-embed-base').value = s.embed_base_url || '';
  $('f-embed-model').value = s.embed_model || '';
  $('f-embed-key').value = '';
  $('f-embed-key').type = 'password';
  $('btn-embed-eye').textContent = 'show';
  $('embed-key-hint').textContent = s.embed_key_set
    ? 'A key is saved in the OS credential store. Type to replace it; leave empty to keep it.'
    : 'Stored in the OS credential store, never in plain config. Empty = use the chat API key.';
  $('f-base').focus();
  modelUI.load(s); modelUI.setLocked(false); settingsUI?.loaded(s);
  } catch (e) { settingsUI?.failedLoad(); $('settings-err').textContent = `Cannot load connection: ${e.message || e}`; }
}

function closeSettings() {
  if (settingsUI?.isSaving()) return;
  settingsOpen = false;
  modelUI.close();
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

$('btn-embed-eye').addEventListener('click', () => {
  const f = $('f-embed-key');
  const show = f.type === 'password';
  f.type = show ? 'text' : 'password';
  $('btn-embed-eye').textContent = show ? 'hide' : 'show';
});

$('btn-fetch').addEventListener('click', async () => {
  const btn = $('btn-fetch');
  if (btn.disabled) return;
  const version = ++modelFetchVersion;
  const baseUrl = $('f-base').value.trim(), key = $('f-key').value.trim();
  const err = $('settings-err');
  err.textContent = '';
  $('models-status').textContent = 'Checking the endpoint for available models…';
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  btn.classList.add('busy');
  settingsUI?.fetching(true);
  try {
  const res = await window.muse.fetchModels({
    base_url: baseUrl,
    api_key: key || undefined, // undefined -> use stored key
  });
  if (version !== modelFetchVersion || baseUrl !== $('f-base').value.trim() || key !== $('f-key').value.trim()) {
    if (version === modelFetchVersion) $('models-status').textContent = 'Connection changed. Fetch again to see its models.';
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Fetch models';
  btn.classList.remove('busy');
  if (!res.ok) {
    $('models-status').textContent = '';
    err.textContent = `fetch failed: ${res.error}`;
    return;
  }
  modelUI.available(res.models);
  $('models-status').textContent = res.models.length
    ? `${res.models.length} models found. Browse the library to choose your chat models.`
    : 'The endpoint returned no models. You can enter a model ID manually.';
  } catch (e) { if (version === modelFetchVersion) { $('models-status').textContent = ''; err.textContent = `Fetch failed: ${e.message || e}`; } }
  finally { if (version === modelFetchVersion) { btn.disabled = false; btn.textContent = 'Fetch models'; btn.classList.remove('busy'); settingsUI?.fetching(false); } }
});

/* Keep progress and confirmation visible; local saves never test the provider. */
function saveButtonState(state) {
  modelUI.setLocked(state === 'saving');
  if (settingsUI) { settingsUI.setState(state); return; }
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
  if (settingsUI && (settingsUI.isSaving() || !settingsUI.isDirty())) return;
  const err = $('settings-err');
  err.textContent = '';
  try {
  settingsUI?.validate();
  saveButtonState('saving');
  const res = await window.muse.saveSettings({
    base_url: $('f-base').value.trim(),
    api_key: $('f-key').value.trim(),
    model: $('model-list').value.trim(),
    visible_models: modelUI.draftModels(),
    // embeddings: '' keeps chat-endpoint fallback; key '' = keep saved key
    embed_base_url: $('f-embed-base').value.trim(),
    embed_model: $('f-embed-model').value.trim(),
    ...($('f-embed-key').value.trim() ? { embed_api_key: $('f-embed-key').value.trim() } : {}),
  });
  if (!res.ok) {
    err.textContent = res.error;
    saveButtonState('failed');
    return;
  }
  modelUI.saved(); saveButtonState('saved');
  const emb = res.embed_model ? ` · embed ${res.embed_model}${res.embed_base_url ? ' @ ' + res.embed_base_url : ''}` : '';
  addSysNote(`settings saved — now using ${res.model}${emb}`);
  refreshStatus();
  } catch (e) {
    err.textContent = `Save failed: ${e.message || e}`;
    saveButtonState('failed');
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
for (const name of ['connection', 'workspace', 'mcp', 'shortcuts']) {
  $('tab-' + name).addEventListener('click', () => {
    settingsUI?.selectTab(name);
    for (const section of ['connection', 'workspace', 'mcp', 'shortcuts']) {
      $('tab-' + section).setAttribute('aria-selected', String(name === section));
      $('panel-' + section).hidden = name !== section;
    }
    if (name === 'mcp') renderMcpList();
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
  projects: () => { if (memOpen) closeMemory(); if (activeProjectId) { projectHomeVisible = true; renderProjectHome(); } else { const s = document.getElementById('project-search'); if (s) { s.focus(); s.scrollIntoView?.({ block: 'nearest' }); } } },
  activity: () => { if (memOpen) closeMemory(); setWorkbenchCollapsed(false); const tab = $('wb-tab-activity'); if (tab) tab.click(); },
  memory: () => { openMemory(); },
};
for (const b of navBtns) b.addEventListener('click', () => { const name = (b.dataset && b.dataset.nav) || b.id.slice(4); setNav(name); const act = NAV_ACTIONS[name]; if (act) act(); });
if (window.addEventListener) window.addEventListener('resize', syncPill);
syncPill();

/* ---------- resizable sidebar (Terax panel model, vanilla) ----------
   Drag #sidebar-handle to resize .history. The width is written as --sidebar-w
   on body so the CSS media ladder (which also drives --sidebar-w) is overridden
   by the inline value. Double-click or Enter resets, arrow keys nudge when the
   handle has focus. Every DOM API is feature-guarded so the fake-DOM tests run
   inert instead of crashing (no getBoundingClientRect / setProperty there). */
const SIDEBAR_MIN = 180, SIDEBAR_MAX = 480, SIDEBAR_DEFAULT = 300, GUTTER = 16;
const sidebarHandle = $('sidebar-handle');
function applySidebarW(w) {
  prefs.sidebarW = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
  const body = document.body;
  if (body && body.style && typeof body.style.setProperty === 'function') {
    body.style.setProperty('--sidebar-w', prefs.sidebarW + 'px');
  }
}
if (sidebarHandle && typeof sidebarHandle.addEventListener === 'function' &&
    typeof sidebarHandle.getBoundingClientRect === 'function') {
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const bodyRect = document.body.getBoundingClientRect();
    applySidebarW(e.clientX - bodyRect.left - GUTTER);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    sidebarHandle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    if (window.removeEventListener) { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); }
  };
  sidebarHandle.addEventListener('pointerdown', (e) => {
    dragging = true;
    sidebarHandle.classList.add('dragging');
    document.body.classList.add('resizing');
    if (window.addEventListener) { window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); }
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
  });
  sidebarHandle.addEventListener('dblclick', () => applySidebarW(SIDEBAR_DEFAULT));
  sidebarHandle.addEventListener('keydown', (e) => {
    if (!e || !e.key) return;
    const cur = prefs.sidebarW || SIDEBAR_DEFAULT;
    if (e.key === 'Enter') applySidebarW(SIDEBAR_DEFAULT);
    else if (e.key === 'ArrowLeft') applySidebarW(cur - 16);
    else if (e.key === 'ArrowRight') applySidebarW(cur + 16);
  });
}
if (prefs.sidebarW) applySidebarW(prefs.sidebarW);

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
const TIPS = [['btn-project', 'Attach a working folder — reads inside it are automatic'], ['btn-leave-project', 'Detach the current project folder'], ['btn-workbench-toggle', 'Show or hide the right panel'], ['btn-focus', 'Distraction-free conversation view'], ['btn-export', 'Save the transcript as Markdown'], ['btn-command', 'Command palette — every action, one query'], ['btn-memory', 'Memory scopes, evidence and health'], ['btn-settings', 'Connection, workspace and shortcuts'], ['mode-toggle', 'Permission mode: ask → accept-edits → plan → auto'], ['btn-new', 'Start a fresh conversation'], ['send', 'Send message'], ['wb-close', 'Collapse the right panel']];
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
const THEMES = ['light', 'dark'];
let currentTheme = document.body.dataset?.theme || 'light';
function setTheme(name) {
  if (!THEMES.includes(name)) name = 'light';
  currentTheme = name;
  if (name === 'light') document.body.removeAttribute('data-theme');
  else document.body.setAttribute('data-theme', name);
  for (const b of document.querySelectorAll('[data-theme-pick]')) {
    b.setAttribute('aria-checked', String(b.dataset.themePick === name));
  }
  if (typeof window.__museShaderRefresh === 'function') window.__museShaderRefresh();
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
    btn.textContent = p ? short : 'Attach folder';
    btn.title = p ? `Working folder: ${p}` : 'Choose the folder Muse should work in';
    $('btn-normal-chat').setAttribute('aria-pressed', String(!activeProjectId));
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
function closeProjectCreate() {
  $('project-create').hidden = true; $('btn-create-project').setAttribute('aria-expanded', 'false');
  $('project-create-error').textContent = ''; $('btn-create-project').focus();
}
$('btn-create-project').addEventListener('click', () => {
  if (busy || loadingSession || currentApproval) return;
  $('project-create').hidden = false; $('btn-create-project').setAttribute('aria-expanded', 'true'); $('project-name').focus();
});
$('btn-project-create-cancel').addEventListener('click', closeProjectCreate);
$('project-create').addEventListener('keydown', event => { if (event.key === 'Escape' && !$('btn-project-create-save').disabled) closeProjectCreate(); });
$('project-name').addEventListener('input', () => { $('project-create-error').textContent = ''; $('project-name').setAttribute('aria-invalid', 'false'); });
$('project-create').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || loadingSession || currentApproval) return;
  const name = $('project-name').value.trim();
  if (!name) { $('project-create-error').textContent = 'Enter a project name.'; $('project-name').setAttribute('aria-invalid', 'true'); $('project-name').focus(); return; }
  const save = $('btn-project-create-save'); if (save.disabled) return;
  save.disabled = $('btn-project-create-cancel').disabled = true; save.textContent = 'Creating…';
  try {
    const res = await window.muse.createProject(name);
    if (!res || !res.ok) throw Error(res && res.error || 'Could not create project');
    $('project-name').value = ''; closeProjectCreate(); await openProject(res.record.id);
  } catch (error) { $('project-create-error').textContent = error.message || 'Could not create project'; }
  finally { save.disabled = $('btn-project-create-cancel').disabled = false; save.textContent = 'Create project'; }
});
const commands = [['New session', newSession, 'Ctrl N'], ['Open settings', openSettings, 'Ctrl ,'], ['Open memory', openMemory, ''], ['Toggle focus mode', toggleFocus, ''], ['Export transcript as Markdown', exportTranscript, 'Ctrl ⇧ E'], ['Focus composer', () => input.focus(), ''], ['Cycle appearance', cycleTheme, ''], ['Appearance: Light', () => setTheme('light'), ''], ['Appearance: Dark', () => setTheme('dark'), ''], ['Toggle right panel', () => setWorkbenchCollapsed(!$('workbench').classList.contains('collapsed')), ''], ['Open activity panel', () => { setWorkbenchCollapsed(false); const tab = $('wb-tab-activity'); if (tab) tab.click(); }, '']];
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


/* ---------- boot splash: particle reconstruction (click to skip) ---------- */
(function bootSplash() {
  const splash = document.getElementById && document.getElementById('splash');
  if (!splash || !splash.querySelector) return;
  const frameEl = splash.querySelector('.s-frame');
  const canvas = splash.querySelector('.s-fx');
  const logoEl = splash.querySelector('.s-logo');
  if (!frameEl || !canvas || !logoEl || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d', { alpha: true });
  const RM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const T = { convStart: 260, glitchStart: 1100, glitchEnd: 1800, seat: 1850, swap: 2050, end: 2800 };

  let W = 0, H = 0, particles = [], startTime = 0, raf = 0, running = false, done = false;

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
  }

  function dismiss() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    splash.classList.add('gone');
    setTimeout(() => { try { splash.remove(); } catch {} }, 500);
  }

  function sampleParticles() {
    const S = 220;
    const off = document.createElement('canvas');
    off.width = S; off.height = S;
    const octx = off.getContext('2d');
    const svg = logoEl.querySelector('svg');
    const xml = new XMLSerializer().serializeToString(svg)
      .replace('<svg ', '<svg width="220" height="220" xmlns="http://www.w3.org/2000/svg" ');
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          octx.clearRect(0, 0, S, S);
          octx.drawImage(img, 0, 0, S, S);
          const data = octx.getImageData(0, 0, S, S).data;
          const inkC = cssVar('--hero-ink', '#26251f');
          const limeC = cssVar('--hero-lime', '#80e044');
          const inkRGB = hexToRgb(inkC), limeRGB = hexToRgb(limeC);
          const pts = [];
          for (let y = 0; y < S; y += 2) {
            for (let x = 0; x < S; x += 2) {
              const i = (y * S + x) * 4;
              const a = data[i + 3];
              if (a < 40) continue;
              const r = data[i], g = data[i + 1], b = data[i + 2];
              const isLime = g > 150 && g > r * 1.6 && g > b * 1.6;
              const isWhite = r > 200 && g > 200 && b > 200;
              if (isWhite) continue;                 // disc = negative space
              pts.push({ x, y, col: isLime ? limeRGB : inkRGB, size: isLime ? 2.1 : 1.7 });
            }
          }
          resolve(pts);
        } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve([]); };
      img.src = url;
    });
  }

  function hexToRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim().replace(/ /g, ''));
    const hex = m ? m[1] : '26251f';
    return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
  }

  function buildParticles(pts) {
    const scale = W / 220;
    particles = pts.map((p) => {
      const tx = p.x * scale, ty = p.y * scale;
      const ang = Math.random() * Math.PI * 2;
      const dist = (0.5 + Math.random() * 1.1) * (W * 0.32);
      return {
        tx, ty,
        sx: tx + Math.cos(ang) * dist,
        sy: ty + Math.sin(ang) * dist,
        size: p.size * scale * 0.9,
        col: p.col,
        delay: (p.x / 220) * 520 + Math.random() * 140,
        jx: (Math.random() - 0.5) * 24, jy: (Math.random() - 0.5) * 24,
        ph: Math.random() * Math.PI * 2,
        flick: 0.4 + Math.random() * 0.6,
      };
    });
  }

  let glitchSeed = 0;
  function glitchOffset(px, py, t) {
    for (let b = 0; b < 3; b++) {
      const seed = Math.sin((b + 1) * 12.9898 + glitchSeed) * 43758.5453;
      const f = seed - Math.floor(seed);
      const bandY = (0.2 + f * 0.6) * H;
      const bandH = H * 0.03;
      if (py > bandY && py < bandY + bandH) {
        const amp = 14 * Math.sin(t * 0.02 + b * 3);
        return amp * (1 - Math.abs((py - bandY) / bandH - 0.5) * 2);
      }
    }
    return 0;
  }

  function easeOutCubic(x){ return 1 - Math.pow(1 - x, 3); }

  function render(now) {
    if (!running) return;
    const t = now - startTime;
    glitchSeed = Math.floor(t / 90);
    ctx.clearRect(0, 0, W, H);
    const glitchW = t > T.glitchStart && t < T.glitchEnd
      ? Math.sin(((t - T.glitchStart) / (T.glitchEnd - T.glitchStart)) * Math.PI) : 0;
    const swapW = Math.min(Math.max((t - T.swap) / (T.end - T.swap), 0), 1);
    const rgb = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    for (const p of particles) {
      const localT = Math.min(Math.max((t - T.convStart - p.delay) / 620, 0), 1);
      if (localT <= 0) {
        const flick = 0.25 + 0.5 * Math.abs(Math.sin(t * 0.012 * p.flick + p.ph));
        ctx.globalAlpha = flick * 0.55;
        ctx.fillStyle = rgb(p.col);
        ctx.fillRect(p.sx + Math.sin(t*0.002+p.ph)*6, p.sy + Math.cos(t*0.0023+p.ph)*6, p.size, p.size);
        continue;
      }
      const e = easeOutCubic(localT);
      let x = p.sx + (p.tx - p.sx) * e;
      let y = p.sy + (p.ty - p.sy) * e;
      const jdecay = (1 - localT) * (1 - glitchW * 0.6);
      x += Math.sin(t*0.02+p.ph) * p.jx * jdecay;
      y += Math.cos(t*0.023+p.ph) * p.jy * jdecay;
      if (glitchW > 0) { x += glitchOffset(x, y, t) * glitchW; y += (Math.random()-0.5)*2.5*glitchW; }
      let a = 0.5 + 0.5 * easeOutCubic(localT);
      if (localT < 1 && Math.random() < 0.12 * (1 - localT)) a *= 0.3;
      if (glitchW > 0 && Math.random() < 0.08) a *= 0.55;
      a *= (1 - swapW);
      if (a <= 0.01) continue;
      ctx.globalAlpha = Math.min(a, 1);
      ctx.fillStyle = rgb(p.col);
      ctx.fillRect(x, y, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    if (t >= T.swap - 160) logoEl.classList.add('show');
    if (t >= T.end) { dismiss(); return; }
    raf = requestAnimationFrame(render);
  }

  async function play() {
    if (RM) { splash.classList.add('skip'); setTimeout(dismiss, 700); return; }
    const rect = frameEl.getBoundingClientRect();
    const DPR = Math.min((typeof devicePixelRatio === 'number' ? devicePixelRatio : 1), 2);
    canvas.width = Math.round(rect.width * DPR);
    canvas.height = Math.round(rect.height * DPR);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(DPR, DPR);
    W = rect.width; H = rect.height;
    let pts = [];
    try { pts = await sampleParticles(); } catch (e) { pts = []; }
    if (!pts.length) { splash.classList.add('skip'); setTimeout(dismiss, 350); return; }
    buildParticles(pts);
    running = true;
    startTime = performance.now();
    raf = requestAnimationFrame(render);
  }

  splash.addEventListener('click', dismiss, { once: false });
  if (document.readyState === 'complete' || document.readyState === 'interactive') play();
  else document.addEventListener('DOMContentLoaded', () => play(), { once: true });
})();

/* ---------- hero smoke glow ---------------------------------------------
   The DotOrbit background is mounted separately by lib/dot-orbit.js.
   This WebGL1 layer supplies the existing transparent hero emblem glow. */
(function shaders() {
  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

  // SmokeRing, ported from paper-design/shaders smoke-ring.ts (Apache 2.0).
  // Radial gradient shaped with layered value-noise into a smoky ring. White
  // on transparent, premultiplied so it glows over the emblem with no square
  // edge. Params follow the user spec: noiseScale 3, 8 iterations, radius .25,
  // thickness .65, innerShape .7, speed .5, scale .8.
  const FRAG_HEAT = [
    'precision highp float;',
    'uniform vec2 u_res;uniform float u_time;',
    'uniform vec3 u_cFront;',
    'uniform float u_thickness,u_radius,u_inner,u_scale,u_speed;',
    'uniform float u_noiseScale,u_noiseIter;',
    'float randomR(vec2 p){p=fract(p*vec2(443.897,441.423));',
    ' p+=dot(p,p.yx+19.19);return fract((p.x+p.y)*p.x);}',
    'float valueNoise(vec2 st){',
    ' vec2 i=floor(st),f=fract(st);',
    ' float a=randomR(i),b=randomR(i+vec2(1.,0.)),c=randomR(i+vec2(0.,1.)),d=randomR(i+vec2(1.,1.));',
    ' vec2 u=f*f*(3.-2.*f);',
    ' return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}',
    'vec2 fbm(vec2 n0,vec2 n1){',
    ' vec2 total=vec2(0.);float amp=.4;',
    ' for(int i=0;i<8;i++){',
    '  if(i>=int(u_noiseIter))break;',
    '  total.x+=valueNoise(n0)*amp;',
    '  total.y+=valueNoise(n1)*amp;',
    '  n0*=1.99;n1*=1.99;amp*=.65;',
    ' }',
    ' return total;}',
    'float getNoise(vec2 uv,vec2 pUv,float t){',
    ' vec2 pl=pUv+.03*t;',
    ' float period=max(abs(u_noiseScale*6.2831853),1e-6);',
    ' vec2 pr=vec2(fract(pUv.x/period)*period,pUv.y)+.03*t;',
    ' vec2 noise=fbm(pl,pr);',
    ' return mix(noise.y,noise.x,smoothstep(-.25,.25,uv.x));}',
    'void main(){',
    ' vec2 uv=(gl_FragCoord.xy-.5*u_res)/u_res.y;',
    ' vec2 s_uv=uv/u_scale;',
    ' float t=u_time*u_speed;',
    ' float cyc=3.;float per=2.*cyc;',
    ' float lt1=fract((.1*t+cyc)/per)*per;',
    ' float lt2=fract((.1*t)/per)*per;',
    ' float tbl=.5+.5*sin(.1*t*3.14159/cyc-.5*3.14159);',
    ' float atg=atan(s_uv.y,s_uv.x)+.001;',
    ' float l=length(s_uv);',
    ' float rad=.5*l-inversesqrt(max(1e-4,l));',
    ' vec2 p1=vec2(atg,lt1-rad)*u_noiseScale;',
    ' vec2 p2=vec2(atg,lt2-rad)*u_noiseScale;',
    ' float n=mix(getNoise(s_uv,p1,t),getNoise(s_uv,p2,t),tbl);',
    ' s_uv*=.8+1.2*n;',
    ' float d=length(s_uv);',
    ' float ring=1.-smoothstep(u_radius,u_radius+u_thickness,d);',
    ' ring*=smoothstep(u_radius-u_inner*u_inner*u_inner*u_thickness,u_radius,d);',
    ' vec3 col=u_cFront;',
    ' gl_FragColor=vec4(col*ring,ring);}',               // premultiplied
  ].join('\n');

  function hexToUnit(h, fb) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return fb;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function cssVar(name, fb) {
    try {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fb;
    } catch { return fb; }
  }
  function numVar(name, fb) {
    const v = parseFloat(cssVar(name, String(fb)));
    return Number.isFinite(v) ? v : fb;
  }

  // alpha=true for the heat layer: it must composite over the emblem, not cover
  // it with an opaque square. The background stays opaque (alpha:false) so it
  // never shows the window paint through.
  function makeGl(canvas, frag, transparent) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: !!transparent, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: true,
      });
    } catch {}
    if (!gl) return null;
    if (transparent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
      gl.clearColor(0, 0, 0, 0);
    }
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, frag);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return { gl, u: (n) => gl.getUniformLocation(prog, n) };
  }

  const RM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const heat = { list: [] };        // hero canvases, rebuilt with each empty state

  let lastTime = 0;
  window.__museHeatAttach = (canvas) => {
    const ctx = makeGl(canvas, FRAG_HEAT, true);
    if (!ctx) return;
    heat.list = heat.list.filter((e) => e.canvas.isConnected);
    heat.list.push({ canvas, ctx });
    // first layout may not have run yet: fit now if measurable, else next frame
    const fit = () => { sizeCanvas(canvas, ctx, 1.5); drawHeat(lastTime); };
    if (canvas.clientWidth > 0) fit();
    else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fit);
    else fit();
  };

  function sizeCanvas(canvas, ctx, dprCap) {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      ctx.gl.viewport(0, 0, w, h);
    }
    return [w, h];
  }

  function drawHeat(time) {
    for (const entry of heat.list) {
      if (!entry.canvas.isConnected) continue;
      const [w, h] = sizeCanvas(entry.canvas, entry.ctx, 1.5);
      const gl = entry.ctx.gl, u = entry.ctx.u;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(u('u_res'), w, h);
      gl.uniform1f(u('u_time'), time);
      gl.uniform3fv(u('u_cFront'), hexToUnit(cssVar('--smoke-front', '#ffffff'), [1, 1, 1]));
      gl.uniform1f(u('u_thickness'), numVar('--smoke-thickness', .65));
      gl.uniform1f(u('u_radius'), numVar('--smoke-radius', .25));
      gl.uniform1f(u('u_inner'), numVar('--smoke-innerShape', .7));
      gl.uniform1f(u('u_scale'), numVar('--smoke-scale', .8));
      gl.uniform1f(u('u_speed'), numVar('--smoke-speed', .5));
      gl.uniform1f(u('u_noiseScale'), numVar('--smoke-noiseScale', 3));
      gl.uniform1f(u('u_noiseIter'), numVar('--smoke-noiseIterations', 8));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    heat.list = heat.list.filter((e) => e.canvas.isConnected);
  }

  let raf = 0, running = false, t0 = 0;
  function frame(now) {
    if (!running) return;
    const time = (now - t0) / 1000;
    lastTime = time;

    drawHeat(time);
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running || RM || document.body.classList.contains('shader-off')) return;
    if (typeof requestAnimationFrame !== 'function') return;   // test DOMs: static only
    running = true; t0 = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }
  function renderOnce() { drawHeat(0); }

  // theme or var changes repaint a static frame so colors follow immediately
  window.__museShaderRefresh = () => {
    if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('muse-shader-refresh'));
    heat.list = heat.list.filter((e) => e.canvas.isConnected);
    if (RM || !running) renderOnce();
  };

  const toggle = document.getElementById('pref-shader');
  if (toggle) {
    toggle.addEventListener('change', () => {
      document.body.classList.toggle('shader-off', !toggle.checked);
      if (toggle.checked) { renderOnce(); start(); } else stop();
    });
  }
  // glass opacity slider: writes --glass-opacity on body, which both theme
  // --glass-fill formulas consume. Inline var beats the theme default.
  const glassSlider = document.getElementById('glass-opacity');
  const glassLabel = document.getElementById('glass-opacity-val');
  if (glassSlider && glassLabel) {
    glassSlider.addEventListener('input', () => {
      const v = parseInt(glassSlider.value, 10) / 100;
      // write on :root — --glass-fill consumes the var where it's declared,
      // so a body-level inline value never reaches the panes.
      if (document.documentElement && document.documentElement.style) {
        document.documentElement.style.setProperty('--glass-opacity', String(v));
      }
      glassLabel.textContent = glassSlider.value + '%';
    });
  }
  if (document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (toggle && toggle.checked) start();
    });
  }
  if (window.addEventListener) window.addEventListener('resize', () => { if (RM || !running) renderOnce(); });


  renderOnce();
  start();
})();

/* ---------- boot ---------- */
if (window.MuseI18n) window.MuseI18n.applyDom();
renderEmpty();
// Swap the sidebar brand glyph for the spark mark (theme-aware via CSS).
try {
  const brandMark = document.querySelector('.brand-mark');
  if (brandMark) {
    brandMark.replaceChildren();
    brandMark.append(mkSparkSvg(20));
    attachSparkReplay(brandMark, true);
  }
} catch {}
setWorkbenchCollapsed(typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1100px)').matches);
if (typeof window.matchMedia === 'function') {
  const panelMedia = window.matchMedia('(max-width: 1100px)');
  panelMedia.addEventListener?.('change', event => setWorkbenchCollapsed(event.matches));
}

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

/* ---------- MCP servers panel (settings) ---------- */
async function renderMcpList() {
  const wrap = $('mcp-list');
  if (!wrap) return;
  wrap.textContent = 'loading…';
  let servers = [];
  try { servers = await window.muse.mcpList(); }
  catch (e) { wrap.textContent = `Cannot load MCP servers: ${e.message || e}`; return; }
  wrap.innerHTML = '';
  if (!servers.length) { wrap.textContent = 'No MCP servers configured yet.'; return; }
  for (const s of servers) {
    const row = document.createElement('div');
    row.className = 'pref';
    row.style.cssText = 'align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap';
    const left = document.createElement('span');
    left.style.cssText = 'font-weight:600;font-size:13px';
    left.textContent = `${s.name}${s.enabled ? '' : ' (disabled)'} — ${s.command} ${s.args.join(' ')}`.trim();
    const st = document.createElement('span');
    st.style.cssText = 'color:var(--color-muted-fg);font-size:12px';
    st.textContent = s.enabled ? (s.running ? `connected · ${s.tools} tools` : 'not connected (starts next turn/restart)') : 'off';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px';
    const edit = document.createElement('button');
    edit.className = 'btn-ghost'; edit.textContent = 'edit';
    edit.addEventListener('click', () => {
      $('f-mcp-name').value = s.name; $('f-mcp-command').value = s.command;
      $('f-mcp-args').value = s.args.join(' '); $('f-mcp-env').value = s.env.join(', ');
    });
    const tog = document.createElement('button');
    tog.className = 'btn-ghost'; tog.textContent = s.enabled ? 'disable' : 'enable';
    tog.addEventListener('click', async () => {
      tog.disabled = true;
      const r = await window.muse.mcpSave({ name: s.name, server: { command: s.command, args: s.args, env: s.env, timeout_s: s.timeout_s }, enabled: !s.enabled });
      tog.disabled = false;
      if (!r.ok) { $('settings-err').textContent = r.error; return; }
      addSysNote(`mcp: ${s.name} ${!s.enabled ? 'enabled' : 'disabled'}`);
      renderMcpList();
    });
    const del = document.createElement('button');
    del.className = 'btn-ghost'; del.textContent = 'remove';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove MCP server "${s.name}"?`)) return;
      del.disabled = true;
      const r = await window.muse.mcpRemove(s.name);
      del.disabled = false;
      if (!r.ok) { $('settings-err').textContent = r.error; return; }
      addSysNote(`mcp: ${s.name} removed`);
      renderMcpList();
    });
    btns.append(edit, tog, del);
    const grp = document.createElement('div');
    grp.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0';
    grp.append(left, st);
    row.append(grp, btns);
    wrap.append(row);
  }
}

$('btn-mcp-refresh').addEventListener('click', renderMcpList);

$('btn-mcp-save').addEventListener('click', async () => {
  const err = $('settings-err');
  err.textContent = '';
  const btn = $('btn-mcp-save');
  btn.disabled = true;
  try {
    // simple space-split respecting double quotes (npx "-y" style args survive)
    const args = ($('f-mcp-args').value.trim().match(/"[^"]*"|\S+/g) || []).map(a => a.replace(/^"|"$/g, ''));
    const env = $('f-mcp-env').value.split(',').map(x => x.trim()).filter(Boolean);
    const r = await window.muse.mcpSave({
      name: $('f-mcp-name').value.trim(),
      server: { command: $('f-mcp-command').value.trim(), args, env },
      enabled: true,
    });
    if (!r.ok) { err.textContent = r.error; return; }
    addSysNote(`mcp: ${$('f-mcp-name').value.trim()} saved — reconnecting`);
    renderMcpList();
  } catch (e) { err.textContent = `Save failed: ${e.message || e}`; }
  finally { btn.disabled = false; }
});
