#!/usr/bin/env node
// One-time cleanup: removes low-quality auto-extracted memories from the database.
// Run: node dist/cli/cleanup-extracted.js [--dry-run]

import { getReadWriteDb } from '../lib/direct-access.js';
import { isQualityContent } from '../tools/extract-learnings.js';
import { deleteMemory } from '../db/repository.js';

const dryRun = process.argv.includes('--dry-run');

const db = getReadWriteDb();

const rows = db
  .prepare<[], { id: string; content: string; title: string | null; tags: string | null }>(
    "SELECT id, content, title, tags FROM memories WHERE tags LIKE '%auto-extracted%'",
  )
  .all();

let kept = 0;
let deleted = 0;

for (const row of rows) {
  if (isQualityContent(row.content)) {
    kept++;
  } else {
    if (!dryRun) {
      deleteMemory(db, row.id);
    }
    deleted++;
  }
}

const mode = dryRun ? '(DRY RUN)' : '';
console.log(`Cleanup ${mode}: ${rows.length} auto-extracted memories found`);
console.log(`  Kept:    ${kept} (passed quality check)`);
console.log(`  Deleted: ${deleted} (failed quality check)`);
