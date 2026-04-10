import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
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
    // than regex-inferred types ('concept','file','pattern') — upgrade if applicable
    const specificTypes = new Set(['person', 'project', 'tool', 'organization']);
    const genericTypes = new Set(['concept', 'file', 'pattern']);
    const currentType = (db.prepare<[string], { type: string }>('SELECT type FROM entities WHERE id = ?').get(existing.id))?.type;
    const shouldUpgrade = specificTypes.has(type) && genericTypes.has(currentType ?? '');

    db.prepare(`
      UPDATE entities
      SET mention_count = mention_count + 1,
          last_seen_at = datetime('now')${shouldUpgrade ? ",\n          type = '" + type + "'" : ''}
      WHERE id = ?
    `).run(existing.id);
    return existing.id;
  }

  const id = uuidv4();
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
    for (const entity of entities) {
      const entityId = findOrCreateEntity(db, entity.name, entity.type);
      linkEntityToMemory(db, memoryId, entityId, 'mention', extractedBy, entity.confidence);
    }
  });

  store();
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

  const id = uuidv4();
  db.prepare(`
    INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, type)
    VALUES (?, ?, ?, ?)
  `).run(id, sourceEntityId, targetEntityId, type);

  return id;
}
