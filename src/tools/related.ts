import type Database from 'better-sqlite3';
import type { EmbeddingProvider, SearchResult, MemoryRow } from '../types.js';
import { getMemoryById, getMemoryRowid, rowToMemory, recordAccess } from '../db/repository.js';
import { cosineSimFromL2, confidenceLabel, computeGroundedness } from '../search/scoring.js';

interface VecMatch {
  rowid: number;
  distance: number;
}

export async function handleRelated(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: { id: string; limit: number; min_similarity?: number },
): Promise<SearchResult[]> {
  const targetRow = getMemoryById(db, input.id);
  if (!targetRow) {
    return [];
  }

  const targetRowid = getMemoryRowid(db, input.id);
  /* c8 ignore next 3 */
  if (targetRowid === null) {
    return [];
  }

  const embedding = await embedder.embed(targetRow.content);
  recordAccess(db, [{ memory_id: input.id, access_type: 'related' }]);

  const fetchLimit = input.limit + 20;
  const vecMatches = db
    .prepare<[Buffer, number], VecMatch>(
      'SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance',
    )
    .all(Buffer.from(embedding.buffer), fetchLimit);

  const childRowids = new Set<number>();
  const childRows = db
    .prepare<[string], { rowid: number }>('SELECT rowid FROM memories WHERE parent_id = ?')
    .all(input.id);
  for (const child of childRows) {
    childRowids.add(Number(child.rowid));
  }

  const minSimilarity = input.min_similarity ?? 0;
  const results: SearchResult[] = [];

  for (const match of vecMatches) {
    if (results.length >= input.limit) break;

    const rowid = Number(match.rowid);
    if (rowid === targetRowid || childRowids.has(rowid)) continue;

    const similarity = cosineSimFromL2(match.distance);
    if (similarity < minSimilarity) continue;

    const row = db
      .prepare<[number], MemoryRow & { valid_to: string | null; tx_expired: string | null; superseded_at: string | null }>(
        'SELECT * FROM memories WHERE rowid = ?',
      )
      .get(rowid);

    /* c8 ignore next */
    if (!row) continue;
    if (row.id === input.id) continue;
    // vec rows are retained on bitemporal invalidation (for as_of reconstruction);
    // a retired/superseded/forgotten memory is not "related" to current work.
    if (row.valid_to !== null || row.tx_expired !== null || row.superseded_at !== null) continue;

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
      freshness_warning: ageDays > 90
        ? `This memory is ${ageDays} days old. Verify against current state before asserting as fact.`
        /* c8 ignore next 2 */
        : ageDays > 30
          ? `This memory is ${ageDays} days old. Information may be outdated.`
          : null,
    });
  }

  return results;
}
