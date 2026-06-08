import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { cosineSimFromL2 } from '../search/scoring.js';
import { NOW_ISO_SQL } from '../db/predicates.js';
import { vecRowCount, VEC0_MAX_K } from '../db/repository.js';

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
  // Cross-tenant isolation (battle-v7 H1 / battle-v8 B1): when partitioned, push
  // the (scope, namespace) predicate INTO the vec0 KNN so a flood of foreign-tenant
  // rows can't starve a same-tenant conflict candidate out of the k window. vec0
  // stores a null namespace as ''. k stays 10; non-partitioned callers unchanged.
  // battle-v9 rebattle: adaptive widening. vec0 retains retired/superseded rows
  // (as_of) and chunk children, all of which are SKIPPED in the post-filter below
  // but still consume a fixed-k window — so ~k nearer retired rows in the same
  // partition could starve a LIVE duplicate/contradiction out (the same item-13
  // hazard, on the per-store detectConflicts path). Widen k until a returned row
  // exceeds the conflict distance (sorted → all nearer in-range rows are now in
  // the window) or the partition is exhausted / fully scanned. Common case (no
  // retired crowding) returns on the first pass at k=10 — no extra query.
  const buf = Buffer.from(newEmbedding.buffer);
  const sql = partition
    ? `SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? AND scope = ? AND namespace = ? ORDER BY distance`
    : `SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`;
  const knn = db.prepare<unknown[], { rowid: number; distance: number }>(sql);
  const CONFLICT_DISTANCE = 0.4;
  const GROWTH = 8;
  let k = 10;
  let maxK: number | undefined;
  let candidates: { rowid: number; distance: number }[] = [];
  for (;;) {
    candidates = (
      partition ? knn.all(buf, k, partition.scope, partition.namespace ?? '') : knn.all(buf, k)
    ) as { rowid: number; distance: number }[];
    const reachedBoundary =
      candidates.length > 0 && candidates[candidates.length - 1].distance > CONFLICT_DISTANCE;
    if (reachedBoundary || candidates.length < k) break;
    // Clamp to vec0's hard k-ceiling (rebattle-2 HIGH) — never request k>4096.
    if (maxK === undefined) maxK = Math.min(vecRowCount(db, partition), VEC0_MAX_K);
    if (k >= maxK) break;
    k = Math.min(k * GROWTH, maxK);
  }

  const newWords = extractSignificantWords(newContent);
  const results: ConflictResult[] = [];

  for (const candidate of candidates) {
    if (candidate.distance > 0.4) break;

    const row = db
      .prepare<[number], { id: string; content: string; parent_id: string | null; superseded_at: string | null; valid_to: string | null; tx_expired: string | null }>(
        'SELECT id, content, parent_id, superseded_at, valid_to, tx_expired FROM memories WHERE rowid = ?',
      )
      .get(Number(candidate.rowid));

    if (!row) continue;
    if (row.parent_id !== null) continue;
    if (row.superseded_at !== null) continue;
    // vec rows are retained on bitemporal invalidation (for as_of reconstruction),
    // so a retired/forgotten row can be a candidate here — never conflict against one.
    // (The (scope, namespace) partition is enforced in the vec0 MATCH above.)
    if (row.valid_to !== null || row.tx_expired !== null) continue;
    if (excludeMemoryId && row.id === excludeMemoryId) continue;

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
  // battle-v16 SUPERSEDE-BAND: only RETIRE (stamp superseded_at/valid_to on) the
  // old fact when the write policy actually chose to supersede. On the DEFAULT
  // on_conflict='add' path decideWriteOperation returns ADD (keep both), so a
  // heuristic superseded-band overlap (0.75–0.85) must be RECORDED (audit row)
  // but must NOT silently retire the prior fact. The explicit supersede path
  // retires its chosen target via handleStore's invalidateMemory(deleteTargetId);
  // passing retireSuperseded=true keeps superseded_at stamped on that path.
  retireSuperseded = true,
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
    INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, description, scope, namespace)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // v14: the conflict carries the partition of the NEW (writing) memory so a
  // tenant-scoped conflict read (memory_health/insights) never counts or
  // surfaces a foreign tenant's conflicts. namespace NULL → '' sentinel.
  const np = db
    .prepare<[string], { scope: string; namespace: string | null }>(
      'SELECT scope, namespace FROM memories WHERE id = ?',
    )
    .get(newMemoryId);
  const nScope = np?.scope ?? 'global';
  const nNs = np?.namespace ?? '';

  for (const c of conflicts) {
    if (c.type === 'superseded' && retireSuperseded) {
      supersedeStmt.run(newMemoryId, c.existing_memory_id);
    }
    if (c.type === 'duplicate' || c.type === 'superseded' || c.type === 'contradicted') {
      insertStmt.run(randomUUID(), c.existing_memory_id, newMemoryId, c.type, c.description, nScope, nNs);
    }
  }
}
