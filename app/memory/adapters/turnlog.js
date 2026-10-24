'use strict';
// memory/adapters/turnlog.js — JSONL export adapter (spec §2, §8).
// JSONL is EXPORT, never write-ahead: this adapter only writes files on an
// explicit export request, and nothing in the layer reads them back as a
// recovery source (do-not list / R-42 family). Deletion flows through the
// layer: an export excludes deleted rows and records the deletion inventory
// as its first line so the file self-describes its omissions.

const fs = require('fs');
const path = require('path');

// rows: iterable of JSON-serializable turn/memory objects.
// deletedIds: ids logically deleted in the layer (excluded from rows too).
// inventory: the deletion inventory object from layer.listDeleted().
// Returns the absolute file path written.
function writeExport(file, { rows, deletedIds, inventory, meta }) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const delSet = new Set(deletedIds || []);
  const lines = [];
  lines.push(JSON.stringify({
    kind: 'muse-memory-export',
    schema: 1,
    created_at: new Date().toISOString(),
    excluded_deleted_count: delSet.size,
    deleted_ids: [...delSet],
    deletion_inventory: inventory || null,
    meta: meta || null,
  }));
  let n = 0;
  for (const row of rows || []) {
    if (row && delSet.has(row.id)) continue;      // belt and braces: never export deleted
    lines.push(JSON.stringify(row));
    n++;
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { file, rows: n, deleted_excluded: delSet.size };
}

// Read is deliberately absent from the public surface: JSONL is one-way.
function readExport() {
  throw new Error('turnlog JSONL is export-only, never a recovery source');
}

module.exports = { writeExport, readExport };
