import type Database from 'better-sqlite3';
import type { Memory, MemoryRow, ListOptions, AccessLogEntry, IngestSourceRecord } from '../types.js';
import type { MemoryPartition } from '../graph/conflict-resolver.js';
import { NOW_ISO_SQL } from './predicates.js';
import { signEnvelope } from '../provenance/envelope.js';

/** Whether to attach a signed provenance envelope on write (M2.2, opt-in). */
function signingEnabled(): boolean {
  return process.env.MCP_SIGN_MEMORIES === '1' || process.env.MCP_SIGN_MEMORIES === 'true';
}

export function insertMemory(
  db: Database.Database,
  memory: MemoryRow,
  embedding: Float32Array,
): { id: string; rowid: number } {
  const insert = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO memories (
        id, scope, namespace, title, content, document_type, source,
        author, department, tags, access_level, language, metadata,
        parent_id, chunk_index, version, created_at, updated_at, expires_at,
        access_count, last_accessed_at, importance_score, confidence_score,
        valid_from, valid_to, tx_expired, agent_id
      ) VALUES (
        @id, @scope, @namespace, @title, @content, @document_type, @source,
        @author, @department, @tags, @access_level, @language, @metadata,
        @parent_id, @chunk_index, @version, @created_at, @updated_at, @expires_at,
        @access_count, @last_accessed_at, @importance_score, @confidence_score,
        @created_at, NULL, NULL, @agent_id
      )
    `);

    const result = stmt.run({ ...memory, agent_id: memory.agent_id ?? null });
    const rowid = BigInt(result.lastInsertRowid);

    // M2.2 — signed provenance envelope (opt-in via MCP_SIGN_MEMORIES). Sign the
    // stored content + the fields that are STABLE at insert (agent_id, scope,
    // namespace, valid_from=created_at, created_at). provenance is excluded — it
    // is mutated post-insert (reflect) and verify.ts omits it too, so the two
    // stay symmetric. signed_at is the row's own created_at for determinism.
    if (signingEnabled()) {
      const env = signEnvelope(
        memory.content,
        {
          agent_id: memory.agent_id ?? null,
          scope: memory.scope,
          namespace: memory.namespace ?? null,
          valid_from: memory.created_at,
          created_at: memory.created_at,
        },
        memory.created_at,
      );
      db.prepare(
        'UPDATE memories SET content_hash = ?, signature = ?, pubkey = ?, signed_at = ? WHERE id = ?',
      ).run(env.content_hash, env.signature, env.pubkey, env.signed_at, memory.id);
    }

    db.prepare(
      'INSERT INTO memories_vec(rowid, embedding, scope, namespace) VALUES (?, ?, ?, ?)',
    ).run(rowid, Buffer.from(embedding.buffer), memory.scope ?? '', memory.namespace ?? '');

    db.prepare(
      'INSERT INTO memories_fts(rowid, title, content, tags, author, department) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      rowid,
      memory.title,
      memory.content,
      memory.tags,
      memory.author,
      memory.department,
    );

    return { id: memory.id, rowid: Number(rowid) };
  });

  return insert();
}

export function updateMemory(
  db: Database.Database,
  id: string,
  updates: Partial<MemoryRow>,
  newEmbedding?: Float32Array,
): MemoryRow | null {
  const update = db.transaction(() => {
    const existing = db
      .prepare<[string], MemoryRow & { rowid: number }>(
        'SELECT rowid, * FROM memories WHERE id = ?',
      )
      .get(id);

    if (!existing) {
      return null;
    }

    const allowedFields: (keyof MemoryRow)[] = [
      'title',
      'content',
      'tags',
      'metadata',
      'expires_at',
      'scope',
      'namespace',
      'document_type',
      'source',
      'author',
      'department',
      'access_level',
      'language',
      'importance_score',
      'confidence_score',
    ];

    // Only fields that are PRESENT in `updates` AND differ from the stored value
    // count as a real change. A no-op update (id only, or every field identical)
    // must NOT snapshot, bump the version, touch updated_at, or reindex — doing
    // so wrote phantom memory_versions rows and inflated the version on every
    // call (incl. the memory_version_restore-to-current path), corrupting the
    // edit-history audit trail a power user relies on (battle-v5, confirmed).
    const changedFields = allowedFields.filter(
      (field) => field in updates && updates[field] !== existing[field],
    );

    if (changedFields.length === 0) {
      return db
        .prepare<[string], MemoryRow>('SELECT * FROM memories WHERE id = ?')
        .get(id)!;
    }

    const versionId = `${id}_v${existing.version}`;
    db.prepare(`
      INSERT INTO memory_versions (id, memory_id, content, title, metadata, version, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      versionId,
      id,
      existing.content,
      existing.title,
      existing.metadata,
      existing.version,
      updates.author ?? null,
    );

    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const field of changedFields) {
      setClauses.push(`${field} = ?`);
      params.push(updates[field]);
    }

    setClauses.push('version = version + 1');
    // ISO-8601 + Z (matching toISOString() created_at and the strftime valid_to
    // tombstone) so updated_at collates correctly in lexicographic comparisons —
    // datetime('now')'s space separator sorts before 'T' and would let an older
    // tombstone suppress a later live edit in the git union merge (data loss).
    setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    params.push(id);

    db.prepare(`UPDATE memories SET ${setClauses.join(', ')} WHERE id = ?`).run(
      ...params,
    );

    const contentChanged =
      updates.content !== undefined && updates.content !== existing.content;

    if (contentChanged && newEmbedding) {
      db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(existing.rowid));
      db.prepare(
        'INSERT INTO memories_vec(rowid, embedding, scope, namespace) VALUES (?, ?, ?, ?)',
      ).run(
        BigInt(existing.rowid),
        Buffer.from(newEmbedding.buffer),
        (updates.scope ?? existing.scope) || '',
        (updates.namespace ?? existing.namespace) || '',
      );
    }

    db.prepare(
      "INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, author, department) VALUES('delete', ?, ?, ?, ?, ?, ?)",
    ).run(
      existing.rowid,
      existing.title,
      existing.content,
      existing.tags,
      existing.author,
      existing.department,
    );

    const updated = db
      .prepare<[string], MemoryRow>('SELECT * FROM memories WHERE id = ?')
      .get(id)!;

    db.prepare(
      'INSERT INTO memories_fts(rowid, title, content, tags, author, department) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      existing.rowid,
      updated.title,
      updated.content,
      updated.tags,
      updated.author,
      updated.department,
    );

    // M2.2: if this row carried a signed provenance envelope, RE-SIGN it after a
    // real edit. The signed set (content_hash + scope/namespace/identity) now
    // diverges from the stored envelope, so without this a LEGITIMATE update
    // would read as content_mismatch → 'tampered', indistinguishable from a
    // malicious direct-DB forge. Only re-signs when signing is enabled and the
    // row was already signed (an unsigned row stays unsigned). signed_at mirrors
    // created_at for determinism, matching insertMemory.
    const wasSigned = (existing as { signature?: string | null }).signature != null;
    if (wasSigned && signingEnabled()) {
      const env = signEnvelope(
        updated.content,
        {
          agent_id: updated.agent_id ?? null,
          scope: updated.scope,
          namespace: updated.namespace ?? null,
          valid_from: (updated as { valid_from?: string | null }).valid_from ?? updated.created_at,
          created_at: updated.created_at,
        },
        updated.created_at,
      );
      db.prepare(
        'UPDATE memories SET content_hash = ?, signature = ?, pubkey = ?, signed_at = ? WHERE id = ?',
      ).run(env.content_hash, env.signature, env.pubkey, env.signed_at, id);
      return db.prepare<[string], MemoryRow>('SELECT * FROM memories WHERE id = ?').get(id)!;
    }

    return updated;
  });

  // P9-begin-immediate: this txn READS (SELECT existing) then WRITES. A DEFAULT
  // deferred BEGIN acquires the write lock lazily on the first write, so a
  // concurrent writer makes the deferred → write UPGRADE throw SQLITE_BUSY
  // INSTANTLY — busy_timeout is not honored on a lock upgrade. BEGIN IMMEDIATE
  // takes the write lock at BEGIN, so busy_timeout applies and the txn waits.
  return update.immediate();
}

export function deleteMemory(db: Database.Database, id: string): boolean {
  const remove = db.transaction(() => {
    const row = db
      .prepare<[string], MemoryRow & { rowid: number }>(
        'SELECT rowid, * FROM memories WHERE id = ?',
      )
      .get(id);

    if (!row) {
      return false;
    }

    db.prepare(
      "INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, author, department) VALUES('delete', ?, ?, ?, ?, ?, ?)",
    ).run(row.rowid, row.title ?? '', row.content, row.tags ?? '', row.author ?? '', row.department ?? '');

    db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(row.rowid));

    db.prepare('DELETE FROM memories WHERE id = ?').run(id);

    return true;
  });

  // P9-begin-immediate: READS (SELECT row) then WRITES (FTS/vec/row delete).
  // BEGIN IMMEDIATE so a concurrent writer makes this WAIT on busy_timeout
  // instead of throwing SQLITE_BUSY on the deferred-txn write upgrade.
  return remove.immediate();
}

export interface DeleteFilter {
  scope?: string;
  namespace?: string;
  department?: string;
  document_type?: string;
  before_date?: string;
  expired_only?: boolean;
}

/**
 * Build the shared WHERE clause for a DeleteFilter, or null when the filter is
 * empty (no conditions → a guard against an accidental delete-everything). Used
 * by both {@link deleteMemoriesByFilter} and {@link listMemoriesByFilter} so the
 * "what would this delete" preview and the delete itself never diverge.
 */
function filterToWhere(filter: DeleteFilter): { whereClause: string; params: unknown[] } | null {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(filter.namespace);
  }
  if (filter.department !== undefined) {
    conditions.push('department = ?');
    params.push(filter.department);
  }
  if (filter.document_type !== undefined) {
    conditions.push('document_type = ?');
    params.push(filter.document_type);
  }
  if (filter.before_date !== undefined) {
    conditions.push('created_at < ?');
    params.push(filter.before_date);
  }
  if (filter.expired_only) {
    conditions.push(`expires_at IS NOT NULL AND expires_at < ${NOW_ISO_SQL}`);
  }

  if (conditions.length === 0) return null;
  return { whereClause: conditions.join(' AND '), params };
}

/** The memories a DeleteFilter would match (for pre-delete propagation/events). */
export function listMemoriesByFilter(db: Database.Database, filter: DeleteFilter): MemoryRow[] {
  const where = filterToWhere(filter);
  if (!where) return [];
  return db
    .prepare<unknown[], MemoryRow>(`SELECT * FROM memories WHERE ${where.whereClause}`)
    .all(...where.params);
}

export function deleteMemoriesByFilter(
  db: Database.Database,
  filter: DeleteFilter,
): number {
  const remove = db.transaction(() => {
    const where = filterToWhere(filter);
    if (!where) {
      return 0;
    }
    const { whereClause, params } = where;

    const rows = db
      .prepare<unknown[], MemoryRow & { rowid: number }>(
        `SELECT rowid, * FROM memories WHERE ${whereClause}`,
      )
      .all(...params);

    if (rows.length === 0) {
      return 0;
    }

    const deleteFts = db.prepare(
      "INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, author, department) VALUES('delete', ?, ?, ?, ?, ?, ?)",
    );
    const deleteVec = db.prepare('DELETE FROM memories_vec WHERE rowid = ?');

    for (const row of rows) {
      deleteFts.run(
        row.rowid,
        row.title ?? '',
        row.content,
        row.tags ?? '',
        row.author ?? '',
        row.department ?? '',
      );
      deleteVec.run(BigInt(row.rowid));
    }

    const result = db
      .prepare(`DELETE FROM memories WHERE ${whereClause}`)
      .run(...params);

    return result.changes;
  });

  // P9-begin-immediate: READS (SELECT matching rows) then WRITES (bulk delete).
  // BEGIN IMMEDIATE so a concurrent writer makes this WAIT on busy_timeout
  // instead of throwing SQLITE_BUSY on the deferred-txn write upgrade.
  return remove.immediate();
}

/**
 * Invalidate a memory point-in-time: stamp `valid_to` instead of deleting it.
 * The row stays in `memories` (content untouched) and remains queryable via
 * `as_of`. COALESCE keeps the first invalidation instant, so re-invalidation is
 * idempotent and never pushes `valid_to` later. Returns rows changed.
 *
 * The default-now branch emits ISO-8601 with millis + Z (matching JS
 * toISOString() used for valid_from/created_at) so default `valid_to` collates
 * correctly against same-instant ISO timestamps in lexicographic `as_of`
 * comparisons — `datetime('now')`'s space separator would sort before `T`.
 */
export function invalidateMemory(
  db: Database.Database,
  id: string,
  validTo?: string,
): number {
  const result = db
    .prepare(
      `UPDATE memories SET valid_to = COALESCE(valid_to, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) WHERE id = ?`,
    )
    .run(validTo ?? null, id);

  // The memories_vec row is intentionally RETAINED on bitemporal invalidation so
  // an `as_of` point-in-time VECTOR search can still rank a now-retired fact that
  // was valid at the queried instant (persona P1). Every live-only raw
  // `embedding MATCH` consumer — hybridSearch (current mode), handleRelated,
  // detectConflicts, findNearDuplicates — filters retired rows by
  // valid_to/tx_expired/superseded_at, so the retained vec row never leaks into
  // current results. Only a HARD delete (deleteMemory / memory_forget hard) drops
  // the vec row; consolidate prunes retired vecs in bulk.
  return result.changes;
}

/**
 * Reinstate a soft-forgotten / invalidated memory — the inverse of
 * `invalidateMemory`. Clears BOTH bitemporal tombstone stamps (`valid_to`
 * valid-time end and `tx_expired` transaction-time end) so the row re-enters
 * currently-valid retrieval. The vec row was RETAINED on invalidation, so
 * clearing the stamps alone re-includes it everywhere live-row predicates run —
 * no re-embed needed. `superseded_at` is deliberately NOT cleared: a fact
 * retired by a contradicting supersession is reinstated through its
 * supersession chain, not un-tombstoned here. Returns rows changed.
 */
export function reinstateMemory(db: Database.Database, id: string): number {
  return db
    .prepare('UPDATE memories SET valid_to = NULL, tx_expired = NULL WHERE id = ?')
    .run(id).changes;
}

export function getMemoryById(
  db: Database.Database,
  id: string,
): MemoryRow | null {
  return (
    db.prepare<[string], MemoryRow>('SELECT * FROM memories WHERE id = ?').get(id) ??
    null
  );
}

export function getMemoryRowid(
  db: Database.Database,
  id: string,
): number | null {
  const row = db
    .prepare<[string], { rowid: number }>('SELECT rowid FROM memories WHERE id = ?')
    .get(id);
  return row ? Number(row.rowid) : null;
}

export function listMemories(
  db: Database.Database,
  options: ListOptions,
): { memories: MemoryRow[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(options.scope);
  }
  if (options.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(options.namespace);
  }
  if (options.department !== undefined) {
    conditions.push('department = ?');
    params.push(options.department);
  }
  if (options.document_type !== undefined) {
    conditions.push('document_type = ?');
    params.push(options.document_type);
  }

  // Bi-temporal: currently-valid by default; point-in-time when `as_of` is set.
  if (options.as_of) {
    conditions.push('valid_from <= ?');
    conditions.push('(valid_to IS NULL OR valid_to > ?)');
    conditions.push('(tx_expired IS NULL OR tx_expired > ?)');
    params.push(options.as_of, options.as_of, options.as_of);
  } else {
    conditions.push('valid_to IS NULL AND tx_expired IS NULL');
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const allowedSortFields = ['created_at', 'updated_at', 'title', 'importance_score', 'confidence_score', 'access_count'] as const;
  const sortField = allowedSortFields.includes(options.sort_by as typeof allowedSortFields[number])
    ? options.sort_by
    : 'created_at';
  const sortOrder = options.sort_order === 'asc' ? 'ASC' : 'DESC';

  const countRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM memories ${whereClause}`,
    )
    .get(...params);
  const total = countRow?.cnt ?? 0;

  const memories = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories ${whereClause} ORDER BY ${sortField} ${sortOrder} LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit, options.offset);

  return { memories, total };
}

export function rowToMemory(row: MemoryRow): Memory {
  let tags: string[] = [];
  if (row.tags) {
    try {
      const parsed: unknown = JSON.parse(row.tags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === 'string');
      }
    } catch {
      tags = [];
    }
  }

  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = null;
    }
  }

  return {
    id: row.id,
    scope: row.scope as Memory['scope'],
    namespace: row.namespace,
    title: row.title,
    content: row.content,
    document_type: row.document_type,
    source: row.source,
    author: row.author,
    department: row.department,
    tags,
    access_level: row.access_level as Memory['access_level'],
    language: row.language,
    metadata,
    parent_id: row.parent_id,
    chunk_index: row.chunk_index,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    importance_score: row.importance_score,
    confidence_score: row.confidence_score,
    provenance: (row.provenance as Memory['provenance']) ?? 'manual',
    agent_id: row.agent_id ?? null,
  };
}

// ── Access Tracking ──────────────────────────────────────────────────────

/**
 * Spaced-repetition reinforcement: each access grows a memory's `stability`
 * by this amount, so frequently-accessed memories forget more slowly under the
 * `e^(-Δt/stability)` retention curve (see {@link computeRetention}).
 */
export const STABILITY_INCREMENT = 0.5;

export function recordAccess(
  db: Database.Database,
  entries: AccessLogEntry[],
): void {
  if (entries.length === 0) return;

  const record = db.transaction(() => {
    const insertLog = db.prepare(`
      INSERT INTO memory_access_log (memory_id, access_type, query_text, result_rank, score, accessed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    const bumpAccess = db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed_at = datetime('now'),
          importance_score = MIN(1.0, importance_score + 0.03),
          stability = stability + ${STABILITY_INCREMENT}
      WHERE id = ?
    `);

    for (const entry of entries) {
      insertLog.run(
        entry.memory_id,
        entry.access_type,
        entry.query_text ?? null,
        entry.result_rank ?? null,
        entry.score ?? null,
      );
      bumpAccess.run(entry.memory_id);
    }
  });

  record();
}

// ── Quality Scoring ──────────────────────────────────────────────────────

export function updateQualityScores(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE memories SET
      importance_score = MIN(1.0, MAX(0.0,
        0.3 * importance_score +
        0.4 * MIN(1.0, CAST(access_count AS REAL) / MAX(
          (SELECT MAX(access_count) FROM memories WHERE parent_id IS NULL), 1
        )) +
        0.3 * CASE
          WHEN last_accessed_at IS NULL THEN 0.1
          WHEN julianday('now') - julianday(last_accessed_at) < 7 THEN 1.0
          WHEN julianday('now') - julianday(last_accessed_at) < 30 THEN 0.7
          WHEN julianday('now') - julianday(last_accessed_at) < 90 THEN 0.4
          ELSE 0.1
        END
      ))
    WHERE parent_id IS NULL
  `).run();

  return result.changes;
}

// ── Duplicate Detection ──────────────────────────────────────────────────

export function findNearDuplicates(
  db: Database.Database,
  embedding: Float32Array,
  distanceThreshold: number,
  limit: number,
  partition?: MemoryPartition,
): Array<{ rowid: number; id: string; distance: number }> {
  const find = db.transaction(() => {
    // Oversample when partitioned: cross-tenant rows occupy the nearest slots
    // and are then filtered out, so widen k to keep `limit` same-partition hits
    // (mirrors hybridSearch's post-filter-after-oversample pattern). Single-tenant
    // callers (no partition) keep the exact pre-fix k = limit.
    const k = partition ? Math.max(limit, 64) : limit;
    const rows = db
      .prepare<[Buffer, number], { rowid: number; distance: number }>(
        'SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance',
      )
      .all(Buffer.from(embedding.buffer), k);

    const results: Array<{ rowid: number; id: string; distance: number }> = [];
    for (const row of rows) {
      if (row.distance > distanceThreshold) break;
      if (results.length >= limit) break;
      // vec0 rows are only removed on hard delete, not on bi-temporal
      // invalidation (which just stamps valid_to / tx_expired). Exclude
      // invalidated rows here so every consumer (dedup, consolidation,
      // similarity edges) ignores tombstoned/superseded memories uniformly.
      const mem = db
        .prepare<[number], { id: string; valid_to: string | null; tx_expired: string | null; scope: string; namespace: string | null }>(
          'SELECT id, valid_to, tx_expired, scope, namespace FROM memories WHERE rowid = ?',
        )
        .get(Number(row.rowid));
      if (!mem || mem.valid_to !== null || mem.tx_expired !== null) continue;
      // Cross-tenant isolation: a candidate in a different (scope, namespace) is
      // never a near-duplicate/contradiction candidate for this write (battle-v7 H2).
      if (partition && (mem.scope !== partition.scope || (mem.namespace ?? null) !== (partition.namespace ?? null))) continue;
      results.push({ rowid: Number(row.rowid), id: mem.id, distance: row.distance });
    }
    return results;
  });

  return find();
}

// ── Ingest Source Tracking ───────────────────────────────────────────────

export function upsertIngestSource(
  db: Database.Database,
  record: IngestSourceRecord,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO ingest_source_tracking
      (id, source_path, source_hash, memory_id, chunk_ids, content_length, ingested_at, last_checked_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.source_path,
    record.source_hash,
    record.memory_id,
    record.chunk_ids,
    record.content_length,
    record.ingested_at,
    record.last_checked_at,
    record.status,
  );
}

export function getIngestSourceByPath(
  db: Database.Database,
  sourcePath: string,
): IngestSourceRecord | null {
  return (
    db.prepare<[string], IngestSourceRecord>(
      'SELECT * FROM ingest_source_tracking WHERE source_path = ?',
    ).get(sourcePath) ?? null
  );
}
