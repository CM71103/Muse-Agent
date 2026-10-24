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
let sessionCache = [];
let transcriptMessages = [];
const prefs = { compact: false, tools: true, enter: true };
let dialogReturnFocus = null;
function reportError(e) { addSysNote(String(e && e.message || e), true); }
function guarded(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(reportError); }
function resetTranscript() { transcript.replaceChildren(); transcriptMessages = []; thinkingEl = null; renderEmpty(); }
function renderEmpty() {
  if (transcript.children.length) return;
  const box = document.createElement('section'); box.id = 'empty';
  const mark = document.createElement('div'); mark.className = 'studio-mark';
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
  box.append(mark, title, text, starters); transcript.append(box);
}

/* ---------- transcript rendering ---------- */

function scrollDown() {
  const main = $('mainlog');
  main.scrollTop = main.scrollHeight;
}

function clearEmpty() {
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
  scrollDown();
}

function addSysNote(text, warn, cls) {
  clearEmpty();
  const div = document.createElement('div');
  div.className = 'sysnote' + (warn ? ' warn' : '') + (cls ? ' ' + cls : '');
  div.textContent = text;
  transcript.append(div);
  scrollDown();
}

let thinkingEl = null;
function showThinking(on) {
  if (on && !thinkingEl) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.append(document.createElement('i'), document.createElement('i'), document.createElement('i'), document.createElement('i'));
    thinkingEl.append(document.createTextNode('LLM'), bar);
    transcript.append(thinkingEl);
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
  try { sessionCache = await window.muse.listSessions(); renderSessions(); }
  catch (e) { $('sessions-empty').textContent = `History unavailable: ${e.message || e}`; $('sessions-empty').style.display = 'block'; }
}
function renderSessions() {
  const query = $('session-search').value.trim().toLowerCase();
  const list = sessionCache.filter(s => (s.title || 'Untitled').toLowerCase().includes(query) && ($('session-filter').value !== 'active' || s.id === activeSessionId));
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
    transcript.replaceChildren(); transcriptMessages = []; thinkingEl = null;
    const events = restoredEvents; loadingSession = false;
    events.forEach(handleAgentEvent); renderEmpty();
    activeSessionId = s.id; crumbTitle = res.title || 'Session'; $('crumb').textContent = crumbTitle; wbCounters = { msgs: 0, tools: 0 }; wbUpdateDetails(); wbEvent('session loaded: ' + crumbTitle); renderSessions();
  } catch (e) { reportError(e); }
  finally { loadingSession = false; restoredEvents = []; setBusy(false); }
}
async function newSession() {
  crumbTitle = 'New session'; wbCounters = { msgs: 0, tools: 0 }; wbUpdateDetails(); wbEvent('new session');
  if (busy || loadingSession || currentApproval) return;
  loadingSession = true; setBusy(false);
  try {
    const res = await window.muse.reset();
    if (!res || !res.ok) throw new Error(res && res.error || 'Session reset failed');
    activeSessionId = null; resetTranscript(); $('crumb').textContent = 'New session'; await refreshSessions();
  } catch (e) { reportError(e); }
  finally { loadingSession = false; setBusy(false); }
}
$('btn-new').addEventListener('click', newSession);
$('session-search').addEventListener('input', renderSessions);
$('session-filter').addEventListener('change', renderSessions);
window.muse.onSessionReset(() => { if (!loadingSession && !busy && !currentApproval) { activeSessionId = null; resetTranscript(); } });

/* ---------- status: pips + tags ---------- */

async function refreshStatus() {
  try {
  const cfg = await window.muse.getConfig();
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
    $('workbench').classList.remove('collapsed');
    $('wb-close').textContent = '›';
    for (const sec of ['activity', 'memory', 'details']) {
      $('wb-tab-' + sec).setAttribute('aria-selected', String(name === sec));
      $('wb-panel-' + sec).hidden = name !== sec;
    }
    if (name === 'memory') refreshWorkbenchMemory();
  });
}
$('wb-close').addEventListener('click', () => {
  const wb = $('workbench');
  wb.classList.toggle('collapsed');
  $('wb-close').textContent = wb.classList.contains('collapsed') ? '‹' : '›';
});
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
const commands = [['New session', newSession], ['Open settings', openSettings], ['Open memory', openMemory], ['Toggle focus mode', toggleFocus], ['Export transcript as Markdown', exportTranscript], ['Focus composer', () => input.focus()], ['Cycle appearance', cycleTheme], ['Appearance: Nimbus', () => setTheme('nimbus')], ['Appearance: Shiva Blue', () => setTheme('shiva')], ['Appearance: Dusk', () => setTheme('dusk')], ['Appearance: Carbon', () => setTheme('carbon')]];
let paletteReturnFocus = null;
function closePalette() { $('palette').classList.remove('active'); if (paletteReturnFocus) paletteReturnFocus.focus(); }
function renderCommands() {
  const wrap = $('palette-results'); wrap.replaceChildren();
  const matches = commands.filter(([label]) => label.toLowerCase().includes($('palette-query').value.toLowerCase()));
  for (const [label, action] of matches) { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', guarded(() => { closePalette(); return action(); })); wrap.append(b); }
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
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen ? closePalette() : openPalette(); }
  if (!dialog && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
  if (!dialog && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); exportTranscript(); }
});

/* ---------- boot ---------- */
if (window.MuseI18n) window.MuseI18n.applyDom();
renderEmpty();

refreshStatus();
refreshSessions();
input.focus();
