import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider, MemoryRow } from '../types.js';
import { insertMemory } from '../db/repository.js';
import { contextualizeForEmbedding } from '../search/contextual.js';

/**
 * Adaptive per-user expertise profile (M5.2, Path A — no schema change).
 *
 * Convention: one currently-valid memory per (scope='user', namespace, topic)
 * with document_type='expertise' and metadata `{ topic, level, evidence_count,
 * last_seen }`. `observe` records that the user demonstrated knowledge of a
 * topic; the level rises on a SATURATING curve `1 - 1/(1+evidence_count)`
 * (matches graph.ts edge-strength), so early observations move it a lot and it
 * asymptotes toward 1 — never a hard cap, never linear runaway.
 *
 * The hazards the naive version hit, and how this avoids them:
 *  - NOOP cross-topic collapse: it does NOT route through handleStore (whose
 *    write-gate would NOOP a second topic as a near-duplicate). It upserts on
 *    the EXACT (scope, namespace, topic) key, so every topic gets its own row.
 *  - version churn: an `observe` bump is a metadata-only counter update done via
 *    a direct UPDATE (no version snapshot, no re-embed) — the content/title are
 *    unchanged, so the edit-history audit trail stays meaningful.
 */

export interface ExpertiseInput {
  action?: 'observe' | 'get';
  topic?: string;
  scope?: string;
  namespace?: string;
  /** Optional explicit evidence increment for `observe` (default 1). */
  weight?: number;
}

export interface ExpertiseEntry {
  topic: string;
  level: number;
  evidence_count: number;
  last_seen: string | null;
  memory_id: string;
}

export interface ExpertiseResult {
  action: 'observe' | 'get';
  observed?: ExpertiseEntry;
  profile?: ExpertiseEntry[];
}

const DEFAULT_SCOPE = 'user';

function saturatingLevel(evidence: number): number {
  return 1 - 1 / (1 + Math.max(1, evidence));
}

interface MetaShape {
  topic: string;
  level: number;
  evidence_count: number;
  last_seen: string | null;
}

function findExpertiseRow(
  db: Database.Database,
  scope: string,
  namespace: string | null,
  topic: string,
): (MemoryRow & { rowid: number }) | undefined {
  return db
    .prepare<[string, string | null, string], MemoryRow & { rowid: number }>(
      `SELECT rowid, * FROM memories
        WHERE document_type = 'expertise'
          AND scope = ?
          AND ${namespace == null ? 'namespace IS NULL' : 'namespace = ?'}
          AND json_extract(metadata, '$.topic') = ?
          AND valid_to IS NULL AND tx_expired IS NULL AND superseded_at IS NULL AND parent_id IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(...(namespace == null ? [scope, topic] : [scope, namespace, topic]) as [string, string | null, string]);
}

function rowToEntry(row: MemoryRow): ExpertiseEntry {
  const meta = (row.metadata ? safeJson(row.metadata) : {}) as Partial<MetaShape>;
  return {
    topic: meta.topic ?? row.title ?? '',
    level: typeof meta.level === 'number' ? meta.level : row.importance_score,
    evidence_count: typeof meta.evidence_count === 'number' ? meta.evidence_count : 1,
    last_seen: meta.last_seen ?? row.updated_at,
    memory_id: row.id,
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function handleExpertise(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: ExpertiseInput,
): Promise<ExpertiseResult> {
  const action = input.action ?? 'get';
  const scope = input.scope ?? DEFAULT_SCOPE;
  const namespace = input.namespace ?? null;

  if (action === 'get') {
    const conds = ["document_type = 'expertise'", 'scope = ?', 'valid_to IS NULL', 'tx_expired IS NULL', 'parent_id IS NULL'];
    const params: unknown[] = [scope];
    if (input.namespace !== undefined) {
      conds.push('namespace = ?');
      params.push(input.namespace);
    }
    if (input.topic !== undefined) {
      conds.push("json_extract(metadata, '$.topic') = ?");
      params.push(input.topic);
    }
    const rows = db
      .prepare<unknown[], MemoryRow>(
        `SELECT * FROM memories WHERE ${conds.join(' AND ')} ORDER BY importance_score DESC`,
      )
      .all(...params);
    return { action: 'get', profile: rows.map(rowToEntry) };
  }

  // observe
  if (!input.topic) throw new Error('memory_expertise action=observe requires a topic');
  const topic = input.topic.trim();
  const now = new Date().toISOString();
  const inc = Math.max(1, Math.floor(input.weight ?? 1));

  // battle-v9 CLASS 3: an observe is a read-modify-write counter bump. Two
  // concurrent observes must neither lose an increment (both read N, both write
  // N+inc) nor both create a first-observation row. Serialize find→decide→write
  // in a BEGIN IMMEDIATE txn (.immediate). The first-observation embedding can't
  // be awaited inside a sync txn, so the fast path (existing row) increments
  // under the lock with NO embed; only a genuine first observation embeds.
  const applyIncrement = (existing: MemoryRow & { rowid: number }): ExpertiseEntry => {
    const meta = (existing.metadata ? safeJson(existing.metadata) : {}) as Partial<MetaShape>;
    const evidence = (typeof meta.evidence_count === 'number' ? meta.evidence_count : 1) + inc;
    const level = saturatingLevel(evidence);
    const newMeta: MetaShape = { topic, level, evidence_count: evidence, last_seen: now };
    // Direct metadata-only update — NOT updateMemory: an observe is a counter
    // bump, not a content edit, so it must not snapshot a version or re-embed.
    db.prepare(
      "UPDATE memories SET metadata = ?, importance_score = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(JSON.stringify(newMeta), level, existing.id);
    return { topic, level, evidence_count: evidence, last_seen: now, memory_id: existing.id };
  };

  // Fast path: atomically increment an existing row's counter (no embed needed).
  const incremented = db
    .transaction((): ExpertiseEntry | null => {
      const existing = findExpertiseRow(db, scope, namespace, topic);
      return existing ? applyIncrement(existing) : null;
    })
    .immediate();
  if (incremented) return { action: 'observe', observed: incremented };

  // First observation — embed OUTSIDE the txn, then insert-if-still-absent under
  // the lock. The re-check absorbs a concurrent create (→ increment instead),
  // so two racing first-observes can never produce a duplicate expertise row.
  const content = `Expertise: ${topic}`;
  const embedding = await embedder.embed(
    contextualizeForEmbedding(content, { title: topic, document_type: 'expertise', namespace }),
  );
  const observed = db
    .transaction((): ExpertiseEntry => {
      const raced = findExpertiseRow(db, scope, namespace, topic);
      if (raced) return applyIncrement(raced);
      const evidence = inc;
      const level = saturatingLevel(evidence);
      const meta: MetaShape = { topic, level, evidence_count: evidence, last_seen: now };
      const row: MemoryRow = {
        id: randomUUID(),
        scope,
        namespace,
        title: topic,
        content,
        document_type: 'expertise',
        source: null,
        author: null,
        department: null,
        tags: null,
        access_level: 'private',
        language: 'en',
        metadata: JSON.stringify(meta),
        parent_id: null,
        chunk_index: null,
        version: 1,
        created_at: now,
        updated_at: now,
        expires_at: null,
        access_count: 0,
        last_accessed_at: null,
        importance_score: level,
        confidence_score: 0.7,
        stability: 1.0,
        agent_id: process.env.MCP_AGENT_ID ?? null,
      };
      insertMemory(db, row, embedding);
      return { topic, level, evidence_count: evidence, last_seen: now, memory_id: row.id };
    })
    .immediate();
  return { action: 'observe', observed };
}
