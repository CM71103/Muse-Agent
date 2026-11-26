'use strict';
// visual-look-service.js - Electron capture host for the visual check behind
// visual_render ("look at the page like a reader"). Installed into the harness
// (require('../harness/visual-look.ts').configureVisualLook) from here, exactly
// like windows-service installs the Windows desktop: headless runs have no
// capture and the check is skipped with a note.
//
// A hidden BrowserWindow loads a rendered page as a reader would see it. The
// in-page checks run from ./visual-look-checks.js (verbatim from
// visual-explainer kit/look.mjs, MIT), page/figure/step screenshots are taken
// through webContents.capturePage, and the crops are packed into contact
// sheets with the upstream sheet layout — sized for a vision model's budget.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const checks = require('./visual-look-checks.js');

const WIDTHS = checks.WIDTHS;               // [390, 1280]
const MAX_CAPTURE_HEIGHT = 16000;           // software-render texture ceiling
const LOAD_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── in-page helpers (self-contained: serialized with toString()) ── */

function veFigureMetas() {
  return [...document.querySelectorAll('main figure')].map((f, i) => ({
    index: i,
    top: f.getBoundingClientRect().bottom + (window.scrollY || 0),
    stepped: f.matches('.ve-steps') || !!f.querySelector('.ve-steps'),
  }));
}

function veStepCounts() {
  return [...document.querySelectorAll('.ve-steps')].map((e) => e.querySelectorAll('.ve-cap li').length);
}

// Unrolls a drawing's sideways-scrolling frames and returns the union box
// (the upstream shoot() clip math), so one capture shows all of it.
function vePrep(kind, index) {
  const pick = () => kind === 'figure'
    ? document.querySelectorAll('main figure')[index]
    : (() => {
        const root = document.querySelectorAll('.ve-steps')[index];
        return root ? (root.querySelector('.frame') || root.querySelector('svg') || root) : null;
      })();
  const e = pick();
  if (!e) return null;
  const frames = [...(e.matches('.frame') ? [e] : []), ...e.querySelectorAll('.frame')]
    .filter((f) => f.scrollWidth > f.clientWidth + 1);
  e.__veOld = frames.map((f) => [f, f.getAttribute('style')]);
  for (const f of frames) f.style.cssText += `;overflow:visible;width:${f.scrollWidth}px;max-width:none`;
  const rs = [e, ...frames].map((x) => x.getBoundingClientRect());
  const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
  return {
    x: x + (window.scrollX || 0), y: y + (window.scrollY || 0),
    width: Math.max(...rs.map((r) => r.right)) - x,
    height: Math.max(...rs.map((r) => r.bottom)) - y,
    figN: kind === 'step' ? [...document.querySelectorAll('main figure')].indexOf(e.closest('figure')) + 1 : 0,
  };
}

function veUndo(kind, index) {
  const e = kind === 'figure'
    ? document.querySelectorAll('main figure')[index]
    : (() => {
        const root = document.querySelectorAll('.ve-steps')[index];
        return root ? (root.querySelector('.frame') || root.querySelector('svg') || root) : null;
      })();
  if (!e || !e.__veOld) return;
  for (const [f, s] of e.__veOld) s === null ? f.removeAttribute('style') : f.setAttribute('style', s);
  delete e.__veOld;
}

function veIsCustomColors() {
  return [...document.querySelectorAll('style:not([data-ve-kit])')].some((s) => /--(?:accent|bg|surface|text|border|ok|warn|risk|info)[\w-]*\s*:/.test(s.textContent));
}

function veScrollTop() { window.scrollTo(0, 0); }

/* Shapes that lost the kit contract render with the SVG default fill: black
   boxes with black labels. Upstream measure() catches unfilled TEXT; this
   catches unfilled SHAPES, naming the fix (diagrams.md shape classes). */
function veShapeCheck() {
  const black = 'rgb(0, 0, 0)';
  const bad = [...document.querySelectorAll('svg.ve-svg rect, svg.ve-svg circle, svg.ve-svg ellipse, svg.ve-svg polygon, svg.ve-svg path')]
    .filter((el) => !el.closest('defs, marker, symbol, clipPath, mask, pattern') && el.checkVisibility() && getComputedStyle(el).fill === black);
  if (!bad.length) return [];
  return [`${bad.length} diagram shape(s) render with the default black fill (a <${bad[0].tagName.toLowerCase()}> outside the kit's shape classes); wrap nodes as <g class="ve-n"><rect class="sh"/>… and edges as <path class="ve-e">`];
}

function veScrollHeight() {
  return Math.min(Math.max(
    document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0,
    window.innerHeight), 16000);
}

function veSheetRect() {
  const e = document.querySelector('#s');
  const r = e.getBoundingClientRect();
  return { x: r.x + (window.scrollX || 0), y: r.y + (window.scrollY || 0), width: r.width, height: r.height };
}

/* ── the sheet page (upstream drawSheets markup, captured with capturePage) ── */

function sheetHtml(rows) {
  const { SHEET_W, PAD, GAP, LABEL } = checks;
  return `<!doctype html><body style="margin:0;background:#fff"><div id="s" style="width:max-content;max-width:${SHEET_W}px;box-sizing:border-box;padding:${PAD}px;display:flex;flex-direction:column;gap:${GAP}px;font:600 13px/18px system-ui,sans-serif;color:#333">${rows.map((row) => `<div style="display:flex;gap:${GAP}px;align-items:flex-start">${row.map((c) => `<div><div style="height:${LABEL - 4}px;margin-bottom:4px">${c.label}</div><img src="data:image/png;base64,${Buffer.from(c.png).toString('base64')}" width="${Math.round(c.w * c.s)}" height="${Math.round(c.h * c.s)}" style="display:block;outline:1px solid #ccc"></div>`).join('')}</div>`).join('')}</div></body>`;
}

/* ── the service ── */

function createVisualLookService() {
  const { BrowserWindow } = require('electron');
  let win = null;
  let collect = null;   // active console-error sink, per phase

  function ensureWindow(width, height) {
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        show: false, frame: false, resizable: false, fullscreenable: false,
        skipTaskbar: true, width, height,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      win.webContents.on('console-message', (a, b, c, d) => {
        const det = a && typeof a === 'object' && 'message' in a
          ? a : { level: b, message: c, sourceId: d };
        const level = det.level;
        const isError = level === 3 || level === 'error';
        if (!isError || !collect) return;
        const message = String(det.message || '');
        const sourceId = String(det.sourceId || det.source || '');
        // an offline or blocked fetch from another origin (the kit's web font) is the host's situation, not the page's
        if (/^Failed to load resource: net::/.test(message) && !sourceId.startsWith('file:')) return;
        collect.push(message);
      });
    }
    const { width: w, height: h } = win.getBounds();
    if (w !== width || h !== height) win.setBounds({ width, height });
    return win;
  }

  async function setBounds(width, height) {
    ensureWindow(width, height);
    await sleep(120);
  }

  async function emulate(features) {
    try {
      const dbg = win.webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Emulation.setEmulatedMedia', {
        features: (features || []).map(([name, value]) => ({ name, value })),
      });
    } catch { /* emulation is best-effort; captures still work without it */ }
  }

  async function load(url) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`the page did not load within ${LOAD_TIMEOUT_MS / 1000}s`)), LOAD_TIMEOUT_MS));
    await Promise.race([win.loadURL(url), timeout]);
    await evalIn(checks.fontsReady);
  }

  // runSerialized: evaluates functions passed as real functions via toString()
  async function evalIn(fn, arg) {
    const code = `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    return await win.webContents.executeJavaScript(code, true);
  }

  async function shot(rect) {
    let clip;
    if (rect) {
      const bounds = win.getBounds();
      const x = Math.max(0, Math.round(rect.x ?? 0)), y = Math.max(0, Math.round(rect.y ?? 0));
      const width = Math.min(Math.round(rect.width), bounds.width - x);
      const height = Math.min(Math.round(rect.height), bounds.height - y);
      if (width <= 0 || height <= 0) return null;
      clip = { x, y, width, height };
    }
    const image = await win.webContents.capturePage(clip);
    return image.toPNG();
  }

  async function drawSheet(rows) {
    try {
      await setBounds(checks.SHEET_W, checks.SHEET_H);
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sheetHtml(rows))}`);
      const rect = await evalIn(veSheetRect);
      return await shot(rect);
    } catch { return null; }
  }

  /** Looks at a rendered page. Returns the same shape as the kit's lookAt. */
  async function lookAt(file, { sheet = true } = {}) {
    const target = path.resolve(String(file));
    if (!fs.existsSync(target)) return { skipped: `no such page: ${target}`, problems: [], sheets: [] };
    const url = pathToFileURL(target).href;
    const result = { file: target, errors: [], widths: {}, problems: [], sheets: [], omitted: 0 };
    const geometry = new Map();
    const note = (list, step) => {
      for (const { where, what } of list || []) {
        const key = `${where}: ${what}`;
        if (!geometry.has(key)) geometry.set(key, []);
        if (step && !geometry.get(key).includes(step)) geometry.get(key).push(step);
      }
    };
    const items = [];
    try {
      // as a reader opens it, at each width
      for (const width of WIDTHS) {
        ensureWindow(width, 900);
        collect = [];
        await load(url);
        await sleep(300);
        result.widths[width] = await evalIn(checks.measure, checks.MIN_LABEL);
        result.errors.push(...collect.map((message) => `console at ${width}px: ${message}`));
        collect = null;
      }

      // the final state without motion: geometry, every step, and the crops for the sheet
      ensureWindow(1280, 900);
      await emulate([['prefers-reduced-motion', 'reduce'], ['prefers-color-scheme', 'light']]);
      collect = [];
      await load(url);
      await sleep(200);
      result.errors.push(...collect.map((message) => `console at 1280px: ${message}`));
      collect = null;
      note(await evalIn(checks.inspect, null));
      result.problems.push(...(await evalIn(veShapeCheck)));
      const gaps = await evalIn(checks.headings, checks.MIN_HEADING_GAP);
      const desktop = sheet ? await shot() : null;
      await setBounds(390, 900);
      await sleep(100);
      gaps.push(...await evalIn(checks.headings, checks.MIN_HEADING_GAP));
      const phone = sheet ? await shot() : null;
      await setBounds(1280, 900);
      await evalIn(veScrollTop);
      await sleep(100);
      result.problems.push(...new Set(gaps));
      if (sheet) {
        const overview = [];
        if (desktop) overview.push({ png: desktop, ...checks.pngSize(desktop), label: 'First screen · 1280' });
        if (phone) overview.push({ png: phone, ...checks.pngSize(phone), label: '390' });
        if (overview.length) items.push({ kind: 'overview', cells: overview });
      }

      // grow the window to the page so below-the-fold figures and steps capture
      const full = Math.max(900, await evalIn(veScrollHeight));
      await setBounds(1280, full);
      await evalIn(veScrollTop);
      await sleep(100);

      // figures below the first screen, steppers aside (their steps follow)
      for (const meta of await evalIn(veFigureMetas)) {
        if (!sheet || meta.stepped || meta.top <= 900) continue;
        const pre = await evalIn(vePrep, ['figure', meta.index]);
        if (!pre) continue;
        const png = await shot(pre);
        await evalIn(veUndo, ['figure', meta.index]);
        if (png) items.push({ kind: 'figure', cells: [{ png, ...checks.pngSize(png), label: `Fig ${meta.index + 1}` }] });
      }

      // each stepper, step by step
      for (const [r, n] of (await evalIn(veStepCounts)).entries()) {
        const first = await evalIn(vePrep, ['step', r]);
        const figN = first ? first.figN : 0;
        await evalIn(veUndo, ['step', r]);
        const cells = [];
        for (let k = 0; k < n; k++) {
          if (!(await evalIn(checks.goStep, [r, k]))) break;
          await sleep(60);
          note(await evalIn(checks.inspect, r), `${k + 1}`);
          if (sheet) {
            const pre = await evalIn(vePrep, ['step', r]);
            const png = pre ? await shot(pre) : null;
            await evalIn(veUndo, ['step', r]);
            if (png) cells.push({ png, ...checks.pngSize(png), label: `${figN ? `Fig ${figN}` : 'Stepper'} · step ${k + 1}/${n}` });
          }
        }
        if (n) await evalIn(checks.goStep, [r, n - 1]);
        if (cells.length) items.push({ kind: 'steps', cells });
      }

      // a page that sets its own colors gets its first screen in dark too
      const custom = await evalIn(veIsCustomColors);
      if (sheet && custom) {
        await setBounds(1280, 900);
        await emulate([['prefers-reduced-motion', 'reduce'], ['prefers-color-scheme', 'dark']]);
        collect = [];
        await load(url);
        await sleep(200);
        result.errors.push(...collect.map((message) => 'console at 1280px (dark): ' + message));
        collect = null;
        const png = await shot();
        if (png) items.push({ kind: 'figure', cells: [{ png, ...checks.pngSize(png), label: 'First screen · dark' }] });
      }
    } catch (e) {
      // the page is already written; a browser failure is a skipped check, not a failed render
      return { skipped: `the visual check could not finish: ${String((e && e.message) || e).split('\n')[0]}`, problems: [], sheets: [] };
    } finally {
      try { await emulate([]); } catch {}
      collect = null;
    }

    if (sheet) {
      const { sheets, omitted } = checks.layout(items);
      for (const rows of sheets) {
        const png = await drawSheet(rows);
        if (png) result.sheets.push({ png });
      }
      result.omitted = omitted;
    }

    // the problems a reader would hit first (upstream assembly order)
    const at = result.widths;
    const shapes = [...geometry].map(([key, steps]) => (steps.length ? `${key} (step${steps.length > 1 ? 's' : ''} ${steps.join(', ')})` : key));
    result.problems = [
      ...result.errors,
      ...WIDTHS.filter((w) => at[w].overflow).map((w) => `the page scrolls sideways at ${w}px`),
      ...WIDTHS.filter((w) => at[w].small).map((w) => `a diagram label renders at ${at[w].smallest.px}px at ${w}px ("${at[w].smallest.text}"); keep labels at ${checks.MIN_LABEL}px or more`),
      ...(at[1280].kit ? [] : ["the kit's script did not run to its end"]),
      ...(at[1280].unfilled ? [`${at[1280].unfilled.n} SVG label(s) have no fill, so they are black on a dark scheme ("${at[1280].unfilled.text}"); use a kit class or a token`] : []),
      ...result.problems,
      ...shapes,
    ];
    return result;
  }

  function dispose() {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
    win = null;
  }

  require('../harness/visual-look.ts').configureVisualLook({ lookAt, dispose });
  return { lookAt, dispose };
}

module.exports = { createVisualLookService };