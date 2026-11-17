import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

// entry-syntax.test.mts - every file the packaged app loads must parse.
//
// Motivation: a duplicated `catch` in an ipcMain handler passed the unit suite
// (those files are only required by the Electron main process, never by these
// tests) and only blew up at launch with "A JavaScript error occurred in the
// main process". electron-builder copies bytes without parsing them either.
//
// Method: strip TypeScript types, then syntax-check as an ES module. CommonJS
// sources parse fine in that mode, so one pass covers .js, .cjs and .ts.

const root = path.resolve(import.meta.dirname, '..', '..');

function appSources(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      out.push(...appSources(full));
    } else if (/\.(?:js|cjs|mjs|ts|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('all application sources parse before packaging', () => {
  const files = appSources(path.join(root, 'app'));
  assert.ok(files.length > 40, `expected the app tree to contain sources, found ${files.length}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-syntax-'));
  const broken = [];
  try {
    files.forEach((file, index) => {
      const source = fs.readFileSync(file, 'utf8');
      let code = source;
      try {
        code = /\.m?ts$/.test(file) ? stripTypeScriptTypes(source) : source;
      } catch (error) {
        broken.push(`${path.relative(root, file)}: types could not be stripped: ${error.message}`);
        return;
      }
      const probe = path.join(scratch, `entry-${index}.mjs`);
      fs.writeFileSync(probe, code, 'utf8');
      const result = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8', timeout: 20000 });
      if (result.status !== 0) {
        const detail = String(result.stderr || '').split('\n').filter(line => line.trim())[0] || 'syntax error';
        broken.push(`${path.relative(root, file)}: ${detail}`);
      }
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.deepEqual(broken, [], 'application files with syntax errors');
});

test('main-process entry points expose the design workspace surface', () => {
  const main = fs.readFileSync(path.join(root, 'app/main/index.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
  for (const channel of ['design:status', 'design:files:list', 'design:registry:list', 'design:registry:read', 'design:template:apply', 'design:save']) {
    assert.ok(main.includes(`'${channel}'`), `main process is missing the ${channel} handler`);
  }
  for (const bridge of ['designRegistryList', 'designRegistryRead', 'designApplyTemplate', 'onDesignArtifact']) {
    assert.ok(preload.includes(bridge), `preload is missing ${bridge}`);
  }
  assert.ok(main.includes('design.captureArtifacts('), 'inline artifact capture must stay wired to agent messages');
});
