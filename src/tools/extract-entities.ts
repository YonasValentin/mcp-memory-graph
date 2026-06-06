import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  findOrCreateEntity,
  linkEntityToMemory,
  findOrCreateRelationship,
  normalizeName,
} from '../graph/entity-store.js';
import type { ENTITY_TYPES } from '../constants/enums.js';

interface EntityInput {
  name: string;
  // Derived from the canonical ENTITY_TYPES tuple so adding an anchor type
  // (work_item/pull_request/commit) widens this in lockstep — no drift.
  type: (typeof ENTITY_TYPES)[number];
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
    // v14: the graph this tool writes inherits the owning memory's partition, so
    // it is tenant-local (and under a forced namespace carries the forced ns).
    // The tool is guarded by idInForcedNs(memory_id) upstream, so a forced caller
    // can only target its own memory. namespace NULL → '' sentinel.
    const owner = db
      .prepare<[string], { scope: string; namespace: string | null }>(
        'SELECT scope, namespace FROM memories WHERE id = ?',
      )
      .get(input.memory_id);
    const partition = {
      scope: owner?.scope ?? 'global',
      namespace: owner?.namespace ?? '',
    };

    // Process entities
    for (const entity of input.entities) {
      const existing = db
        .prepare<[string, string, string, string], { id: string }>(
          'SELECT id FROM entities WHERE normalized_name = ? AND type = ? AND scope = ? AND namespace = ?',
        )
        .get(normalizeName(entity.name), entity.type, partition.scope, partition.namespace);

      const entityId = findOrCreateEntity(db, entity.name, entity.type, partition);
      nameToEntityId.set(entity.name.toLowerCase(), entityId);

      if (existing) {
        result.entities_updated++;
      } else {
        result.entities_created++;
      }

      linkEntityToMemory(db, input.memory_id, entityId, 'mention', 'llm', 0.9);

      // Add aliases (stamped with the partition so two tenants may share one).
      if (entity.aliases) {
        for (const alias of entity.aliases) {
          const normalizedAlias = normalizeName(alias);
          try {
            db.prepare(
              'INSERT INTO entity_aliases (id, entity_id, alias, normalized_alias, source, scope, namespace) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(randomUUID(), entityId, alias, normalizedAlias, 'llm', partition.scope, partition.namespace);
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
          findOrCreateRelationship(db, sourceId, targetId, rel.type, partition);
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
