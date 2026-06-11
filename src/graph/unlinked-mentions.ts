import type Database from 'better-sqlite3';
import type { EmbeddingProvider, Memory } from '../types.js';
import { getMemoryById, findNearDuplicates, rowToMemory, vecRowCount, VEC0_MAX_K } from '../db/repository.js';
import { contextualizeForEmbedding } from '../search/contextual.js';
import { cosineSimFromL2, l2FromCosineSim } from '../search/scoring.js';

export interface UnlinkedMention {
  memory: Memory;
  /** Cosine similarity to the target memory (unit-vector exact). */
  similarity: number;
  /** Names of entities both memories mention — an extra "relatedness" signal. */
  shared_entities: string[];
}

/** Edge kinds that count as an EXPLICIT link (a 'similar_to' suggestion does not). */
const EXPLICIT_KINDS = "('wikilink','co_occurrence','typed')";

/**
 * Automated unlinked-mentions (P2.1): memories semantically near `memoryId` that
 * the agent has NOT explicitly linked. This is Obsidian's unlinked-mentions made
 * automatic — vector neighbours + entity overlap instead of literal string
 * matches — and strictly more powerful, because the connection is proposed
 * without anyone typing a `[[link]]`.
 *
 * A candidate is surfaced when it is a top-level vector neighbour above
 * `minSimilarity` AND there is no explicit (wikilink / co_occurrence / typed)
 * edge between it and the target in either direction. The system's own auto
 * `similar_to` edges are deliberately ignored — they ARE the latent signal we
 * surface, not a user link. Self and the target's own chunks are excluded.
 */
export async function findUnlinkedMentions(
  db: Database.Database,
  embedder: EmbeddingProvider,
  memoryId: string,
  opts: { limit: number; minSimilarity: number; accessCeiling?: readonly string[] },
): Promise<UnlinkedMention[]> {
  const target = getMemoryById(db, memoryId);
  if (!target) return [];

  // RBAC §6 (RB-8): the neighbour scan partitions on (scope, namespace) only —
  // never access_level — so a same-namespace row ABOVE the principal's ceiling is
  // in-partition and vector-near, and its title + content snippet would be echoed.
  // Mirror related.ts: drop any neighbour above the ceiling. Undefined → no ceiling
  // (legacy/local).
  const ceiling =
    opts.accessCeiling && opts.accessCeiling.length > 0 ? new Set(opts.accessCeiling) : undefined;

  const embedding = await embedder.embed(
    contextualizeForEmbedding(target.content, {
      title: target.title,
      document_type: target.document_type,
      namespace: target.namespace,
    }),
  );

  // Translate the cosine floor into an L2 distance cutoff and oversample so the
  // post-filters (self / chunks / explicitly-linked) don't starve the top-N.
  const maxDistance = l2FromCosineSim(opts.minSimilarity);
  // Confine the neighbour scan to the target's own (scope, namespace) — without
  // this the global vec0 KNN leaked (and surfaced snippets of) other tenants' /
  // other scopes' private memories (battle-v9 cross-tenant read leak).
  const partition = { scope: target.scope, namespace: target.namespace };
  // battle-v9 rebattle-3: findNearDuplicates widens past valid_to/tx_expired-
  // retired rows, but unlinked-mentions ALSO drops superseded + chunk rows in its
  // post-filter below — which findNearDuplicates does NOT widen for. So a flood of
  // nearer SUPERSEDED rows (set on every NLI supersession) starved live mentions
  // to zero. Widen the requested limit geometrically (findNearDuplicates clamps
  // each call to vec0's hard k internally) until `out` fills or the partition is
  // exhausted. partCount caps the growth so we don't request past the partition.

  // Ids already connected to the target by an explicit (non-similarity) edge.
  const explicitlyLinked = new Set(
    db
      .prepare<[string, string, string], { other: string }>(
        `SELECT CASE WHEN source_memory_id = ? THEN target_memory_id ELSE source_memory_id END AS other
           FROM memory_links
          WHERE (source_memory_id = ? OR target_memory_id = ?)
            AND source_kind IN ${EXPLICIT_KINDS}`,
      )
      .all(memoryId, memoryId, memoryId)
      .map((r) => r.other),
  );

  const sharedEntitiesStmt = db.prepare<[string, string], { name: string }>(
    `SELECT DISTINCT e.name AS name
       FROM memory_entities m1
       JOIN memory_entities m2 ON m1.entity_id = m2.entity_id
       JOIN entities e ON e.id = m1.entity_id
      WHERE m1.memory_id = ? AND m2.memory_id = ?`,
  );

  const rowStmt = db.prepare<
    [number],
    import('../types.js').MemoryRow & { parent_id: string | null; superseded_at: string | null }
  >('SELECT * FROM memories WHERE rowid = ?');

  const partCount = vecRowCount(db, partition);
  const out: UnlinkedMention[] = [];
  let fetch = opts.limit + 25;
  for (;;) {
    const neighbors = findNearDuplicates(db, embedding, maxDistance, fetch, partition);
    out.length = 0;
    for (const n of neighbors) {
      if (n.id === memoryId || explicitlyLinked.has(n.id)) continue;

      const row = rowStmt.get(n.rowid);
      // Top-level, non-superseded memories only — never surface a chunk of a
      // document, nor a superseded fact (battle-v9 CLASS 4: findNearDuplicates
      // filters valid_to/tx_expired but NOT superseded_at, so a superseded row
      // could otherwise leak onto the unlinked-mentions surface — matches
      // related.ts which already rejects superseded_at).
      if (!row || row.parent_id !== null || row.superseded_at !== null) continue;
      // RBAC §6: never echo a neighbour above the principal's access ceiling.
      if (ceiling && !ceiling.has(row.access_level)) continue;

      const similarity = cosineSimFromL2(n.distance);
      if (similarity < opts.minSimilarity) continue;

      const shared = sharedEntitiesStmt.all(memoryId, row.id).map((r) => r.name);
      out.push({ memory: rowToMemory(row), similarity, shared_entities: shared });
      if (out.length >= opts.limit) break;
    }
    // Enough collected, the partition is exhausted, or we've hit vec0's ceiling —
    // stop. Otherwise widen and retry past the superseded/chunk rows that the
    // post-filter dropped.
    if (out.length >= opts.limit || neighbors.length < fetch || fetch >= Math.min(partCount, VEC0_MAX_K)) {
      break;
    }
    fetch = Math.min(fetch * 8, Math.min(partCount, VEC0_MAX_K));
  }

  // findNearDuplicates already returns ascending distance (descending cosine),
  // so `out` is descending-similarity; keep that contract explicit.
  return out;
}
