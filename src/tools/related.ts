import type Database from 'better-sqlite3';
import type { EmbeddingProvider, SearchResult, MemoryRow } from '../types.js';
import {
  getMemoryById,
  getMemoryRowid,
  rowToMemory,
  recordAccess,
  vecRowCount,
  VEC0_MAX_K,
} from '../db/repository.js';
import { cosineSimFromL2, confidenceLabel, computeGroundedness } from '../search/scoring.js';
import { freshnessWarning } from '../search/hybrid.js';

interface VecMatch {
  rowid: number;
  distance: number;
}

export async function handleRelated(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { id: string; limit: number; min_similarity?: number; access_level_ceiling?: string[] },
): Promise<SearchResult[]> {
  const targetRow = getMemoryById(db, input.id);
  if (!targetRow) {
    return [];
  }
  // RBAC §6 egress ceiling: a principal must not receive a neighbour above its
  // access level. Applied as a Set membership in the post-KNN validity loop
  // (alongside the bitemporal-live gate) so the geometric k-widening still fills
  // `limit` PERMITTED live neighbours. Undefined → no ceiling (legacy/local).
  const ceiling =
    input.access_level_ceiling && input.access_level_ceiling.length > 0
      ? new Set(input.access_level_ceiling)
      : undefined;

  const targetRowid = getMemoryRowid(db, input.id);
  /* c8 ignore next 3 */
  if (targetRowid === null) {
    return [];
  }

  const embedding = await embedder.embed(targetRow.content);
  recordAccess(db, [{ memory_id: input.id, access_type: 'related' }]);

  // Confine the neighbour KNN to the target's own (scope, namespace) via the vec0
  // partition pushdown — without it this read leaked other tenants' and private
  // scope='user' memories across the boundary every sibling read tool enforces
  // (battle-v9 cross-tenant read leak). vec0 stores a null namespace as ''.
  const partition = { scope: targetRow.scope, namespace: targetRow.namespace };
  const knn = db.prepare<[Buffer, number, string, string], VecMatch>(
    'SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? AND scope = ? AND namespace = ? ORDER BY distance',
  );
  const rowStmt = db.prepare<
    [number],
    MemoryRow & { valid_to: string | null; tx_expired: string | null; superseded_at: string | null }
  >('SELECT * FROM memories WHERE rowid = ?');

  const childRowids = new Set<number>();
  const childRows = db
    .prepare<[string], { rowid: number }>('SELECT rowid FROM memories WHERE parent_id = ?')
    .all(input.id);
  for (const child of childRows) {
    childRowids.add(Number(child.rowid));
  }

  const minSimilarity = input.min_similarity ?? 0;

  // battle-v9 rebattle-2: this is a SINGLE-arm vector read with no keyword/PPR
  // fallback, so the fixed-k window (was limit+20) filling with RETIRED/superseded
  // rows (vec0 retains them for as_of) starved live neighbours straight to ZERO.
  // Widen k geometrically until we have `limit` valid LIVE neighbours, the
  // partition is exhausted, or vec0's hard k-ceiling — mirroring findNearDuplicates.
  const buf = Buffer.from(embedding.buffer);
  const GROWTH = 8;
  let k = input.limit + 20;
  let maxK: number | undefined;
  let valid: Array<{ row: MemoryRow & { valid_to: string | null; tx_expired: string | null; superseded_at: string | null }; similarity: number }> = [];
  for (;;) {
    const vecMatches = knn.all(buf, k, partition.scope, partition.namespace ?? '');
    valid = [];
    for (const match of vecMatches) {
      const rowid = Number(match.rowid);
      if (rowid === targetRowid || childRowids.has(rowid)) continue;
      const similarity = cosineSimFromL2(match.distance);
      if (similarity < minSimilarity) continue;
      const row = rowStmt.get(rowid);
      /* c8 ignore next */
      if (!row || row.id === input.id) continue;
      // vec rows are retained on bitemporal invalidation (for as_of); a
      // retired/superseded/forgotten memory is not "related" to current work.
      if (row.valid_to !== null || row.tx_expired !== null || row.superseded_at !== null) continue;
      // RBAC §6: skip a neighbour above the principal's access-level ceiling.
      if (ceiling && !ceiling.has(row.access_level)) continue;
      valid.push({ row, similarity });
      if (valid.length >= input.limit) break;
    }
    if (valid.length >= input.limit || vecMatches.length < k) break;
    if (maxK === undefined) maxK = Math.min(vecRowCount(db, partition), VEC0_MAX_K);
    if (k >= maxK) break;
    k = Math.min(k * GROWTH, maxK);
  }

  const results: SearchResult[] = [];
  for (const { row, similarity } of valid) {
    const confidence = Math.min(similarity, 1);
    // C2: single source of truth for confidence_level cutoffs. Was 0.8/0.5
    // here, which disagreed with memory_search; use the canonical 0.7/0.4
    // confidenceLabel() from scoring.ts so both surfaces label identically.
    const confidenceLevel = confidenceLabel(confidence);

    const ageDays = Math.max(0, Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86_400_000));

    const { groundedness, groundedness_level } = computeGroundedness(
      {
        confidence_score: row.confidence_score,
        provenance: row.provenance,
        created_at: row.created_at,
        updated_at: row.updated_at,
        valid_to: row.valid_to,
        access_count: row.access_count,
      },
      new Date().toISOString(),
    );

    results.push({
      memory: rowToMemory(row),
      score: similarity,
      confidence,
      confidence_level: confidenceLevel,
      groundedness,
      groundedness_level,
      match_type: 'vector',
      age_days: ageDays,
      freshness_warning: freshnessWarning(ageDays),
    });
  }

  return results;
}
