import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ExtractedEntity } from './entity-extractor.js';
import { createMemoryLink } from './memory-links.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Lowercases and strips to [a-z0-9-]. When the strip leaves nothing (a
 * symbol-only name like '++' or '#'), it falls back to a deterministic hash of
 * the original so distinct symbol-only entities get distinct, non-empty keys
 * instead of all colliding onto normalized_name='' (G3-F6). Names that retain
 * alphanumerics keep the plain strip so downstream search/extraction
 * normalization stays stable.
 */
export function normalizeName(name: string): string {
  const stripped = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (stripped.length > 0) return stripped;
  return `sym-${djb2(name.toLowerCase())}`;
}

/** Deterministic 32-bit djb2 hash → unsigned base-36 string. */
function djb2(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
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
    // Bridge co-occurrence into the memory<->memory graph too (G3-F7): memories
    // sharing an entity get a memory_links 'co_occurs' edge, so /api/graph and
    // memory_get.links reflect co-occurrence (not just entity_relationships).
    buildMemoryCooccurrenceLinks(db, memoryId, entityIds);
  });

  store();
}

// Cap how many co-occurrence memory_links a single store creates so one memory
// sharing a popular entity with thousands of others can't fan out into an edge
// storm. Other memories are taken in deterministic id order.
const MAX_COOCCURRENCE_MEMORY_LINKS = 25;

/**
 * Materializes memory<->memory co-occurrence into `memory_links` (G3-F7).
 * Finds currently-valid, top-level memories (other than `memoryId`) that share
 * at least one of `entityIds` and creates one canonical-direction `co_occurs`
 * edge per pair (relation 'co_occurs', source_kind 'co_occurrence', confidence
 * INFERRED). Repeats of the same pair bump evidence_count via createMemoryLink's
 * upsert, so the edge strengthens as the two memories keep co-occurring.
 */
export function buildMemoryCooccurrenceLinks(
  db: Database.Database,
  memoryId: string,
  entityIds: string[],
): void {
  const unique = [...new Set(entityIds)];
  if (unique.length === 0) return;

  const placeholders = unique.map(() => '?').join(',');
  const others = db
    .prepare<unknown[], { id: string }>(
      `SELECT DISTINCT m.id AS id
         FROM memory_entities me
         JOIN memories m ON m.id = me.memory_id
        WHERE me.entity_id IN (${placeholders})
          AND m.id <> ?
          AND m.parent_id IS NULL
          AND m.valid_to IS NULL
          AND m.tx_expired IS NULL
        ORDER BY m.id
        LIMIT ?`,
    )
    .all(...unique, memoryId, MAX_COOCCURRENCE_MEMORY_LINKS);

  for (const other of others) {
    // Canonical (lower id -> higher id) direction so (A,B) and (B,A) collapse
    // onto one edge whose evidence_count grows on recurrence.
    const [source, target] = memoryId < other.id ? [memoryId, other.id] : [other.id, memoryId];
    createMemoryLink(db, {
      sourceId: source,
      targetId: target,
      relation: 'co_occurs',
      confidence: 'INFERRED',
      confidenceScore: 0.5,
      sourceKind: 'co_occurrence',
    });
  }
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
