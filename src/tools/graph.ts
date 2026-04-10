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
  relationships: Array<{ target_entity: string; type: string; strength: number }>;
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
    const normalized = normalizeName(input.entity);

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

  // Get relationships between visible entities
  const rels = db.prepare(`
    SELECT source_entity_id, target_entity_id, type, strength
    FROM entity_relationships
    WHERE source_entity_id IN (${idPlaceholders}) AND target_entity_id IN (${idPlaceholders})
  `).all(...entityIds, ...entityIds) as Array<{
    source_entity_id: string; target_entity_id: string; type: string; strength: number;
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
        strength: r.strength,
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
