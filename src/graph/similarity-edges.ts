import type Database from 'better-sqlite3';
import { findNearDuplicates } from '../db/repository.js';
import { createMemoryLink } from './memory-links.js';

export interface SimilarityEdgeOptions {
  /** Max vector distance to consider a neighbor "similar". */
  maxDistance?: number;
  /** Max number of neighbors to link. */
  limit?: number;
}

/**
 * Automated "unlinked mentions" (Obsidian's killer feature, vectorized).
 * Links `memoryId` to its nearest vector neighbors with an INFERRED
 * `similar_to` edge scored by similarity. The memory's own row (distance 0)
 * is skipped. Exact duplicates never reach here — they are caught and
 * collapsed before insert by conflict detection.
 */
export function buildSimilarityEdges(
  db: Database.Database,
  memoryId: string,
  embedding: Float32Array,
  options: SimilarityEdgeOptions = {},
): void {
  const maxDistance = options.maxDistance ?? 0.5;
  const limit = options.limit ?? 6;

  // +1 because the memory itself is its own nearest neighbor (distance 0).
  const neighbors = findNearDuplicates(db, embedding, maxDistance, limit + 1);

  for (const neighbor of neighbors) {
    if (neighbor.id === memoryId) continue;
    const score = Math.max(0, Math.min(1, 1 - neighbor.distance / 2));
    createMemoryLink(db, {
      sourceId: memoryId,
      targetId: neighbor.id,
      relation: 'similar_to',
      confidence: 'INFERRED',
      confidenceScore: score,
      sourceKind: 'similarity',
    });
  }
}
