import { getReadWriteDb, getEmbedder } from '../lib/direct-access.js';
import { handleConsolidate } from '../tools/consolidate.js';

export async function runConsolidate(): Promise<void> {
  console.error('Running memory consolidation...');
  const db = getReadWriteDb();
  const embedder = await getEmbedder();
  const report = await handleConsolidate(db, embedder, {
    prune_expired: true,
    prune_low_quality: true,
  });
  console.error(`Consolidation complete:`);
  console.error(`  Scores updated: ${report.scores_updated}`);
  console.error(`  Expired pruned: ${report.expired_pruned}`);
  console.error(`  Low quality pruned: ${report.low_quality_pruned}`);
  console.error(`  Duplicates found: ${report.duplicates_found}`);
  console.error(`  Duplicates merged: ${report.duplicates_merged}`);
  console.error(`  Duration: ${report.duration_ms}ms`);
  if (report.errors.length > 0) {
    console.error(`  Errors: ${report.errors.length}`);
    for (const err of report.errors) console.error(`    - ${err}`);
  }
  if (report.knowledge_gaps.length > 0) {
    console.error(`  Knowledge gaps: ${report.knowledge_gaps.length}`);
    for (const gap of report.knowledge_gaps) console.error(`    - ${gap}`);
  }
}
