import type Database from 'better-sqlite3';
import { normalizeName } from '../graph/entity-store.js';

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

export function handleGraph(db: Database.Database, input: GraphInput): GraphResult {
  const limit = input.limit ?? 20;
  const depth = input.depth ?? 1;
  const includeMemories = input.include_memories ?? true;

  let entityRows: Array<{ id: string; name: string; type: string; mention_count: number }>;

  if (input.entity) {
    const normalizedInput = normalizeName(input.entity);
    // Resolve through entity_aliases when the input isn't itself an entity name:
    // a registered alias maps to its entity's canonical normalized_name. A direct
    // entity-name match takes precedence — an alias never shadows a real entity.
    let normalized = normalizedInput;
    const directExists = db
      .prepare<[string], { x: number }>('SELECT 1 AS x FROM entities WHERE normalized_name = ? LIMIT 1')
      .get(normalizedInput);
    if (!directExists) {
      const aliasRow = db
        .prepare<[string], { normalized_name: string }>(
          `SELECT e.normalized_name FROM entity_aliases a
           JOIN entities e ON e.id = a.entity_id
           WHERE a.normalized_alias = ? LIMIT 1`,
        )
        .get(normalizedInput);
      if (aliasRow) normalized = aliasRow.normalized_name;
    }

    if (depth === 1) {
      // Direct neighbors only
      entityRows = db.prepare(`
        SELECT DISTINCT e.id, e.name, e.type, e.mention_count
        FROM entities e
        WHERE e.normalized_name = ?
        UNION
        SELECT DISTINCT e2.id, e2.name, e2.type, e2.mention_count
        FROM entities e1
        JOIN entity_relationships er ON er.source_entity_id = e1.id OR er.target_entity_id = e1.id
        JOIN entities e2 ON e2.id = CASE
          WHEN er.source_entity_id = e1.id THEN er.target_entity_id
          ELSE er.source_entity_id
        END
        WHERE e1.normalized_name = ?
        LIMIT ?
      `).all(normalized, normalized, limit) as typeof entityRows;
    } else {
      // Multi-hop via recursive CTE
      entityRows = db.prepare(`
        WITH RECURSIVE entity_graph(entity_id, depth, path) AS (
          SELECT id, 0, id FROM entities WHERE normalized_name = ?
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
        JOIN entities e ON e.id = eg.entity_id
        ORDER BY e.mention_count DESC
        LIMIT ?
      `).all(normalized, depth, limit) as typeof entityRows;
    }
  } else {
    // Browse all entities
    let query = 'SELECT id, name, type, mention_count FROM entities';
    const params: unknown[] = [];
    if (input.entity_type) {
      query += ' WHERE type = ?';
      params.push(input.entity_type);
    }
    query += ' ORDER BY mention_count DESC LIMIT ?';
    params.push(limit);
    entityRows = db.prepare(query).all(...params) as typeof entityRows;
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

  // Get linked memories
  let memories: Array<{ id: string; title: string | null; namespace: string | null }> = [];
  if (includeMemories && entityIds.length > 0) {
    memories = db.prepare(`
      SELECT DISTINCT m.id, m.title, m.namespace
      FROM memory_entities me
      JOIN memories m ON m.id = me.memory_id
      WHERE me.entity_id IN (${idPlaceholders})
        AND m.parent_id IS NULL
        AND m.superseded_at IS NULL
      ORDER BY m.importance_score DESC
      LIMIT 50
    `).all(...entityIds) as typeof memories;
  }

  return {
    entities,
    memories,
    total_entities: entities.length,
    total_relationships: rels.length,
  };
}
