#!/usr/bin/env node
// Maintenance: removes auto-extracted memories from the database.
//
// Pre-fix this script defaulted to "delete everything matched", and the
// match was a substring on the JSON-encoded tags column ('%auto-extracted%').
// That deleted any memory whose tags contained `auto-extracted` as a literal
// substring (e.g. `not-auto-extracted-related` → false positive).
//
// New behavior:
//   - Default is dry-run; explicit --confirm required to delete.
//   - Match uses json_each over the tags column so only exact tag values
//     match.
//   - --keep-quality preserves entries that pass `isQualityContent`.
//
// Usage: node dist/cli/cleanup-extracted.js [--confirm] [--keep-quality]

import { getReadWriteDb } from '../lib/direct-access.js';
import { isQualityContent } from '../tools/extract-learnings.js';
import { deleteMemory } from '../db/repository.js';

const confirm = process.argv.includes('--confirm');
const keepQuality = process.argv.includes('--keep-quality');

const db = getReadWriteDb();

const rows = db
  .prepare<[], { id: string; content: string; title: string | null; tags: string | null }>(
    `SELECT id, content, title, tags
       FROM memories
      WHERE EXISTS (
              SELECT 1 FROM json_each(memories.tags)
               WHERE json_each.value = 'auto-extracted'
            )`,
  )
  .all();

let kept = 0;
let deleted = 0;

for (const row of rows) {
  const shouldKeep = keepQuality && isQualityContent(row.content);
  if (shouldKeep) {
    kept++;
  } else {
    if (confirm) {
      deleteMemory(db, row.id);
    }
    deleted++;
  }
}

const mode = confirm ? '' : '(DRY RUN — pass --confirm to apply) ';
const strategy = keepQuality ? '(keeping quality entries)' : '(removing all auto-extracted)';
console.log(`Cleanup ${mode}${strategy}: ${rows.length} auto-extracted memories found`);
console.log(`  Kept:                  ${kept}`);
console.log(`  ${confirm ? 'Deleted:               ' : 'Would delete:          '}${deleted}`);
