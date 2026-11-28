'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'instrument-panel.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, '..', 'main', 'index.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, '..', 'main', 'preload.js'), 'utf8');

// Declarations of the block whose selector starts at `selector`, as a map.
function declarations(selector) {
  const start = CSS.indexOf(selector + '{');
  assert.ok(start >= 0, `missing rule: ${selector}`);
  const open = CSS.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < CSS.length; end++) {
    if (CSS[end] === '{') depth++;
    else if (CSS[end] === '}' && --depth === 0) break;
  }
  const body = CSS.slice(open + 1, end);
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const LIGHT = declarations('body[data-theme^="instrument"]');
const NIGHT = declarations('body[data-theme="instrument-night"]');
const DENSE = declarations('body[data-theme^="instrument"][data-density="dense"]');

const PALETTE_TOKENS = [
  '--color-background', '--color-foreground', '--color-card', '--color-muted-fg',
  '--color-border', '--color-brand', '--color-accent', '--color-accent-fg',
  '--color-primary', '--color-primary-fg', '--color-rail', '--color-rail-fg',
  '--color-surface-panel', '--color-user-bubble',
];

const DENSITY_TOKENS = [
  '--ins-strip-h', '--ins-strip-pad', '--ins-strip-font', '--ins-cell-pad',
  '--ins-idea-pad', '--ins-log-font', '--ins-log-time', '--ins-log-row-y',
  '--ins-log-row-x', '--ins-log-max',
];

function luminance(hex) {
  const channel = (i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
const px = (value) => parseFloat(value);

test('both instrument palettes carry the full token set', () => {
  for (const token of PALETTE_TOKENS) {
    assert.match(LIGHT[token] || '', /^#|^rgb|^var\(/, `light is missing ${token}`);
    assert.match(NIGHT[token] || '', /^#|^rgb|^var\(/, `night is missing ${token}`);
  }
  assert.equal(LIGHT['--color-background'], '#f6f5f1');
  assert.equal(NIGHT['--color-background'], '#0e1114');
  assert.notEqual(NIGHT['--color-foreground'], LIGHT['--color-foreground']);
});

test('night text and signal clear WCAG AA on their own grounds', () => {
  for (const token of ['--color-code-bg', '--color-code-fg']) {
    assert.match(NIGHT[token] || '', /^#/, `night must redeclare ${token} for dark code panels`);
  }
  const pairs = [
    [NIGHT['--color-foreground'], NIGHT['--color-background'], 7],
    [NIGHT['--color-muted-fg'], NIGHT['--color-background'], 4.5],
    [NIGHT['--color-muted-fg'], NIGHT['--color-card'], 4.5],
    [NIGHT['--color-brand'], NIGHT['--color-background'], 4.5],
    [NIGHT['--color-accent-fg'], NIGHT['--color-accent'], 4.5],
    [NIGHT['--color-primary-fg'], NIGHT['--color-primary'], 7],
    [NIGHT['--color-rail-fg'], NIGHT['--color-rail'], 7],
    [NIGHT['--color-code-fg'], NIGHT['--color-code-bg'], 7],
  ];
  for (const [fg, bg, min] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= min, `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
  }
});

test('light instrument text and signal still clear WCAG AA', () => {
  const pairs = [
    [LIGHT['--color-foreground'], LIGHT['--color-background'], 7],
    [LIGHT['--color-muted-fg'], LIGHT['--color-background'], 4.5],
    [LIGHT['--color-muted-fg'], LIGHT['--color-card'], 4.5],
    [LIGHT['--color-accent-fg'], LIGHT['--color-accent'], 4.5],
    [LIGHT['--color-primary-fg'], LIGHT['--color-primary'], 4.5],
  ];
  for (const [fg, bg, min] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= min, `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
  }
});

test('dense is the tight half of the pair and never shrinks type past reading size', () => {
  for (const token of DENSITY_TOKENS) {
    assert.ok(LIGHT[token], `comfortable is missing ${token}`);
    assert.ok(DENSE[token], `dense is missing ${token}`);
  }
  assert.ok(px(DENSE['--ins-strip-h']) < px(LIGHT['--ins-strip-h']));
  assert.ok(px(DENSE['--ins-log-row-y']) < px(LIGHT['--ins-log-row-y']));
  assert.ok(px(DENSE['--ins-cell-pad']) < px(LIGHT['--ins-cell-pad']));
  assert.ok(px(DENSE['--ins-log-max']) > px(LIGHT['--ins-log-max']), 'dense should show more of the log');
  assert.ok(px(DENSE['--ins-log-font']) >= 11, '11px is the floor for the log');
  assert.ok(px(DENSE['--ins-log-time']) >= 9.5);
});

test('tokens drive the strip, the log and the idea cards instead of one-off values', () => {
  for (const token of ['--ins-strip-h', '--ins-strip-font', '--ins-cell-pad', '--ins-idea-pad', '--ins-log-font', '--ins-log-row-y', '--ins-log-max', '--ins-log-time']) {
    assert.ok(CSS.includes(`var(${token})`), `${token} is defined but never used`);
  }
});

test('the appearance picker offers both palettes and a density pair for instrument', () => {
  assert.match(HTML, /data-theme-pick="instrument-night"[^>]*class="swatch sw-instrument-night"/);
  assert.ok(HTML.indexOf('data-theme-pick="instrument"') < HTML.indexOf('data-theme-pick="instrument-night"'));
  assert.equal((HTML.match(/data-theme-pick=/g) || []).length, 8);
  assert.match(HTML, /id="instrument-density"[^>]*hidden/);
  assert.match(CSS, /body\[data-theme="instrument-night"\]\{/);
  const group = HTML.slice(HTML.indexOf('id="instrument-density"'));
  assert.equal((group.match(/data-density-pick=/g) || []).length, 2);
  assert.match(group, /data-density-pick="comfortable"[^>]*aria-pressed="true"/);
  assert.match(group, /data-density-pick="dense"[^>]*aria-pressed="false"/);
  assert.match(group, /role="group" aria-label="Instrument row density"/);
});

test('the renderer persists and restores palette and density together', () => {
  assert.match(RENDERER, /const THEMES = \['instrument', 'instrument-night',/);
  assert.match(RENDERER, /setAppearance\?\.\(name, currentDensity\)/);
  assert.match(RENDERER, /setAppearance\?\.\(currentTheme, currentDensity\)/);
  assert.match(RENDERER, /getAppearance\?\.\(\)/);
  assert.match(RENDERER, /document\.body\.setAttribute\('data-density', currentDensity\)/);
  assert.match(RENDERER, /panel\.hidden = !INSTRUMENT_THEMES\.includes\(name\)/);
  assert.match(RENDERER, /data-density-pick/);
  assert.match(PRELOAD, /setAppearance: \(theme, density\) => ipcRenderer\.invoke\('appearance:set', theme, density\)/);
  assert.match(MAIN, /ipcMain\.handle\('appearance:set', \(e, theme, density\)/);
  assert.match(MAIN, /density: density === 'dense' \? 'dense' : 'comfortable'/);
  assert.match(MAIN, /density: data\.density === 'dense' \? 'dense' : 'comfortable'/);
});
