import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  findOrCreateEntity,
  linkEntityToMemory,
  findOrCreateRelationship,
  normalizeName,
} from '../graph/entity-store.js';

interface EntityInput {
  name: string;
  type: 'person' | 'project' | 'tool' | 'concept' | 'organization' | 'file' | 'package' | 'pattern';
  aliases?: string[];
}

interface RelationshipInput {
  source: string;
  target: string;
  type: 'uses' | 'created_by' | 'depends_on' | 'related_to' | 'part_of' | 'works_with';
}

interface ExtractEntitiesInput {
  memory_id: string;
  entities: EntityInput[];
  relationships?: RelationshipInput[];
}

interface ExtractEntitiesResult {
  entities_created: number;
  entities_updated: number;
  relationships_created: number;
  aliases_added: number;
}

export function handleExtractEntities(
  db: Database.Database,
  input: ExtractEntitiesInput,
): ExtractEntitiesResult {
  const result: ExtractEntitiesResult = {
    entities_created: 0,
    entities_updated: 0,
    relationships_created: 0,
    aliases_added: 0,
  };

  const nameToEntityId = new Map<string, string>();

  const process = db.transaction(() => {
    // Process entities
    for (const entity of input.entities) {
      const existing = db
        .prepare<[string, string], { id: string }>('SELECT id FROM entities WHERE normalized_name = ? AND type = ?')
        .get(normalizeName(entity.name), entity.type);

      const entityId = findOrCreateEntity(db, entity.name, entity.type);
      nameToEntityId.set(entity.name.toLowerCase(), entityId);

      if (existing) {
        result.entities_updated++;
      } else {
        result.entities_created++;
      }

      linkEntityToMemory(db, input.memory_id, entityId, 'mention', 'llm', 0.9);

      // Add aliases
      if (entity.aliases) {
        for (const alias of entity.aliases) {
          const normalizedAlias = normalizeName(alias);
          try {
            db.prepare(
              'INSERT INTO entity_aliases (id, entity_id, alias, normalized_alias, source) VALUES (?, ?, ?, ?, ?)',
            ).run(randomUUID(), entityId, alias, normalizedAlias, 'llm');
            result.aliases_added++;
          } catch {
            // Alias already exists (unique constraint)
          }
        }
      }
    }

    // Process relationships
    if (input.relationships) {
      for (const rel of input.relationships) {
        const sourceId = nameToEntityId.get(rel.source.toLowerCase());
        const targetId = nameToEntityId.get(rel.target.toLowerCase());
        if (sourceId && targetId) {
          findOrCreateRelationship(db, sourceId, targetId, rel.type);
          result.relationships_created++;
        }
      }
    }
  });

  // P9-begin-immediate: process READS (SELECT id FROM entities + findOrCreateEntity)
  // then WRITES. BEGIN IMMEDIATE so a concurrent writer makes it WAIT on
  // busy_timeout instead of throwing SQLITE_BUSY on the deferred write-upgrade.
  process.immediate();
  return result;
}
