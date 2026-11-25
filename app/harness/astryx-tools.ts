'use strict';
// astryx-tools.ts - the Astryx design system as a Muse capability.
//
// The kit in ./astryx-kit carries the conventions and the theme tokens, so
// when a user asks Muse to design something the output is born on the system
// instead of ad-hoc CSS. astryx_docs teaches the conventions; astryx_check is
// the delivery gate: a deterministic lint of the built output (no network, no
// package needed in the target project). If the target project has the real
// CLI installed, the agent should also run `npx astryx doctor --built <dir>`
// through shell; the lint below is the always-available floor.

const fs = require('fs');
const path = require('path');

const KIT_DIR = path.join(__dirname, 'astryx-kit');

function readKitDoc() {
  try { return fs.readFileSync(path.join(KIT_DIR, 'CONVENTIONS.md'), 'utf8'); }
  catch (e) { return `Astryx kit unavailable: ${e.message}`; }
}

// ---- the lint ------------------------------------------------------------
// Rules are the ones that break generated UI most often and are provable from
// text alone:
//   R1 raw hex color in an inline style or <style> block (use tokens)
//   R2 raw px length in an inline style (use tokens/scale)
//   R3 text color variable on the same background variable (invisible text)
const MAX_FILES = 40;
const MAX_PROBLEMS = 200;

function lintText(file, text) {
  const problems = [];
  const push = (line, rule, sample) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ file, line, rule, sample: String(sample).trim().slice(0, 120) });
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*(\/\*|\*|\/\/)/.test(ln)) continue;              // comments are free
    if (/^\s*--[\w-]+\s*:/.test(ln)) continue;                // token definitions are the token layer
    // R3: same variable as text and background on one rule/attribute
    const pair = /color:\s*var\((--[\w-]+)\)\s*;[^"'{}]*background:\s*var\(\1\)/.exec(ln)
      || /background:\s*var\((--[\w-]+)\)\s*;[^"'{}]*color:\s*var\(\1\)/.exec(ln);
    if (pair) push(i + 1, 'R3 text and background are the same token (invisible text)', ln);
    // R4: the risky pair - --color-primary text on an --color-accent fill.
    // Themes may define those two as the same value (they have), so this
    // pairing ships invisible text; --color-accent-fg is the pair for it.
    const risky = /color:\s*var\(--color-primary\)\s*;[^"'{}]*background:\s*var\(--color-accent\)/.exec(ln)
      || /background:\s*var\(--color-accent\)\s*;[^"'{}]*color:\s*var\(--color-primary\)/.exec(ln);
    if (risky) push(i + 1, 'R4 text uses --color-primary on an --color-accent fill: use --color-accent-fg', ln);
    // R1/R2 only inside style contexts (style="..." or a <style> block line)
    const inStyle = /style\s*=/.test(ln) || /(^|\s)(color|background|border|padding|margin|font|width|height|gap|top|left|right|bottom):/.test(ln);
    if (!inStyle) continue;
    const hex = /#[0-9a-fA-F]{3,8}\b/.exec(ln);
    if (hex) push(i + 1, `R1 raw hex color (${hex[0]}): use a token`, ln);
    const px = /(?<!-[\w-]*):[^;{}"]*\b\d+px\b/.exec(ln);
    // px inside calc() over a token is token math (calc(var(--size-x) - 8px)),
    // not a raw value; raw px in calc with no token is still a violation.
    if (px && !(ln.includes('calc(') && ln.includes('var(--'))) push(i + 1, 'R2 raw px length: use the spacing/type scale', ln);
  }
  return problems;
}

function lintPath(target) {
  const root = path.resolve(target || '.');
  const files = [];
  const walk = (p, depth) => {
    if (files.length >= MAX_FILES || depth > 6) return;
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      const base = path.basename(p);
      if (/^(node_modules|\.git|dist|build)$/.test(base)) return;
      for (const name of fs.readdirSync(p)) walk(path.join(p, name), depth + 1);
    } else if (/\.(html?|css)$/i.test(p)) {
      files.push(p);
    }
  };
  walk(root, 0);
  const problems = [];
  for (const file of files) {
    try {
      problems.push(...lintText(path.relative(root, file) || path.basename(file), fs.readFileSync(file, 'utf8')));
    } catch { /* unreadable file: skip */ }
    if (problems.length >= MAX_PROBLEMS) break;
  }
  return { files: files.length, problems };
}

function mkAstryxTools() {
  const docs = {
    name: 'astryx_docs',
    description: 'The Astryx design system conventions for UI Muse designs or builds: structure vocabulary (Section, Stack, Card, rows for dense data, Selector for pickers), the prop naming language, styling rules (tokens only, no raw hex/px, semantic color pairs), and the delivery gate. Read this before designing any interface for the user.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'project', sideEffect: false,
    async run() {
      return { ok: true, conventions: readKitDoc(), tokens: 'Embed astryx-kit/tokens.css (bundled with Muse) in standalone pages; it activates inside data-astryx-theme="neutral" and handles light/dark itself.' };
    },
  };
  const check = {
    name: 'astryx_check',
    description: 'Delivery gate for UI Muse designed with the Astryx system: lints the built HTML/CSS at a path for raw hex colors, raw px lengths, and text that shares its background token (invisible text). Returns problems with file and line. Fix everything it reports before delivering; if the project has @astryxdesign/cli installed, also run `npx astryx doctor --built <dir>`.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or folder to lint, relative to the project root ("." is the root)' },
      },
      additionalProperties: false,
    },
    scope: 'project', sideEffect: false,
    async run(args) {
      const target = typeof args?.path === 'string' && args.path.trim() ? args.path : '.';
      const { files, problems } = lintPath(target);
      return {
        ok: problems.length === 0,
        filesChecked: files,
        problems,
        note: problems.length
          ? `${problems.length} problem(s): fix them and run astryx_check again.`
          : 'Clean: no raw hex, no raw px, no invisible-text pairs.',
      };
    },
  };
  return [docs, check];
}

const ASTRYX_TOOL_NAMES = ['astryx_docs', 'astryx_check'];
const ASTRYX_READ_NAMES = ['astryx_docs', 'astryx_check'];

module.exports = { mkAstryxTools, ASTRYX_TOOL_NAMES, ASTRYX_READ_NAMES };