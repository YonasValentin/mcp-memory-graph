import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ExtractedEntity } from './entity-extractor.js';
import { createMemoryLink } from './memory-links.js';

/**
 * v14 multi-tenancy — the partition an entity-graph write belongs to. An entity
 * inherits the owning memory's (scope, namespace); scope='global'/namespace=''
 * is the cross-project shared bridge (single-user). Identity is
 * (normalized_name, scope, namespace), so the SAME concept in two tenants is two
 * rows and mention_count is per-tenant. Defaults to the global bridge so any
 * un-updated caller (and pre-v14 behaviour) lands in the shared partition.
 */
export interface GraphPartition {
  scope: string;
  namespace: string;
}

const GLOBAL_PARTITION: GraphPartition = { scope: 'global', namespace: '' };

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

// ── Alias resolution (read paths) ─────────────────────────────────────────
// Single source of entity_aliases → entity resolution shared by every read
// path. The invariant everywhere: a DIRECT entity-name match always wins, so a
// registered alias never shadows a real entity of the same spelling.

/**
 * Resolve a single normalized name to its canonical entity normalized_name,
 * following entity_aliases only when the name is not itself an entity. Returns
 * the input unchanged when nothing resolves. Used by the memory_graph lookup.
 *
 * battle-v16 ALIAS-NS: when a namespace is given (a pinned/forced deployment),
 * BOTH the direct-entity and the alias lookup are scoped to it. Without this the
 * `LIMIT 1` over a shared DB picked whichever tenant inserted first, so a tenant
 * querying its OWN alias (e.g. "pg") that collides with another tenant's alias
 * resolved to the FOREIGN canonical name — and the ns-filtered selection in
 * handleGraph then found nothing (the querying tenant saw an empty graph). Same
 * wrong-altitude class as battle-v15 PPR-1, which namespaced the PageRank seed
 * but left this direct alias resolver global.
 */
export function resolveToCanonicalName(
  db: Database.Database,
  normalized: string,
  namespace?: string,
): string {
  const nsClause = namespace !== undefined ? ' AND namespace = ?' : '';
  const directParams = namespace !== undefined ? [normalized, namespace] : [normalized];
  const direct = db
    .prepare<unknown[], { x: number }>(
      `SELECT 1 AS x FROM entities WHERE normalized_name = ?${nsClause} LIMIT 1`,
    )
    .get(...directParams);
  if (direct) return normalized;
  const aliasNsClause = namespace !== undefined ? ' AND a.namespace = ?' : '';
  const aliasParams = namespace !== undefined ? [normalized, namespace] : [normalized];
  const alias = db
    .prepare<unknown[], { normalized_name: string }>(
      `SELECT e.normalized_name FROM entity_aliases a
       JOIN entities e ON e.id = a.entity_id
       WHERE a.normalized_alias = ?${aliasNsClause} LIMIT 1`,
    )
    .get(...aliasParams);
  return alias ? alias.normalized_name : normalized;
}

/**
 * Entity ids whose canonical normalized_name OR a registered normalized_alias is
 * in `normalizedNames`. The alias→entity-id resolver for the search graph-seed
 * and Personalized PageRank paths (linkQueryEntities): direct names and aliases
 * both resolve to the owning entity id, deduped. Empty in → empty out (never
 * builds an `IN ()` that throws).
 */
export function entityIdsByNameOrAlias(
  db: Database.Database,
  normalizedNames: string[],
  // battle-v15 PPR-1: when a namespace is forced, resolve only that tenant's
  // entities (v14 identity is per-namespace). Unset (single-user) → resolve
  // across the whole graph, unchanged. entity_aliases carries the same namespace
  // column (v14), so the alias arm gates on it too.
  namespace?: string,
): string[] {
  if (normalizedNames.length === 0) return [];
  const ph = normalizedNames.map(() => '?').join(',');
  const nsClause = namespace !== undefined ? ' AND namespace = ?' : '';
  const sql =
    `SELECT id FROM entities WHERE normalized_name IN (${ph})${nsClause}` +
    ` UNION ` +
    `SELECT entity_id AS id FROM entity_aliases WHERE normalized_alias IN (${ph})${nsClause}`;
  const params =
    namespace !== undefined
      ? [...normalizedNames, namespace, ...normalizedNames, namespace]
      : [...normalizedNames, ...normalizedNames];
  const rows = db.prepare<unknown[], { id: string }>(sql).all(...params);
  return [...new Set(rows.map((r) => r.id))];
}

// ── Entity CRUD ─────────────────────────────────────────────────────────

export function findOrCreateEntity(
  db: Database.Database,
  name: string,
  type: string,
  partition: GraphPartition = GLOBAL_PARTITION,
): string {
  const normalized = normalizeName(name);

  // v14 (battle-v14 G5): identity is per (normalized_name, NAMESPACE) — the
  // tenant boundary. Scope never partitions (it would fragment a single user's
  // graph across global/project/user). The same concept in another tenant is a
  // distinct row; within one partition the mention_count it bumps is tenant-local.
  const existing = db
    .prepare<[string, string], { id: string }>(
      'SELECT id FROM entities WHERE normalized_name = ? AND namespace = ?',
    )
    .get(normalized, partition.namespace);

  if (existing) {
    // LLM-provided types ('person','project','tool','organization') are more specific
    // than regex-inferred types ('concept','file','pattern') — upgrade if applicable.
    // M4.1 ecosystem anchors (work_item/pull_request/commit) are exact identifiers,
    // also specific — never let a later generic regex hit downgrade them.
    const SPECIFIC_TYPES = new Set([
      'person', 'project', 'tool', 'organization',
      'work_item', 'pull_request', 'commit',
      // Org-ontology kinds (enterprise-brain): an explicit team/department/sop/
      // agent extraction must win over a generic regex first-inference, or the
      // node stays mistyped and invisible to memory_graph's exact type filter.
      'team', 'department', 'sop', 'agent',
    ]);
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
    INSERT INTO entities (id, name, normalized_name, type, scope, namespace)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, normalized, type, partition.scope, partition.namespace);

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
  partition: GraphPartition = GLOBAL_PARTITION,
): void {
  const store = db.transaction(() => {
    const entityIds: string[] = [];
    for (const entity of entities) {
      const entityId = findOrCreateEntity(db, entity.name, entity.type, partition);
      linkEntityToMemory(db, memoryId, entityId, 'mention', extractedBy, entity.confidence);
      entityIds.push(entityId);
    }
    // Entities mentioned together in one memory co-occur — materialize that as
    // graph edges so the knowledge graph actually has edges (not just nodes).
    buildCooccurrenceEdges(db, entityIds, partition);
    // Bridge co-occurrence into the memory<->memory graph too (G3-F7): memories
    // sharing an entity get a memory_links 'co_occurs' edge, so /api/graph and
    // memory_get.links reflect co-occurrence (not just entity_relationships).
    buildMemoryCooccurrenceLinks(db, memoryId, entityIds);
  });

  // P9-begin-immediate: store opens with findOrCreateEntity's SELECT then WRITES
  // (entity upsert + links). BEGIN IMMEDIATE so a concurrent writer makes it WAIT
  // on busy_timeout instead of throwing SQLITE_BUSY on the deferred write-upgrade.
  store.immediate();
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
  partition: GraphPartition = GLOBAL_PARTITION,
): void {
  const unique = [...new Set(entityIds)].slice(0, MAX_COOCCURRENCE_ENTITIES);
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const [source, target] =
        unique[i] < unique[j] ? [unique[i], unique[j]] : [unique[j], unique[i]];
      findOrCreateRelationship(db, source, target, 'co_occurs', partition);
    }
  }
}

// ── Relationships ───────────────────────────────────────────────────────

/**
 * Meaningful, IDF-style edge strength in (0,1] (R2 item 1). The schema default
 * of a dead constant 0.5 carried no information — every edge looked identical.
 *
 * Two monotone signals combine:
 *   • SPECIFICITY (IDF analog) — rarer endpoints make a stronger edge.
 *     `spec = 2 / (2 + mentionsA + mentionsB)` ∈ (0,1]: 1 when both entities are
 *     brand-new, decaying toward 0 as either becomes a common hub. Two memories
 *     sharing a rare, specific entity is a far stronger association than both
 *     mentioning a ubiquitous one.
 *   • EVIDENCE — a pair witnessed by many memories is a stronger edge.
 *     `ev = 1 - 1 / (1 + evidenceCount)` (saturating; matches graph.ts).
 *
 * Blend: `ev * (0.5 + 0.5 * spec)` — evidence sets the base, specificity scales
 * it within [0.5·ev, ev]. Strictly increasing in evidence and in specificity,
 * always in (0,1]. Pure + deterministic (no model, no DB).
 */
export function edgeStrength(
  mentionsA: number,
  mentionsB: number,
  evidenceCount: number,
): number {
  const a = Math.max(0, mentionsA);
  const b = Math.max(0, mentionsB);
  const spec = 2 / (2 + a + b);
  const ev = 1 - 1 / (1 + Math.max(1, evidenceCount));
  return ev * (0.5 + 0.5 * spec);
}

/** Reads an entity's current mention_count (0 if unknown). */
function mentionCount(db: Database.Database, entityId: string): number {
  const row = db
    .prepare<[string], { mention_count: number }>(
      'SELECT mention_count FROM entities WHERE id = ?',
    )
    .get(entityId);
  return row?.mention_count ?? 0;
}

export function findOrCreateRelationship(
  db: Database.Database,
  sourceEntityId: string,
  targetEntityId: string,
  type: string,
  partition: GraphPartition = GLOBAL_PARTITION,
): string {
  const existing = db
    .prepare<[string, string, string], { id: string; evidence_count: number }>(
      'SELECT id, evidence_count FROM entity_relationships WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?',
    )
    .get(sourceEntityId, targetEntityId, type);

  // IDF-weighted strength written on every touch (R2 item 1): rarer shared
  // entities → stronger edge, and strength grows with accumulated evidence.
  const mA = mentionCount(db, sourceEntityId);
  const mB = mentionCount(db, targetEntityId);

  if (existing) {
    const nextEvidence = existing.evidence_count + 1;
    db.prepare(`
      UPDATE entity_relationships
      SET evidence_count = ?,
          strength = ?,
          last_seen_at = datetime('now')
      WHERE id = ?
    `).run(nextEvidence, edgeStrength(mA, mB, nextEvidence), existing.id);
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, type, strength, evidence_count, scope, namespace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sourceEntityId, targetEntityId, type, edgeStrength(mA, mB, 1), 1, partition.scope, partition.namespace);

  return id;
}

/**
 * Re-weaves the IDF-weighted strengths of the co-occurrence edges touching a
 * freshly-stored memory's entities (R2 item 4). Called once from handleStore's
 * post-commit side-effects (fail-soft, like entity extraction). Entity
 * mention_count keeps rising as a corpus grows, so an edge written long ago
 * carries a stale specificity; this recomputes `strength` for every edge among
 * the memory's own entities against their CURRENT mention_count, so the graph's
 * specificity signal stays honest without rescanning the whole graph.
 *
 * Read-mostly: only UPDATEs existing edges (never inserts) — the co-occurrence
 * edges themselves are created by storeExtractedEntities. Deterministic.
 */
export function weaveGraphEdges(db: Database.Database, memoryId: string): void {
  const entityRows = db
    .prepare<[string], { entity_id: string }>(
      'SELECT entity_id FROM memory_entities WHERE memory_id = ?',
    )
    .all(memoryId);
  const entityIds = entityRows.map((r) => r.entity_id);
  if (entityIds.length < 2) return;

  const placeholders = entityIds.map(() => '?').join(',');
  // Edges whose BOTH endpoints are entities of this memory.
  const edges = db
    .prepare<unknown[], { id: string; source_entity_id: string; target_entity_id: string; evidence_count: number }>(
      `SELECT id, source_entity_id, target_entity_id, evidence_count
         FROM entity_relationships
        WHERE source_entity_id IN (${placeholders})
          AND target_entity_id IN (${placeholders})`,
    )
    .all(...entityIds, ...entityIds);

  const update = db.transaction(() => {
    for (const edge of edges) {
      const mA = mentionCount(db, edge.source_entity_id);
      const mB = mentionCount(db, edge.target_entity_id);
      db.prepare('UPDATE entity_relationships SET strength = ? WHERE id = ?').run(
        edgeStrength(mA, mB, edge.evidence_count),
        edge.id,
      );
    }
  });
  // P9-begin-immediate: update reads mentionCount (SELECT) before each UPDATE.
  // BEGIN IMMEDIATE so a concurrent writer makes it WAIT on busy_timeout instead
  // of throwing SQLITE_BUSY on the deferred write-upgrade.
  update.immediate();
}
