import type Database from 'better-sqlite3';
import { findNearDuplicates } from '../db/repository.js';
import { cosineSimFromL2 } from '../search/scoring.js';
import { createMemoryLink, type EdgeConfidence } from './memory-links.js';

export interface SimilarityEdgeOptions {
  /** Max vector distance to consider a neighbor "similar". */
  maxDistance?: number;
  /** Max number of neighbors to link. */
  limit?: number;
}

/**
 * Default max L2 vector distance for an automatic similarity edge.
 *
 * vec0 indexes with L2 (Euclidean) distance, so for unit-length embeddings
 * `d = sqrt(2 * (1 - cos))`. Empirically (MiniLM): near-duplicate cos ~0.9 → d
 * ~0.45; genuinely-related cos ~0.7 → d ~0.77; loosely-related cos ~0.5 → d
 * ~1.0; orthogonal cos ~0 → d ~1.41. The previous 0.5 floor only linked cos
 * ≥ ~0.88, so genuinely-related neighbours almost never linked (the live E2E saw
 * ~0 similarity edges). 1.0 captures the cos ≥ 0.5 "related" band while still
 * excluding orthogonal content (d 1.41 ≫ 1.0), so the graph populates without
 * linking everything.
 */
const DEFAULT_MAX_DISTANCE = 1.0;

/**
 * L2-distance boundary between a *confident* similar edge (INFERRED) and an
 * *uncertain* one (AMBIGUOUS). At/below this (cos ≳ 0.68) the similarity is
 * strong enough to assert as INFERRED; above it but within {@link
 * DEFAULT_MAX_DISTANCE} (cos ~0.5–0.68) the edge is real but uncertain, so it is
 * tagged AMBIGUOUS — the signal memory_questions' 'verify' digest surfaces for an
 * agent to confirm (previously AMBIGUOUS was never produced, making 'verify'
 * dead code; G3-F8).
 */
const AMBIGUOUS_DISTANCE_FLOOR = 0.8;

/** Default number of neighbours linked per build. */
const DEFAULT_LIMIT = 6;

/**
 * Automated "unlinked mentions" (Obsidian's killer feature, vectorized).
 * Links `memoryId` to its nearest vector neighbours with a `similar_to` edge
 * whose confidence reflects how sure the similarity is: INFERRED for a confident
 * match, AMBIGUOUS for a mid-band one (see {@link AMBIGUOUS_DISTANCE_FLOOR}). The
 * memory's own row (distance 0) is skipped. Exact duplicates never reach here —
 * they are caught and collapsed before insert by conflict detection.
 */
export function buildSimilarityEdges(
  db: Database.Database,
  memoryId: string,
  embedding: Float32Array,
  options: SimilarityEdgeOptions = {},
): void {
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const limit = options.limit ?? DEFAULT_LIMIT;

  // +1 because the memory itself is its own nearest neighbor (distance 0).
  const neighbors = findNearDuplicates(db, embedding, maxDistance, limit + 1);

  for (const neighbor of neighbors) {
    if (neighbor.id === memoryId) continue;
    const score = cosineSimFromL2(neighbor.distance);
    const confidence: EdgeConfidence =
      neighbor.distance <= AMBIGUOUS_DISTANCE_FLOOR ? 'INFERRED' : 'AMBIGUOUS';
    createMemoryLink(db, {
      sourceId: memoryId,
      targetId: neighbor.id,
      relation: 'similar_to',
      confidence,
      confidenceScore: score,
      sourceKind: 'similarity',
    });
  }
}
