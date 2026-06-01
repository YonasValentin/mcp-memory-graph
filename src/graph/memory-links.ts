import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chunkIds } from './communities.js';

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
       (id, source_memory_id, target_memory_id, relation, confidence, confidence_score, source_kind, valid_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    id,
    input.sourceId,
    input.targetId,
    relation,
    input.confidence ?? 'INFERRED',
    input.confidenceScore ?? 0.5,
    input.sourceKind ?? 'wikilink',
  );
  return id;
}

/** Edges where `memoryId` is the source (what this memory points to). */
export function getOutgoingLinks(db: Database.Database, memoryId: string): MemoryLinkRow[] {
  return db
    .prepare<[string], MemoryLinkRow>(
      `SELECT * FROM memory_links
        WHERE source_memory_id = ?
        ORDER BY confidence_score DESC, evidence_count DESC`,
    )
    .all(memoryId);
}

/** Backlinks — edges where `memoryId` is the target (what points at this memory). */
export function getBacklinks(db: Database.Database, memoryId: string): MemoryLinkRow[] {
  return db
    .prepare<[string], MemoryLinkRow>(
      `SELECT * FROM memory_links
        WHERE target_memory_id = ?
        ORDER BY confidence_score DESC, evidence_count DESC`,
    )
    .all(memoryId);
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
