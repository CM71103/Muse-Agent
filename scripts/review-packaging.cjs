'use strict';
// Read-only packaging checks. Run: node scripts/review-packaging.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { NtExecutable, NtExecutableResource } = require('resedit');
process.chdir(path.join(__dirname, '..'));
const output = process.argv[2] || 'dist/win-unpacked';
const exe = path.join(output, 'Muse Agent.exe');
const archive = path.join(output, 'resources/app.asar');
const resources = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(exe)));
const integrity = resources.entries.find(e => e.type === 'INTEGRITY' && e.id === 'ELECTRONASAR');
assert.ok(integrity, 'EXE integrity resource missing');
const expected = JSON.parse(Buffer.from(integrity.bin).toString())[0].value;
const actual = crypto.createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
assert.equal(actual, expected, 'ASAR header does not match EXE integrity resource');
console.log('PASS: ASAR header matches EXE integrity resource');
console.log('Packaged native binaries:', asar.listPackage(archive).filter(p => p.endsWith('.node')));
const binding = require('../node_modules/better-sqlite3/lib/binding');
console.log('Preferred installed SQLite binding:', binding.getPrebuildPath());
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const executable of [exe, 'node_modules/electron/dist/electron.exe']) {
  for (const nodeMode of [false, true]) {
    const result = spawnSync(executable, nodeMode ? ['-e', 'console.log(process.versions)'] : ['--version'], {
      env: nodeMode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
      stdio: 'inherit', timeout: 5000,
    });
    console.log(JSON.stringify({ executable, nodeMode, status: result.status,
      hex: result.status === null ? null : '0x' + (result.status >>> 0).toString(16),
      error: result.error && result.error.message }));
  }
}
const Database = require('better-sqlite3');
const db = new Database(':memory:');
try { assert.equal(db.prepare('SELECT 1 AS n').get().n, 1); }
finally { db.close(); }
console.log('PASS: installed SQLite binding loads in host Node');
const packagedBinding = path.resolve(output, 'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds', `${process.platform}-${process.arch}.node`);
const packagedDb = new Database(':memory:', { nativeBinding: packagedBinding });
try { assert.equal(packagedDb.prepare('SELECT 1 AS n').get().n, 1); }
finally { packagedDb.close(); }
console.log('PASS: packaged SQLite binding loads in host Node');
const names = asar.listPackage(archive);
console.log('Packaged icon present:', names.some(p => /[\\/]build[\\/]icon\.ico$/.test(p)));
console.log('Packaged main matches source:', asar.extractFile(archive, path.join('app', 'main', 'index.js')).equals(fs.readFileSync('app/main/index.js')));
console.log('Inherited ELECTRON_RUN_AS_NODE:', process.env.ELECTRON_RUN_AS_NODE || '(unset)');
// Exit codes above belong to child processes; nonzero means startup needs investigation.
