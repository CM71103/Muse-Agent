import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const digest = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function checkMetadata(pkg: any, lock: any) {
  assert.equal(lock.name, pkg.name, 'Lockfile name differs from package.json');
  assert.equal(lock.version, pkg.version, 'Lockfile version differs from package.json');
  const locked = lock.packages?.[''];
  assert.ok(locked, 'Lockfile root package is missing');
  for (const key of ['name', 'version', 'dependencies', 'devDependencies', 'engines']) {
    assert.deepEqual(locked[key], pkg[key], `Lockfile ${key} differs from package.json`);
  }
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Release sources must not contain symlinks: ${full}`);
    return entry.isDirectory() ? files(full) : [full];
  });
}

export function sourceManifest(directory: string) {
  const included = [...files(path.join(directory, 'app')),
    path.join(directory, 'build/icon.ico'), path.join(directory, 'config.example.toml')];
  return Object.fromEntries(included.map(file => path.relative(directory, file).replaceAll('\\', '/'))
    .filter(file => !file.split('/').includes('test'))
    .sort().map(file => [file, digest(fs.readFileSync(path.join(directory, file)))]));
}

export function verifyArchive(directory: string, archive: string, manifest: Record<string, string>) {
  const asar = require('@electron/asar');
  const names: string[] = asar.listPackage(archive).map((name: string) => name.replaceAll('\\', '/').replace(/^\//, ''));
  for (const name of names) {
    assert.ok(!/(^|\/)(?:config\.toml|\.env(?:\..*)?|debug\.log)$/.test(name), `Private/local file packaged: ${name}`);
    assert.ok(!/^(?:app\/.*\/test\/|python\/|edit-test\/|integrity-test\/|release-verified\/)/.test(name), `Development artifact packaged: ${name}`);
    if (name.startsWith('app/') && !asar.statFile(archive, name.split('/').join(path.sep)).files) {
      assert.ok(Object.hasOwn(manifest, name), `Unexpected application file packaged: ${name}`);
    }
  }
  for (const [file, hash] of Object.entries(manifest)) {
    // electron-builder moves extraResources outside ASAR; main() checks that template separately.
    if (file === 'config.example.toml') continue;
    assert.equal(digest(asar.extractFile(archive, file.split('/').join(path.sep))), hash, `Packaged file differs from source: ${file}`);
  }
  const pkg = json(path.join(directory, 'package.json'));
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  for (const key of ['name', 'version', 'main', 'dependencies']) {
    assert.deepEqual(packaged[key], pkg[key], `Packaged metadata differs: ${key}`);
  }
}

function run(label: string, executable: string, args: string[], env = process.env, timeout = 300000, capture = false) {
  console.log(`\n${label}`);
  const result = spawnSync(executable, args, { cwd: root, env, stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8', timeout, windowsHide: true });
  if (capture && result.stdout) process.stdout.write(result.stdout);
  if (capture && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  assert.equal(result.status, 0, `${label} failed (exit ${result.status}, signal ${result.signal})`);
  return result.stdout || '';
}

export function main(args: string[]) {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--preflight'),
    'Usage: bun run release:check [--preflight]');
  const output = path.join(root, 'dist/release-check');
  const report = path.join(output, 'release-report.json');
  if (!args.length) fs.rmSync(report, { force: true });
  const pkg = json(path.join(root, 'package.json'));
  checkMetadata(pkg, json(path.join(root, 'package-lock.json')));
  const bunExecutable = process.env.npm_execpath;
  assert.ok(bunExecutable && /^bun(?:\.exe)?$/i.test(path.basename(bunExecutable)),
    'Run this check with bun run release:check so the renderer can be rebuilt');
  run('Build renderer shader bundle', bunExecutable, ['run', 'build:renderer']);
  const manifest = sourceManifest(root);
  const tests = [path.join(root, 'app/harness/test'), path.join(root, 'app/renderer/test'), path.join(root, 'scripts/test')]
    .flatMap(directory => files(directory).filter(file => /\.test\.(?:js|ts|mts)$/.test(file)));
  const inputPaths = [...tests, path.join(root, 'scripts/build-renderer.mts'), ...files(path.join(root, 'scripts/renderer')),
    path.join(root, 'package.json'), path.join(root, 'package-lock.json'), fileURLToPath(import.meta.url)];
  const validationInputs = () => Object.fromEntries(inputPaths.map(file =>
    [path.relative(root, file).replaceAll('\\', '/'), digest(fs.readFileSync(file))]));
  const inputs = validationInputs();
  run('Test suite', process.execPath, ['--test', ...tests]);
  run('Host SQLite smoke check', process.execPath, ['scripts/check-native.js']);
  if (args[0] === '--preflight') {
    console.log('PASS: release preflight (packaging not checked)');
    return;
  }
  assert.equal(process.platform, 'win32', 'Windows release packaging must run on Windows');
  fs.mkdirSync(output, { recursive: true });
  run('Build Windows app', process.execPath, [require.resolve('electron-builder/cli.js'), '--win', '--dir',
    `--config.directories.output=${output}`]);
  assert.deepEqual(sourceManifest(root), manifest, 'Source changed during release validation; rerun the check');
  assert.deepEqual(validationInputs(), inputs, 'Metadata or tests changed during release validation; rerun the check');
  const unpacked = path.join(output, 'win-unpacked');
  const archive = path.join(unpacked, 'resources/app.asar');
  verifyArchive(root, archive, manifest);
  assert.equal(digest(fs.readFileSync(path.join(unpacked, 'resources/template.toml'))), manifest['config.example.toml'],
    'Packaged template differs from source');
  const exe = path.join(unpacked, `${pkg.productName}.exe`);
  const { NtExecutable, NtExecutableResource } = require('resedit');
  const resources = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(exe)));
  const integrity = resources.entries.find((entry: any) => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
  assert.ok(integrity, 'Packaged executable has no ASAR integrity resource');
  const expected = JSON.parse(Buffer.from(integrity.bin).toString())
    .find((entry: any) => entry.file.replaceAll('\\', '/') === 'resources/app.asar');
  assert.ok(expected, 'Packaged executable has no app.asar integrity entry');
  assert.equal(digest(require('@electron/asar').getRawHeader(archive).headerString), expected.value,
    'Packaged executable and ASAR integrity disagree');
  const smoke = `require('node:assert/strict').ok(process.versions.electron, 'Must run inside Electron'); const D=require(${JSON.stringify(path.join(unpacked, 'resources/app.asar/node_modules/better-sqlite3'))}); const db=new D(':memory:'); require('node:assert/strict').equal(db.prepare('SELECT 1 AS n').get().n,1); db.close(); const Agent=require(${JSON.stringify(path.join(unpacked, 'resources/app.asar/app/harness/agent.js'))}).Agent; require('node:assert/strict').equal(typeof Agent.prototype.run,'function'); require('node:assert/strict').equal(typeof Agent.prototype.ingestUserTurn,'function'); console.log('PASS: packaged Electron SQLite');`;
  const smokeOutput = run('Packaged Electron SQLite smoke check', exe, ['-e', smoke],
    { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, 30000, true);
  assert.ok(smokeOutput.includes('PASS: packaged Electron SQLite'), 'Packaged SQLite probe did not execute');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, 'Cannot record release Git provenance');
    return result.stdout.trim();
  };
  fs.writeFileSync(report, JSON.stringify({ version: pkg.version, checkedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']), workingTree: git(['status', '--porcelain']),
    node: process.version, platform: process.platform, arch: process.arch, source: manifest, validationInputs: inputs,
    packageSha256: digest(fs.readFileSync(path.join(root, 'package.json'))),
    lockfileSha256: digest(fs.readFileSync(path.join(root, 'package-lock.json'))),
    checkerSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
    archiveSha256: digest(fs.readFileSync(archive)), executableSha256: digest(fs.readFileSync(exe)),
    scope: 'Unpacked Windows app; installer, portable launcher and visual UI behavior are not verified',
  }, null, 2) + '\n');
  console.log(`PASS: Windows package verified. Receipt: ${report}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`Release check failed: ${(error as Error).message}`); process.exitCode = 1; }
}
