import type Database from 'better-sqlite3';
import { normalizeName, resolveToCanonicalName } from '../graph/entity-store.js';
import { liveConditions } from '../db/predicates.js';

interface GraphInput {
  entity?: string;
  entity_type?: string;
  depth?: number;
  include_memories?: boolean;
  limit?: number;
}

interface EntityNode {
  id: string;
  name: string;
  type: string;
  mention_count: number;
  depth: number;
  relationships: Array<{
    target_entity: string;
    type: string;
    /** Saturating function of evidence_count (see {@link strengthFromEvidence}). */
    strength: number;
    /** How many memories witnessed this entity pair — the real co-occurrence signal. */
    evidence_count: number;
    /** The IDF-weighted edge strength PageRank ranks on (entity_relationships.strength, R2). */
    idf_strength: number;
  }>;
}

/**
 * Derives a graph-view relationship strength in (0,1) from its evidence_count
 * (G3-F10). A saturating 1 - 1/(1 + evidence_count) maps evidence 1 -> 0.5,
 * 2 -> 0.667, 5 -> 0.833, asymptoting to 1, so a pair witnessed by many memories
 * reads stronger than one seen once.
 *
 * Note: `findOrCreateRelationship` now also persists a meaningful IDF-weighted
 * `strength` column (R2 item 1) used by PageRank, but the graph view keeps this
 * pure evidence-count read so a pair's displayed strength is stable regardless
 * of how common its endpoints have since become.
 */
function strengthFromEvidence(evidenceCount: number): number {
  const n = Math.max(1, evidenceCount);
  return 1 - 1 / (1 + n);
}

interface GraphResult {
  entities: EntityNode[];
  memories: Array<{ id: string; title: string | null; namespace: string | null }>;
  total_entities: number;
  total_relationships: number;
}

export function handleGraph(
  db: Database.Database,
  input: GraphInput,
  forcedNamespace?: string,
): GraphResult {
  const limit = input.limit ?? 20;
  const depth = input.depth ?? 1;
  const includeMemories = input.include_memories ?? true;

  let entityRows: Array<{ id: string; name: string; type: string; mention_count: number }>;

  // battle-v14 #1: fixed-k starvation. Every entity-selection path orders by the
  // GLOBAL `mention_count` and applies `LIMIT`, then the namespace post-filter
  // below drops foreign rows in JS. When another tenant owns the top-k entities,
  // the whole `LIMIT` window is foreign and gets dropped → a forced tenant sees
  // an EMPTY graph of its OWN entities. Push `namespace = ?` INTO the selection
  // (v14 stamps entities.namespace per the namespace-only identity model) so the
  // top-k window is drawn from the tenant's own entities before the LIMIT. Unset
  // (single-user) → no predicate, whole graph as before.
  const nsFilter = forcedNamespace !== undefined;

  if (input.entity) {
    // Resolve through entity_aliases (shared resolver): a registered alias maps
    // to its entity's canonical normalized_name; a direct entity-name match
    // takes precedence — an alias never shadows a real entity.
    // battle-v16 ALIAS-NS: scope alias/entity resolution to the forced tenant so
    // a colliding alias can't resolve to a FOREIGN tenant's canonical name (which
    // the nsFilter selection below would then drop → empty graph for the owner).
    const normalized = resolveToCanonicalName(db, normalizeName(input.entity), forcedNamespace);

    if (depth === 1) {
      // Direct neighbors only. Under forcing, confine BOTH the anchor and the
      // expanded neighbor (e2) to the tenant's namespace so the fixed LIMIT
      // can't be consumed by a foreign tenant's same-named entity + neighbors.
      const anchorNs = nsFilter ? ' AND e.namespace = ?' : '';
      const neighborNs = nsFilter ? ' AND e1.namespace = ? AND e2.namespace = ?' : '';
      const params = nsFilter
        ? [normalized, forcedNamespace, normalized, forcedNamespace, forcedNamespace, limit]
        : [normalized, normalized, limit];
      entityRows = db.prepare(`
        SELECT DISTINCT e.id, e.name, e.type, e.mention_count
        FROM entities e
        WHERE e.normalized_name = ?${anchorNs}
        UNION
        SELECT DISTINCT e2.id, e2.name, e2.type, e2.mention_count
        FROM entities e1
        JOIN entity_relationships er ON er.source_entity_id = e1.id OR er.target_entity_id = e1.id
        JOIN entities e2 ON e2.id = CASE
          WHEN er.source_entity_id = e1.id THEN er.target_entity_id
          ELSE er.source_entity_id
        END
        WHERE e1.normalized_name = ?${neighborNs}
        LIMIT ?
      `).all(...params) as typeof entityRows;
    } else {
      // Multi-hop via recursive CTE. Anchor the traversal to in-tenant entities
      // and filter the final projected set to the tenant's namespace before the
      // ORDER BY mention_count / LIMIT, so foreign entities reached through
      // (un-namespaced) edge hops can't crowd out the tenant's own rows.
      const baseNs = nsFilter ? ' AND namespace = ?' : '';
      const finalNs = nsFilter ? ' WHERE e.namespace = ?' : '';
      const params = nsFilter
        ? [normalized, forcedNamespace, depth, forcedNamespace, limit]
        : [normalized, depth, limit];
      entityRows = db.prepare(`
        WITH RECURSIVE entity_graph(entity_id, depth, path) AS (
          SELECT id, 0, id FROM entities WHERE normalized_name = ?${baseNs}
          UNION ALL
          SELECT
            CASE WHEN er.source_entity_id = eg.entity_id
              THEN er.target_entity_id ELSE er.source_entity_id END,
            eg.depth + 1,
            eg.path || ',' || CASE WHEN er.source_entity_id = eg.entity_id
              THEN er.target_entity_id ELSE er.source_entity_id END
          FROM entity_graph eg
          JOIN entity_relationships er
            ON er.source_entity_id = eg.entity_id OR er.target_entity_id = eg.entity_id
          WHERE eg.depth < ?
            AND eg.path NOT LIKE '%' || CASE WHEN er.source_entity_id = eg.entity_id
              THEN er.target_entity_id ELSE er.source_entity_id END || '%'
        )
        SELECT DISTINCT e.id, e.name, e.type, e.mention_count
        FROM entity_graph eg
        JOIN entities e ON e.id = eg.entity_id${finalNs}
        ORDER BY e.mention_count DESC
        LIMIT ?
      `).all(...params) as typeof entityRows;
    }
  } else {
    // Browse all entities
    let query = 'SELECT id, name, type, mention_count FROM entities';
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.entity_type) {
      where.push('type = ?');
      params.push(input.entity_type);
    }
    // Confine the top-k browse window to the tenant's own entities (see above).
    if (nsFilter) {
      where.push('namespace = ?');
      params.push(forcedNamespace);
    }
    if (where.length > 0) query += ' WHERE ' + where.join(' AND ');
    query += ' ORDER BY mention_count DESC LIMIT ?';
    params.push(limit);
    entityRows = db.prepare(query).all(...params) as typeof entityRows;
  }

  // battle-v9 CLASS 2: entities are SHARED (no namespace column), so a foreign
  // tenant's entity name would otherwise surface on a namespace-forced
  // deployment. Restrict the visible entity set to those witnessed by a LIVE
  // memory in the forced namespace (an entity with no in-tenant memory is
  // dropped). The memory join below additionally filters m.namespace so a shared
  // entity cannot bridge to a foreign memory.
  // battle-v9 rebattle-4 (MED side-channel): when forced, also override each
  // entity's mention_count with the TENANT-LOCAL count. The global
  // entities.mention_count discloses a foreign tenant's activity volume (e.g. an
  // entity the tenant touched once but another tenant touched 50×). Compute a
  // per-entity COUNT(DISTINCT memory) over the forced tenant's own live memories.
  const scopedMentions = new Map<string, number>();
  if (forcedNamespace) {
    const live = liveConditions({ excludeSuperseded: true, topLevelOnly: true })
      .map((c) => `m.${c}`)
      .join(' AND ');
    // battle-v14 F3: also require the ENTITY's own namespace to match. A
    // migrated/residual (global,'') entity cross-linked to an in-tenant memory
    // would otherwise pass the memory-join filter and leak its NAME. v14 entity
    // identity is per-namespace (fresh writes + the migration split), so a
    // legitimately in-tenant entity carries en.namespace = forcedNamespace.
    for (const r of db
      .prepare<[string, string], { id: string; n: number }>(
        `SELECT me.entity_id AS id, COUNT(DISTINCT me.memory_id) AS n
           FROM memory_entities me
           JOIN memories m ON m.id = me.memory_id
           JOIN entities en ON en.id = me.entity_id
          WHERE m.namespace = ? AND en.namespace = ? AND ${live}
          GROUP BY me.entity_id`,
      )
      .all(forcedNamespace, forcedNamespace)) {
      scopedMentions.set(r.id, r.n);
    }
    // Drop entities with no in-tenant witness, then override the count + re-rank
    // by the tenant-local count (the global ORDER BY/LIMIT above is now stale).
    entityRows = entityRows
      .filter((e) => scopedMentions.has(e.id))
      .map((e) => ({ ...e, mention_count: scopedMentions.get(e.id) ?? 0 }))
      .sort((a, b) => b.mention_count - a.mention_count);
  }

  if (entityRows.length === 0) {
    return { entities: [], memories: [], total_entities: 0, total_relationships: 0 };
  }

  const entityIds = entityRows.map(e => e.id);
  const idPlaceholders = entityIds.map(() => '?').join(',');

  // Get relationships between visible entities. We surface evidence_count (the
  // raw co-occurrence signal), a stable evidence-derived display `strength`, and
  // the real IDF-weighted `strength` column (written by findOrCreateRelationship
  // per R2 — the value PageRank ranks on) exposed separately as `idf_strength`.
  const rels = db.prepare(`
    SELECT source_entity_id, target_entity_id, type, evidence_count, strength
    FROM entity_relationships
    WHERE source_entity_id IN (${idPlaceholders}) AND target_entity_id IN (${idPlaceholders})
  `).all(...entityIds, ...entityIds) as Array<{
    source_entity_id: string; target_entity_id: string; type: string; evidence_count: number; strength: number;
  }>;

  const entityIdToName = new Map(entityRows.map(e => [e.id, e.name]));

  const entities: EntityNode[] = entityRows.map(e => ({
    id: e.id,
    name: e.name,
    type: e.type,
    mention_count: e.mention_count,
    depth: 0,
    relationships: rels
      .filter(r => r.source_entity_id === e.id || r.target_entity_id === e.id)
      .map(r => ({
        target_entity: entityIdToName.get(
          r.source_entity_id === e.id ? r.target_entity_id : r.source_entity_id,
        ) ?? 'unknown',
        type: r.type,
        strength: strengthFromEvidence(r.evidence_count),
        evidence_count: r.evidence_count,
        idf_strength: r.strength,
      })),
  }));

  // Get linked memories — only LIVE, top-level, non-superseded rows. vec/graph
  // rows are retained on bitemporal invalidation (for as_of reconstruction), so
  // without the valid_to/tx_expired predicate a retired/forgotten/NLI-superseded
  // fact would leak back into a live traversal (battle-v7 H4). Build the WHERE
  // from the single-source liveConditions() predicate (prefixed for the m alias).
  let memories: Array<{ id: string; title: string | null; namespace: string | null }> = [];
  if (includeMemories && entityIds.length > 0) {
    const live = liveConditions({ excludeSuperseded: true, topLevelOnly: true })
      .map((c) => `m.${c}`)
      .join(' AND ');
    // battle-v9 CLASS 2: a shared entity can link memories of other tenants, so
    // the join itself must filter on the forced namespace (not just the entity
    // set) or a foreign memory's id/title/namespace would leak.
    const nsClause = forcedNamespace ? ' AND m.namespace = ?' : '';
    const params = forcedNamespace ? [...entityIds, forcedNamespace] : [...entityIds];
    memories = db.prepare(`
      SELECT DISTINCT m.id, m.title, m.namespace
      FROM memory_entities me
      JOIN memories m ON m.id = me.memory_id
      WHERE me.entity_id IN (${idPlaceholders})
        AND ${live}${nsClause}
      ORDER BY m.importance_score DESC
      LIMIT 50
    `).all(...params) as typeof memories;
  }

  return {
    entities,
    memories,
    total_entities: entities.length,
    total_relationships: rels.length,
  };
}
