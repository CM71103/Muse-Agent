'use strict';
// visual-tools.ts - agent-facing Visual Explainer tools.
//
// The model writes a declarative page source (<name>.src.html with <ve-flow>,
// <ve-bars>, <ve-waffle>, <ve-stack>, <ve-ask>, ... tags); the vendored
// renderer compiles it to ONE self-contained HTML page, lints it with
// line-numbered errors (nothing is written while any remain), and — when the
// Electron host installed a capture service — a browser looks at the result
// and returns visual problems plus contact-sheet screenshots, so the model
// sees its own page and fixes small edits instead of rewriting it.
//
// Vendored kit: ./visual-explainer/ (visual-explainer by nicobailon, MIT).
// Permission classes: scope/sideEffect are declared on each tool and
// registered with the sentinel in sentinel.js (visual_render writes files).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const KIT_DIR = path.join(__dirname, 'visual-explainer');
const DOCS = {
  kit: 'kit.md', diagrams: 'diagrams.md', machines: 'machines.md',
  motion: 'motion.md', style: 'style-guide.md', themes: 'themes.md',
  plans: 'plans.md', slides: 'slides.md', extras: 'extras.md',
};
const MAX_DOC = 12000;         // chars per doc, like the design registry
const MAX_SOURCE = 2 * 1024 * 1024;  // page source cap
const MAX_SHEETS = 3;          // contact sheets pasted back per render

function kitFile(...parts) { return path.join(KIT_DIR, ...parts); }

// --- the pages registry (the dashboards pattern): every rendered page is
// remembered in ~/.muse-agent/visual-pages.json so the Pages view and
// list_visual_pages find it across sessions. The entry holds paths only; the
// page, its source and its contact sheets stay in the project. -------------
function storeFile() { return path.join(require('./config').configDir(), 'visual-pages.json'); }

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(data.pages) ? data.pages : [];
  } catch { return []; }
}

function saveStore(pages) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify({ pages }, null, 2));
}

function registerPage(rec) {
  const pages = loadStore();
  const entry = {
    id: /^\w[\w-]*$/.test(String(rec.id || '')) ? String(rec.id) : require('node:crypto').randomUUID(),
    title: String(rec.title || 'Visual page').slice(0, 120),
    project: String(rec.project || ''),
    path: String(rec.path || ''),
    source: String(rec.source || ''),
    report: String(rec.report || ''),
    check: String(rec.check || ''),
    sheets: Array.isArray(rec.sheets) ? rec.sheets.map(String).slice(0, 4) : [],
    created: rec.created || new Date().toISOString(),
  };
  const at = pages.findIndex((p) => { try { return path.resolve(String(p.path)) === path.resolve(entry.path); } catch { return false; } });
  if (at >= 0) pages[at] = { ...pages[at], ...entry, id: pages[at].id, created: pages[at].created };
  else pages.push(entry);
  saveStore(pages);
  return entry;
}

function listPages() {
  return loadStore().map((p) => ({
    id: p.id, title: p.title, project: p.project, path: p.path, source: p.source || '',
    report: p.report || '', check: p.check || '', created: p.created,
  }));
}

function forgetPage(id) {
  const pages = loadStore();
  const next = pages.filter((p) => p.id !== String(id || ''));
  if (next.length === pages.length) return false;
  saveStore(next);
  return true;
}

// The entry's first contact sheet, as a data URL for the Pages view. Sheets
// live inside the entry's project; anything else is refused.
function pageThumb(id) {
  const entry = loadStore().find((p) => p.id === String(id || ''));
  if (!entry) return { ok: false, error: 'not found' };
  const root = entry.project ? path.resolve(entry.project) : null;
  if (!root) return { ok: false, error: 'no preview on record' };
  for (const sheet of entry.sheets || []) {
    const target = path.resolve(String(sheet));
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      return { ok: true, data: `data:image/png;base64,${fs.readFileSync(target).toString('base64')}` };
    } catch { /* keep looking */ }
  }
  return { ok: false, error: 'no preview on record' };
}

// The page source is jailed to the project/cwd, like other project file tools.
function resolveInside(ctx, input, { mustExist }) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'path is required' };
  if (raw.includes('\0')) return { error: 'path contains a null byte' };
  const base = path.resolve(ctx.cwd || process.cwd());
  const target = path.resolve(base, raw);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: `path must stay inside ${base}` };
  if (!/\.src\.html?$/i.test(target)) {
    return { error: 'the source must be named <name>.src.html (the rendered page becomes <name>.html)' };
  }
  let stat = null;
  try { stat = fs.statSync(target); } catch { if (mustExist) return { error: `no such source file: ${target}. Write it first with write_file. Existing pages are read and re-rendered with visual_render path.` }; }
  if (stat && !stat.isFile()) return { error: `${target} is not a file` };
  return { file: target };
}

async function renderSource(html, ctx, filename) {
  // ESM kit from a CJS module: dynamic import with a file URL.
  const { pathToFileURL } = require('node:url');
  const kit = await import(pathToFileURL(kitFile('kit', 'render.mjs')).href);
  const plan = await import(pathToFileURL(kitFile('plan', 'render.mjs')).href);
  const root = path.resolve(ctx.cwd || process.cwd());
  if (plan.hasPlan(html)) {
    const r = plan.renderPlan(html, { root });
    return { errors: r.errors || [], warnings: r.warnings || [], html: r.html, plan: true, summary: r.summary || '', report: r.report || null };
  }
  const r = kit.renderPage(html, { root });
  return { errors: r.errors || [], warnings: r.warnings || [], html: r.html, plan: false, report: r.report || null, reportLine: r.report ? kit.reportLine(r.report) : '' };
}

// Writes through a temp file + rename (the kit's own convention) and records
// the pre-image with the run checkpoint so the whole render can be undone.
async function writePage(ctx, target, html) {
  if (ctx.checkpoint) { try { await ctx.checkpoint.recordFile(target); } catch {} }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, html, 'utf8');
  await fsp.rename(temp, target);
}

function mkVisualTools(options = {}) {
  const docs = {
    name: 'visual_kit_docs',
    description: 'Read the Visual Explainer kit documentation: the HTML tag vocabulary (<ve-flow>, <ve-bars>, <ve-waffle>, <ve-stack>, <ve-ask>), drawing rules, state machines walked from code, motion (steppers, replays, style guide, themes, plans. Call with no doc to list them; then fetch only the docs the page needs before writing or revising a visual render.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', enum: Object.keys(DOCS), description: 'Which document to read; omit to list.' },
      },
      additionalProperties: false,
    },
    scope: 'project', sideEffect: false,
    async run(args) {
      const name = args && args.doc ? String(args.doc) : '';
      if (!name) return { ok: true, docs: Object.entries(DOCS).map(([id, file]) => ({ id, file, chars: (() => { try { return fs.statSync(kitFile('references', file)).size; } catch { return 0; } })() })) };
      const file = DOCS[name];
      if (!file) return { ok: false, error: `unknown doc “${name}”; one of ${Object.keys(DOCS).join(', ')}` };
      let text = '';
      try { text = fs.readFileSync(kitFile('references', file), 'utf8'); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      return {
        ok: true, doc: name,
        content: text.length > MAX_DOC ? `${text.slice(0, MAX_DOC)}\n… (truncated; ${text.length} chars total — ask for the rest only if needed)` : text,
      };
    },
  };

  const render = {
    name: 'visual_render',
    description: 'Render a visual explanation page to one self-contained HTML page (diagrams, architecture, comparisons, data tables, reviews, recaps). First write the source <name>.src.html with write_file (tags: visual_kit_docs), then call with path. The renderer inlines the shared design system, expands the data tags, renders Mermaid, and checks the page. On errors nothing is written: fix exactly the lines it names (small edits only — never rewrite the whole page) and call again. On success the page is written beside its source and a browser pass reports visual problems (text overlap, labels under 12 px, sideways scrolling) with up to three contact-sheet screenshots of the result. A terminal table of 4+ rows or 3+ columns should become a page. Ask the user first unless they asked for a visual.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative source file <name>.src.html (written with write_file). Renders it to <name>.html.' },
        html: { type: 'string', description: 'Instead of path: the complete page source; it is saved first, then rendered.' },
        filename: { type: 'string', description: 'With html: basename for the source; .src.html is appended when missing.' },
        check: { type: 'boolean', description: 'Run the browser check and contact sheets on success. Default true.' },
        publish: { type: 'boolean', description: 'Also publish the rendered page to the Design Studio canvas (.od/artifact.json) when the project is a design project. Default false.' },
      },
      additionalProperties: false,
    },
    scope: 'project', sideEffect: true,
    async run(args, ctx) {
      const look = require('./visual-look.ts');
      try {
        let source, sourceFile;
        if (args && args.html != null) {
          const html = String(args.html);
          if (Buffer.byteLength(html) > MAX_SOURCE) return { ok: false, error: `page source exceeds ${MAX_SOURCE} bytes` };
          let base = String(args.filename || 'page.src.html').trim().replace(/\.src\.html?$/i, '');
          if (!base || base.includes('..') || /[\\/]/.test(base)) return { ok: false, error: 'filename must be a bare name like "auth-flow"' };
          const resolved = resolveInside(ctx, path.join('diagrams', `${base}.src.html`), { mustExist: false });
          if (resolved.error) return { ok: false, error: resolved.error };
          sourceFile = resolved.file;
          if (ctx.checkpoint) { try { await ctx.checkpoint.recordFile(sourceFile); } catch {} }
          await fsp.mkdir(path.dirname(sourceFile), { recursive: true });
          await fsp.writeFile(sourceFile, html, 'utf8');
          source = html;
        } else {
          const resolved = resolveInside(ctx, args && args.path, { mustExist: true });
          if (resolved.error) return { ok: false, error: resolved.error };
          sourceFile = resolved.file;
          source = await fsp.readFile(sourceFile, 'utf8');
        }
        if (Buffer.byteLength(source) > MAX_SOURCE) return { ok: false, error: `page source exceeds ${MAX_SOURCE} bytes` };

        const rendered = await renderSource(source, ctx, sourceFile);
        if (rendered.errors.length) {
          return {
            ok: false,
            errors: rendered.errors.map(e => String(e)),
            error: `The page has ${rendered.errors.length} error(s); nothing was written. Fix these in ${path.basename(sourceFile)} and render again (small edits only):\n${rendered.errors.map(e => `- ${e}`).join('\n')}`,
            warnings: rendered.warnings,
          };
        }
        const pageFile = sourceFile.replace(/\.src(\.html?)$/i, '$1');
        await writePage(ctx, pageFile, rendered.html);
        const writtenSheets = [];
        const out = {
          ok: true,
          path: pageFile,
          source: sourceFile,
          ...(rendered.reportLine ? { report: rendered.reportLine } : rendered.summary ? { plan: rendered.summary } : {}),
          warnings: rendered.warnings,
          note: rendered.plan ? 'Plan page rendered. Edit the source and render again for revisions.' : `Source kept beside the page; edit ${path.basename(sourceFile)} and render again for revisions.`,
        };

        if (args.publish) {
          try {
            const design = require('./design.ts');
            const projectDir = path.resolve(ctx.cwd || process.cwd());
            if (design.isDesignProject(projectDir)) {
              out.artifact = design.writeArtifact(projectDir, {
                kind: /\.html?$/i.test(pageFile) ? 'html' : 'document',
                entry: path.relative(projectDir, pageFile),
                title: path.basename(pageFile, path.extname(pageFile)),
                status: 'complete', supportingFiles: [path.relative(projectDir, sourceFile)],
              });
              out.note += ' Published to the Design Studio canvas.';
            } else {
              out.note += ' (publish: not a Design Studio project — canvas publish skipped.)';
            }
          } catch (e) { out.note += ` (publish failed: ${String(e && e.message || e)})`; }
        }

        if (args.check !== false && !rendered.plan) {
          const looked = await look.lookAt(pageFile);
          if (looked.skipped) {
            out.check = `skipped: ${looked.skipped}`;
          } else {
            out.problems = looked.problems || [];
            out.errors = looked.errors || [];
            if ((looked.sheets || []).length) {
              // replace older contact sheets, like the kit's renderer does
              try {
                const own = new RegExp(`^${path.basename(pageFile).replace(/\.html?$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.sheet(?:-\\d+)?\\.png$`);
                for (const stale of fs.readdirSync(path.dirname(pageFile))) if (own.test(stale)) { try { await fsp.unlink(path.join(path.dirname(pageFile), stale)); } catch {} }
              } catch {}
              const images = [];
              for (const sheet of looked.sheets.slice(0, MAX_SHEETS)) {
                try {
                  const buf = Buffer.isBuffer(sheet.png) ? sheet.png : Buffer.from(sheet.png);
                  const sheetPath = sheet.path || `${pageFile.replace(/\.html?$/i, '')}.sheet${images.length ? `-${images.length + 1}` : ''}.png`;
                  if (ctx.checkpoint) { try { await ctx.checkpoint.recordFile(sheetPath); } catch {} }
                  await fsp.writeFile(sheetPath, buf);
                  writtenSheets.push(sheetPath);
                  images.push({ type: 'image', mimeType: 'image/png', data: buf.toString('base64') });
                } catch {}
              }
              if (images.length) out.images = images;
            }
            out.check = (out.problems || []).length
              ? `${out.problems.length} visual problem(s) — fix them in ${path.basename(sourceFile)} and render again`
              : 'passed';
          }
        }
        // remembered in the pages registry so the Pages view and
        // list_visual_pages find it from the next session on
        try {
          registerPage({
            title: path.basename(pageFile).replace(/\.html?$/i, ''),
            project: path.resolve(ctx.cwd || process.cwd()),
            path: pageFile, source: sourceFile,
            report: rendered.reportLine || rendered.summary || '',
            check: typeof out.check === 'string' ? out.check : '',
            sheets: writtenSheets,
          });
        } catch { /* a full registry never fails a render */ }
        return out;
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },
  };

  const pagesTool = {
    name: 'list_visual_pages',
    description: 'List the visual pages rendered before (title, project, page file, report, check). Use this before drawing a new page to reuse or update an existing one: its .src.html source sits beside the page — write_file the edits and call visual_render with that path.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'project', sideEffect: false,
    async run() {
      return { ok: true, pages: listPages() };
    },
  };

  return [docs, render, pagesTool];
}

const VISUAL_TOOL_NAMES = ['visual_kit_docs', 'visual_render', 'list_visual_pages'];
const VISUAL_READ_NAMES = ['visual_kit_docs', 'list_visual_pages'];
const VISUAL_WRITE_NAMES = ['visual_render'];

module.exports = {
  mkVisualTools, VISUAL_TOOL_NAMES, VISUAL_READ_NAMES, VISUAL_WRITE_NAMES,
  registerPage, listPages, forgetPage, pageThumb,
};