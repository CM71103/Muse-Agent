import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkMetadata, sourceManifest, verifyArchive } from '../release-check.mts';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

test('release metadata rejects version and dependency drift', () => {
  const pkg = { name: 'fixture', version: '1.2.3', dependencies: { sqlite: '^1' } };
  const lock = { ...pkg, packages: { '': structuredClone(pkg) } };
  checkMetadata(pkg, lock);
  assert.throws(() => checkMetadata(pkg, { ...lock, version: '1.0.0' }), /version/);
  lock.packages[''].dependencies.sqlite = '^2';
  assert.throws(() => checkMetadata(pkg, lock), /dependencies/);
});

test('archive verification detects stale source, unexpected files and local config', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-release-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  fs.mkdirSync(path.join(source, 'app/test'), { recursive: true });
  fs.mkdirSync(path.join(source, 'app/harness'), { recursive: true });
  fs.mkdirSync(path.join(source, 'build'));
  fs.writeFileSync(path.join(source, 'app/harness/main.js'), 'original');
  fs.writeFileSync(path.join(source, 'app/test/fixture.test.js'), 'excluded');
  fs.writeFileSync(path.join(source, 'build/icon.ico'), 'icon');
  fs.writeFileSync(path.join(source, 'config.example.toml'), '# template');
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'app/harness/main.js' }));
  const manifest = sourceManifest(source);
  assert.ok(!Object.hasOwn(manifest, 'app/test/fixture.test.js'));
  fs.rmSync(path.join(source, 'app/test'), { recursive: true });
  const archive = path.join(temp, 'app.asar');
  const pack = async () => { asar.uncacheAll(); await asar.createPackage(source, archive); asar.uncacheAll(); };
  await pack();
  verifyArchive(source, archive, manifest);
  fs.writeFileSync(path.join(source, 'app/harness/main.js'), 'changed');
  await pack();
  assert.throws(() => verifyArchive(source, archive, manifest), /differs from source/);
  fs.writeFileSync(path.join(source, 'app/harness/main.js'), 'original');
  fs.writeFileSync(path.join(source, 'app/extra.js'), 'unexpected');
  await pack();
  assert.throws(() => verifyArchive(source, archive, manifest), /Unexpected application file/);
  fs.rmSync(path.join(source, 'app/extra.js'));
  fs.writeFileSync(path.join(source, 'config.toml'), 'private');
  await pack();
  assert.throws(() => verifyArchive(source, archive, manifest), /Private\/local file/);
});
