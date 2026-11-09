'use strict';
// Pre-dist guard: load and query the runtime-selected native binding.

// Exercise the same binding selection as the app, including platform prebuilds.
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try { require('node:assert/strict').equal(db.prepare('SELECT 1 AS n').get().n, 1); }
  finally { db.close(); }
  console.log(`native check ok: ${process.platform}-${process.arch}`);
} catch (error) {
  console.error('better-sqlite3 native binding failed:', error.message);
  console.error('Run npm install on the target platform, then package again.');
  process.exit(1);
}
