'use strict';
// scripts/check-native.js — pre-dist guard: refuse to package a native module
// binary of the wrong platform (e.g. a Linux ELF left by a sandbox rebuild).
// Wired via predist hooks in package.json.

const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(p)) {
  console.error('better-sqlite3 native binary missing. Run: npm install');
  process.exit(1);
}
const head = fs.readFileSync(p).subarray(0, 2).toString('latin1');
const wantPE = process.platform === 'win32';
if (wantPE && head !== 'MZ') {
  console.error('better-sqlite3 native binary is not a Windows executable (expected MZ header).');
  console.error('Fix on Windows:  npm run rebuild:electron   then package again.');
  process.exit(1);
}
if (!wantPE && head !== '\x7fE') {
  console.error('better-sqlite3 native binary is not a Linux ELF.');
  console.error('Fix:  npm rebuild better-sqlite3');
  process.exit(1);
}
console.log('native check ok: ' + (wantPE ? 'win32 PE' : 'linux ELF'));
