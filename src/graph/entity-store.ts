import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ExtractedEntity } from './entity-extractor.js';

// ── Helpers ─────────────────────────────────────────────────────────────

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

// ── Entity CRUD ─────────────────────────────────────────────────────────

export function findOrCreateEntity(
  db: Database.Database,
  name: string,
  type: string,
): string {
  const normalized = normalizeName(name);

  const existing = db
    .prepare<[string], { id: string }>(
      'SELECT id FROM entities WHERE normalized_name = ?',
    )
    .get(normalized);

  if (existing) {
    // LLM-provided types ('person','project','tool','organization') are more specific
    // than regex-inferred types ('concept','file','pattern') — upgrade if applicable.
    const SPECIFIC_TYPES = new Set(['person', 'project', 'tool', 'organization']);
    const GENERIC_TYPES = new Set(['concept', 'file', 'pattern']);
    const currentType = db
      .prepare<[string], { type: string }>('SELECT type FROM entities WHERE id = ?')
      .get(existing.id)?.type;
    const shouldUpgrade = SPECIFIC_TYPES.has(type) && GENERIC_TYPES.has(currentType ?? '');

    if (shouldUpgrade) {
      db.prepare(
        `UPDATE entities
           SET mention_count = mention_count + 1,
               last_seen_at = datetime('now'),
               type = ?
         WHERE id = ?`,
      ).run(type, existing.id);
    } else {
      db.prepare(
        `UPDATE entities
           SET mention_count = mention_count + 1,
               last_seen_at = datetime('now')
         WHERE id = ?`,
      ).run(existing.id);
    }
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO entities (id, name, normalized_name, type)
    VALUES (?, ?, ?, ?)
  `).run(id, name, normalized, type);

  return id;
}

// ── Memory-Entity Linking ───────────────────────────────────────────────

export function linkEntityToMemory(
  db: Database.Database,
  memoryId: string,
  entityId: string,
  role: string,
  extractedBy: string,
  confidence: number,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role, extracted_by, confidence)
    VALUES (?, ?, ?, ?, ?)
  `).run(memoryId, entityId, role, extractedBy, confidence);
}

// ── Orchestrator ────────────────────────────────────────────────────────

export function storeExtractedEntities(
  db: Database.Database,
  memoryId: string,
  entities: ExtractedEntity[],
  extractedBy: string,
): void {
  const store = db.transaction(() => {
    const entityIds: string[] = [];
    for (const entity of entities) {
      const entityId = findOrCreateEntity(db, entity.name, entity.type);
      linkEntityToMemory(db, memoryId, entityId, 'mention', extractedBy, entity.confidence);
      entityIds.push(entityId);
    }
    // Entities mentioned together in one memory co-occur — materialize that as
    // graph edges so the knowledge graph actually has edges (not just nodes).
    buildCooccurrenceEdges(db, entityIds);
  });

  store();
}

// Cap pair-building so a memory mentioning many entities can't explode into an
// O(n^2) edge storm. Entities arrive confidence-sorted, so the cap keeps the
// strongest signals.
const MAX_COOCCURRENCE_ENTITIES = 12;

/**
 * Creates `co_occurs` edges between every unique pair of entities that appeared
 * in the same memory. Pairs are ordered canonically (by id) so (A,B) and (B,A)
 * collapse onto one edge whose `evidence_count` grows each time the pair recurs.
 */
export function buildCooccurrenceEdges(
  db: Database.Database,
  entityIds: string[],
): void {
  const unique = [...new Set(entityIds)].slice(0, MAX_COOCCURRENCE_ENTITIES);
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const [source, target] =
        unique[i] < unique[j] ? [unique[i], unique[j]] : [unique[j], unique[i]];
      findOrCreateRelationship(db, source, target, 'co_occurs');
    }
  }
}

// ── Relationships ───────────────────────────────────────────────────────

export function findOrCreateRelationship(
  db: Database.Database,
  sourceEntityId: string,
  targetEntityId: string,
  type: string,
): string {
  const existing = db
    .prepare<[string, string, string], { id: string }>(
      'SELECT id FROM entity_relationships WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?',
    )
    .get(sourceEntityId, targetEntityId, type);

  if (existing) {
    db.prepare(`
      UPDATE entity_relationships
      SET evidence_count = evidence_count + 1,
          last_seen_at = datetime('now')
      WHERE id = ?
    `).run(existing.id);
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, type)
    VALUES (?, ?, ?, ?)
  `).run(id, sourceEntityId, targetEntityId, type);

  return id;
}
