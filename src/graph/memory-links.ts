import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chunkIds } from './communities.js';
import { forcedNamespace } from '../lib/tenancy.js';

/** Provenance of an inferred edge — graphify's honest audit model. */
export type EdgeConfidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

/** What signal produced the edge. */
export type LinkSourceKind = 'wikilink' | 'co_occurrence' | 'similarity' | 'typed';

export interface MemoryLinkInput {
  sourceId: string;
  targetId: string;
  relation?: string;
  confidence?: EdgeConfidence;
  confidenceScore?: number;
  sourceKind?: LinkSourceKind;
}

export interface MemoryLinkRow {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation: string;
  confidence: EdgeConfidence;
  confidence_score: number;
  source_kind: LinkSourceKind;
  evidence_count: number;
  created_at: string;
  last_seen_at: string;
  metadata: string | null;
}

/**
 * Upserts a directed memory→memory edge. A repeat of the same
 * (source, target, relation) triple bumps `evidence_count` instead of
 * inserting a duplicate. Self-links are ignored. Returns the edge id
 * (empty string for an ignored self-link).
 */
export function createMemoryLink(db: Database.Database, input: MemoryLinkInput): string {
  if (input.sourceId === input.targetId) return '';
  const relation = input.relation ?? 'links_to';

  // v14 multi-tenancy: an edge carries the partition of its endpoint memories.
  // The tenant boundary is NAMESPACE (scope is an intra-tenant dimension —
  // global/project/user can legitimately coexist and be linked within one
  // vault/user). Under a FORCED namespace, refuse an edge whose endpoints cross
  // namespaces, so a forced tenant's graph walk can never hop to a foreign
  // memory. When UNFORCED (single-user), never refuse — a user's own wikilinks
  // (incl. a global-scope note linking a project note round-tripped through the
  // vault) are legitimate, exactly as pre-v14 (battle-v14 F2 regression fix).
  const partition = edgePartition(db, input.sourceId, input.targetId);
  if (!partition) return '';

  const existing = db
    .prepare<[string, string, string], { id: string }>(
      'SELECT id FROM memory_links WHERE source_memory_id = ? AND target_memory_id = ? AND relation = ?',
    )
    .get(input.sourceId, input.targetId, relation);

  if (existing) {
    db.prepare(
      `UPDATE memory_links
          SET evidence_count = evidence_count + 1,
              last_seen_at = datetime('now')
        WHERE id = ?`,
    ).run(existing.id);
    return existing.id;
  }

  const id = randomUUID();
  // valid_from mirrors the edge's transaction-created time (bi-temporal v6);
  // valid_to / tx_expired stay NULL (still valid, not retracted).
  db.prepare(
    `INSERT INTO memory_links
       (id, source_memory_id, target_memory_id, relation, confidence, confidence_score, source_kind, valid_from, scope, namespace)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
  ).run(
    id,
    input.sourceId,
    input.targetId,
    relation,
    input.confidence ?? 'INFERRED',
    input.confidenceScore ?? 0.5,
    input.sourceKind ?? 'wikilink',
    partition.scope,
    partition.namespace,
  );
  return id;
}

/**
 * v14 — the (scope, namespace) to stamp on a new edge, derived from the SOURCE
 * memory, or null when the edge must be refused. namespace NULL → '' sentinel.
 *
 * Refusal rule: only when a tenant namespace is FORCED and the two endpoints
 * live in DIFFERENT namespaces (a cross-tenant hop). When unforced (single-user)
 * the edge is always allowed and stamped with the source's partition — a missing
 * endpoint (shouldn't happen under the FK) still returns null so no orphan edge
 * is stamped.
 */
function edgePartition(
  db: Database.Database,
  sourceId: string,
  targetId: string,
): { scope: string; namespace: string } | null {
  const stmt = db.prepare<[string], { scope: string; namespace: string | null }>(
    'SELECT scope, namespace FROM memories WHERE id = ?',
  );
  const s = stmt.get(sourceId);
  const t = stmt.get(targetId);
  if (!s || !t) return null;
  const sNs = s.namespace ?? '';
  const tNs = t.namespace ?? '';
  // Under a forced namespace, an edge crossing namespaces is a cross-tenant hop —
  // refuse it. Scope differences within one namespace are fine (intra-tenant).
  if (forcedNamespace() && sNs !== tNs) return null;
  return { scope: s.scope, namespace: sNs };
}

/**
 * battle-v14 G4: under a forced namespace, an edge whose OTHER endpoint memory is
 * in a different namespace is a cross-tenant hop — exclude it so memory_get.links/
 * backlinks never disclose a foreign memory id. A pre-v14/migrated DB (or an
 * unforced single-user link round-tripped, then pinned) can hold such edges; the
 * read surface validates the endpoint regardless. Returns the SQL fragment +
 * params that constrain `<col>` (the other endpoint) to the forced namespace, or
 * empty when unforced. NULL namespace stored as '' — compare via COALESCE.
 */
function foreignEndpointGuard(col: 'source_memory_id' | 'target_memory_id'): {
  sql: string;
  params: string[];
} {
  const ns = forcedNamespace();
  if (!ns) return { sql: '', params: [] };
  return {
    sql: ` AND (SELECT COALESCE(namespace, '') FROM memories WHERE id = memory_links.${col}) = ?`,
    params: [ns],
  };
}

/** Edges where `memoryId` is the source (what this memory points to). */
export function getOutgoingLinks(db: Database.Database, memoryId: string): MemoryLinkRow[] {
  const guard = foreignEndpointGuard('target_memory_id');
  return db
    .prepare<string[], MemoryLinkRow>(
      `SELECT * FROM memory_links
        WHERE source_memory_id = ?${guard.sql}
        ORDER BY confidence_score DESC, evidence_count DESC`,
    )
    .all(memoryId, ...guard.params);
}

/** Backlinks — edges where `memoryId` is the target (what points at this memory). */
export function getBacklinks(db: Database.Database, memoryId: string): MemoryLinkRow[] {
  const guard = foreignEndpointGuard('source_memory_id');
  return db
    .prepare<string[], MemoryLinkRow>(
      `SELECT * FROM memory_links
        WHERE target_memory_id = ?${guard.sql}
        ORDER BY confidence_score DESC, evidence_count DESC`,
    )
    .all(memoryId, ...guard.params);
}

/**
 * All edges whose BOTH endpoints fall within `memoryIds` — the edge set for a
 * subgraph of the given nodes (e.g. the dashboard graph view). Edges pointing
 * outside the set are excluded so the rendered graph stays internally consistent.
 */
export function getLinksAmong(
  db: Database.Database,
  memoryIds: string[],
  chunkSize?: number,
): MemoryLinkRow[] {
  if (memoryIds.length === 0) return [];

  // The id set can exceed SQLite's ~32k bound-parameter limit. The old query
  // bound the set TWICE (source IN (…) AND target IN (…)), so it crashed past
  // ~16k ids. Chunk over the SOURCE set only — one IN-clause per batch — then
  // filter targets in JS against the full set. (Chunking BOTH IN-clauses would
  // drop edges whose source and target fall in different chunks.) Re-sort in JS
  // to preserve the global confidence_score DESC, evidence_count DESC order the
  // single-query version guaranteed.
  const idSet = new Set(memoryIds);
  const rows: MemoryLinkRow[] = [];
  for (const batch of chunkIds(memoryIds, chunkSize)) {
    const placeholders = batch.map(() => '?').join(',');
    const batchRows = db
      .prepare<string[], MemoryLinkRow>(
        `SELECT * FROM memory_links WHERE source_memory_id IN (${placeholders})`,
      )
      .all(...batch);
    for (const r of batchRows) {
      if (idSet.has(r.target_memory_id)) rows.push(r);
    }
  }
  rows.sort(
    (a, b) => b.confidence_score - a.confidence_score || b.evidence_count - a.evidence_count,
  );
  return rows;
}
