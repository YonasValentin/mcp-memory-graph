import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { cosineSimFromL2 } from '../search/scoring.js';
import { NOW_ISO_SQL } from '../db/predicates.js';

export type ConflictType = 'superseded' | 'contradicted' | 'duplicate';

export interface ConflictResult {
  type: ConflictType | 'refined' | 'none';
  existing_memory_id: string;
  overlap_score: number;
  description: string;
}

/**
 * The tenant partition a conflict/dedup scan is confined to. When supplied, a
 * candidate whose (scope, namespace) differs is never treated as a
 * conflict/duplicate/contradiction — so a write into one project's namespace can
 * never silently retire or dedup against another project's fact on a shared DB
 * (battle-v7 H1/H2, cross-tenant data loss). Namespaces are compared with
 * null-normalization (an absent namespace is a partition of its own).
 */
export interface MemoryPartition {
  scope: string;
  namespace: string | null;
}

/** True when `row` lives outside `partition` (so it must be skipped). */
function outsidePartition(
  row: { scope: string; namespace: string | null },
  partition?: MemoryPartition,
): boolean {
  if (!partition) return false;
  return row.scope !== partition.scope || (row.namespace ?? null) !== (partition.namespace ?? null);
}

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'have', 'been', 'will', 'would',
  'could', 'should', 'their', 'there', 'about', 'which', 'when', 'what',
  'were', 'they', 'them', 'then', 'than', 'into', 'each', 'make', 'like',
  'just', 'over', 'such', 'also', 'more', 'some', 'only', 'very', 'after',
  'before', 'other',
]);

export function extractSignificantWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    if (word.length >= 4 && !STOP_WORDS.has(word)) {
      result.add(word);
    }
  }
  return result;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Read-only conflict detection. Scans the vec index for near-matches and
 * classifies each as duplicate / superseded / contradicted by overlap score.
 * Does NOT write to memory_conflicts and does NOT mutate any row — that
 * happens in {@link recordConflicts} after the new memory has been inserted
 * (so the FK target exists).
 */
export function detectConflicts(
  db: Database.Database,
  newEmbedding: Float32Array,
  newContent: string,
  excludeMemoryId?: string,
  partition?: MemoryPartition,
): ConflictResult[] {
  // Oversample when partitioned: cross-tenant rows occupy the nearest-neighbor
  // slots and are then filtered out, so widen k to keep enough same-partition
  // candidates (mirrors hybridSearch's post-filter-after-oversample pattern).
  const k = partition ? 64 : 10;
  const candidates = db
    .prepare<[Buffer, number], { rowid: number; distance: number }>(
      `SELECT rowid, distance FROM memories_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(Buffer.from(newEmbedding.buffer), k);

  const newWords = extractSignificantWords(newContent);
  const results: ConflictResult[] = [];

  for (const candidate of candidates) {
    if (candidate.distance > 0.4) break;

    const row = db
      .prepare<[number], { id: string; content: string; parent_id: string | null; superseded_at: string | null; valid_to: string | null; tx_expired: string | null; scope: string; namespace: string | null }>(
        'SELECT id, content, parent_id, superseded_at, valid_to, tx_expired, scope, namespace FROM memories WHERE rowid = ?',
      )
      .get(Number(candidate.rowid));

    if (!row) continue;
    if (row.parent_id !== null) continue;
    if (row.superseded_at !== null) continue;
    // vec rows are retained on bitemporal invalidation (for as_of reconstruction),
    // so a retired/forgotten row can be a candidate here — never conflict against one.
    if (row.valid_to !== null || row.tx_expired !== null) continue;
    if (excludeMemoryId && row.id === excludeMemoryId) continue;
    // Cross-tenant isolation: a candidate in a different (scope, namespace) is
    // never a conflict candidate for this write (battle-v7 H1).
    if (outsidePartition(row, partition)) continue;

    const vectorSim = cosineSimFromL2(candidate.distance);
    const existingWords = extractSignificantWords(row.content);
    const keywordOverlap = jaccardSimilarity(newWords, existingWords);
    const overlapScore = 0.5 * vectorSim + 0.5 * keywordOverlap;

    // Band thresholds. All branches are exercised directly by
    // src/__tests__/graph/conflict-resolver.test.ts, which pins the vector
    // (vectorSim ≈ 1) and drives each band via the jaccard keyword overlap.
    if (overlapScore > 0.85) {
      results.push({
        type: 'duplicate',
        existing_memory_id: row.id,
        overlap_score: overlapScore,
        description: `Duplicate detected (overlap: ${overlapScore.toFixed(3)})`,
      });
    } else if (overlapScore > 0.75) {
      results.push({
        type: 'superseded',
        existing_memory_id: row.id,
        overlap_score: overlapScore,
        description: `Superseded by newer memory (overlap: ${overlapScore.toFixed(3)})`,
      });
    } else if (overlapScore > 0.65) {
      results.push({
        type: 'contradicted',
        existing_memory_id: row.id,
        overlap_score: overlapScore,
        description: `Potential contradiction (overlap: ${overlapScore.toFixed(3)})`,
      });
    }
  }

  return results;
}

/**
 * Persist conflict rows for an already-inserted memory. Insert order:
 *   1. mark superseded rows in `memories.superseded_at`
 *   2. write the matching rows in `memory_conflicts` (FK requires the new memory to exist)
 *
 * Caller is responsible for wrapping this in a transaction with the matching
 * `insertMemory(...)` so partial failures don't leak.
 */
export function recordConflicts(
  db: Database.Database,
  conflicts: ConflictResult[],
  newMemoryId: string,
): void {
  if (conflicts.length === 0) return;

  // Stamp the legacy flag AND invalidate point-in-time: the superseded fact
  // stops being true the moment the superseding fact became true (the new
  // memory's valid_from). COALESCE keeps any earlier valid_to already set.
  const supersedeStmt = db.prepare(
    `UPDATE memories SET superseded_at = ${NOW_ISO_SQL},
       valid_to = COALESCE(valid_to, (SELECT valid_from FROM memories WHERE id = ?))
     WHERE id = ?`,
  );
  const insertStmt = db.prepare(`
    INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const c of conflicts) {
    if (c.type === 'superseded') {
      supersedeStmt.run(newMemoryId, c.existing_memory_id);
    }
    if (c.type === 'duplicate' || c.type === 'superseded' || c.type === 'contradicted') {
      insertStmt.run(randomUUID(), c.existing_memory_id, newMemoryId, c.type, c.description);
    }
  }
}
