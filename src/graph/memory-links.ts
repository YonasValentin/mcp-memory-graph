import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

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
  db.prepare(
    `INSERT INTO memory_links
       (id, source_memory_id, target_memory_id, relation, confidence, confidence_score, source_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
