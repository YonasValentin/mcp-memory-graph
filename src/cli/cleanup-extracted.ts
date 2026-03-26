#!/usr/bin/env node
// Cleanup: removes auto-extracted memories from the database.
// By default removes ALL auto-extracted entries (they are noise).
// Run: node dist/cli/cleanup-extracted.js [--dry-run] [--keep-quality]

import { getReadWriteDb } from '../lib/direct-access.js';
import { isQualityContent } from '../tools/extract-learnings.js';
import { deleteMemory } from '../db/repository.js';

const dryRun = process.argv.includes('--dry-run');
const keepQuality = process.argv.includes('--keep-quality');

const db = getReadWriteDb();

const rows = db
  .prepare<[], { id: string; content: string; title: string | null; tags: string | null }>(
    "SELECT id, content, title, tags FROM memories WHERE tags LIKE '%auto-extracted%'",
  )
  .all();

let kept = 0;
let deleted = 0;

for (const row of rows) {
  const shouldKeep = keepQuality && isQualityContent(row.content);
  if (shouldKeep) {
    kept++;
  } else {
    if (!dryRun) {
      deleteMemory(db, row.id);
    }
    deleted++;
  }
}

const mode = dryRun ? '(DRY RUN) ' : '';
const strategy = keepQuality ? '(keeping quality entries)' : '(removing all auto-extracted)';
console.log(`Cleanup ${mode}${strategy}: ${rows.length} auto-extracted memories found`);
console.log(`  Kept:    ${kept}`);
console.log(`  Deleted: ${deleted}`);
