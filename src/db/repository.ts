import type Database from 'better-sqlite3';
import type { Memory, MemoryRow, ListOptions, AccessLogEntry, IngestSourceRecord } from '../types.js';
import type { MemoryPartition } from '../graph/conflict-resolver.js';
import { NOW_ISO_SQL } from './predicates.js';
import {
  stripReservedVaultContainer,
  stripReservedVaultContainerFromJson,
} from '../vault/bookkeeping.js';
import { signEnvelope } from '../provenance/envelope.js';
import type { SignedEnvelope } from '../provenance/envelope.js';

/** Whether to attach a signed provenance envelope on write (M2.2, opt-in). */
function signingEnabled(): boolean {
  return process.env.MCP_SIGN_MEMORIES === '1' || process.env.MCP_SIGN_MEMORIES === 'true';
}

// ─── Shadow-index SQL helpers ────────────────────────────────────────────────
// The memories table has two shadow indexes — memories_fts (FTS5, external
// content) and memories_vec (vec0 KNN) — that MUST stay row-for-row consistent
// with it or search corrupts. The reindex SQL is hand-repeated across the write
// paths (insert / update / delete / bulk-delete). These helpers extract ONLY the
// byte-identical SQL string; every value (rowid, column values, scope/namespace)
// is a PARAMETER computed at the call site, so each site keeps its exact current
// bound values (e.g. one ftsDelete site passes raw column values, others pass
// `?? ''` — the helper does NOT inject defaults). Statements differing in SQL
// (updateMemory's `UPDATE memories_vec SET scope/namespace` re-scope path) and the
// surrounding ed25519 block (guard / valid_from / re-SELECT) are NOT folded in.

/** vec0 hard-delete of a row's KNN shadow. Callers pass `BigInt(rowid)`. */
/** vec0 shadow-removal SQL — shared so a bulk loop can prepare it once. */
const SQL_VEC_DELETE = 'DELETE FROM memories_vec WHERE rowid = ?';
/** FTS5 external-content `'delete'` shadow-removal SQL — shared for prepare-once reuse. */
const SQL_FTS_DELETE =
  "INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, author, department) VALUES('delete', ?, ?, ?, ?, ?, ?)";

function vecDelete(db: Database.Database, rowid: number | bigint): void {
  db.prepare(SQL_VEC_DELETE).run(rowid);
}

/** vec0 (re)index INSERT. Caller computes scope/namespace (e.g. `?? ''`/`|| ''`). */
function vecInsert(
  db: Database.Database,
  rowid: number | bigint,
  embedding: Float32Array,
  scope: string,
  namespace: string,
): void {
  db.prepare(
    'INSERT INTO memories_vec(rowid, embedding, scope, namespace) VALUES (?, ?, ?, ?)',
  ).run(rowid, Buffer.from(embedding.buffer), scope, namespace);
}

/** FTS5 (re)index INSERT. Caller passes the column values verbatim. */
function ftsInsert(
  db: Database.Database,
  rowid: number | bigint,
  title: string | null,
  content: string,
  tags: string | null,
  author: string | null,
  department: string | null,
): void {
  db.prepare(
    'INSERT INTO memories_fts(rowid, title, content, tags, author, department) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(rowid, title, content, tags, author, department);
}

/**
 * FTS5 external-content `'delete'` shadow-removal. Caller passes the SAME values
 * it would index, verbatim — the helper does NOT inject `?? ''`, so each site
 * keeps its exact bound params (one site passes raw column values, others `?? ''`).
 */
function ftsDelete(
  db: Database.Database,
  rowid: number | bigint,
  title: string | null,
  content: string,
  tags: string | null,
  author: string | null,
  department: string | null,
): void {
  db.prepare(SQL_FTS_DELETE).run(rowid, title, content, tags, author, department);
}

/**
 * Stamp the signed provenance envelope onto the row. This is ONLY the shared
 * 3-line UPDATE — the `signEnvelope(...)` call, the `wasSigned` guard, the
 * `valid_from` derivation, and the re-SELECT/return all differ between the
 * insert and update sites and are kept inline at each call site.
 */
function applySignature(db: Database.Database, env: SignedEnvelope, id: string): void {
  db.prepare(
    'UPDATE memories SET content_hash = ?, signature = ?, pubkey = ?, signed_at = ? WHERE id = ?',
  ).run(env.content_hash, env.signature, env.pubkey, env.signed_at, id);
}
// ─────────────────────────────────────────────────────────────────────────────

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
        valid_from, valid_to, tx_expired, agent_id,
        volatility, verification_tier, verification_detail
      ) VALUES (
        @id, @scope, @namespace, @title, @content, @document_type, @source,
        @author, @department, @tags, @access_level, @language, @metadata,
        @parent_id, @chunk_index, @version, @created_at, @updated_at, @expires_at,
        @access_count, @last_accessed_at, @importance_score, @confidence_score,
        @created_at, NULL, NULL, @agent_id,
        @volatility, @verification_tier, @verification_detail
      )
    `);

    const result = stmt.run({
      ...memory,
      agent_id: memory.agent_id ?? null,
      volatility: memory.volatility ?? null,
      verification_tier: memory.verification_tier ?? null,
      verification_detail: memory.verification_detail ?? null,
    });
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
      applySignature(db, env, memory.id);
    }

    vecInsert(db, rowid, embedding, memory.scope ?? '', memory.namespace ?? '');

    ftsInsert(
      db,
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
  // battle-v9 CLASS 3: optional optimistic-concurrency guard. When set, the
  // update is applied ONLY IF the row's version still equals expectedVersion
  // (re-checked INSIDE the immediate txn). A caller that read content/version
  // outside a lock (e.g. session_note's read-merge-append) passes the version it
  // based its merge on; a concurrent writer that bumped the version first makes
  // this return null so the caller re-reads and retries — no lost write. Default
  // (undefined) preserves the existing last-write-wins behaviour for all callers.
  expectedVersion?: number,
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

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      // CAS miss: the row changed since the caller read it. Signal a retry.
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
      'volatility',
      'verification_tier',
      'verification_detail',
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
      // Version snapshots are read back raw (memory_versions/history/forget) —
      // never let the `_vault` bookkeeping (absolute per-dev path) into them.
      stripReservedVaultContainerFromJson(existing.metadata),
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
      vecDelete(db, BigInt(existing.rowid));
      vecInsert(
        db,
        BigInt(existing.rowid),
        newEmbedding,
        (updates.scope ?? existing.scope) || '',
        (updates.namespace ?? existing.namespace) || '',
      );
    } else {
      // battle-v9 CLASS 5 — vec0 partition staleness. The block above rewrites the
      // memories_vec scope/namespace columns only when the CONTENT changed (it
      // re-embeds). But a scope/namespace change WITHOUT a content change — e.g.
      // memory_import's REMAP-on-overwrite, or a plain re-scope via memory_update —
      // left the vec0 partition columns pointing at the OLD tenant, so a
      // partitioned KNN (findNearDuplicates/related/hybrid) mis-located the row.
      // vec0 supports UPDATE of metadata columns (verified), so sync them here.
      const scopeChanged = updates.scope !== undefined && updates.scope !== existing.scope;
      const nsChanged = updates.namespace !== undefined && updates.namespace !== existing.namespace;
      if (scopeChanged || nsChanged) {
        db.prepare('UPDATE memories_vec SET scope = ?, namespace = ? WHERE rowid = ?').run(
          (updates.scope ?? existing.scope) || '',
          (updates.namespace ?? existing.namespace) || '',
          BigInt(existing.rowid),
        );
      }
    }

    ftsDelete(
      db,
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

    ftsInsert(
      db,
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
      applySignature(db, env, id);
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

    ftsDelete(db, row.rowid, row.title ?? '', row.content, row.tags ?? '', row.author ?? '', row.department ?? '');

    vecDelete(db, BigInt(row.rowid));

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
  /**
   * RBAC §6 (re-battle): a per-principal egress/integrity ceiling injected by
   * server.ts. A sub-ceiling principal's bulk delete must NOT destroy rows above
   * its clearance. Applied as a NARROWING `access_level IN (...)` predicate — it
   * can only REDUCE the doomed set, never widen it, and (critically) it does not
   * rescue an otherwise-empty filter past the delete-everything guard.
   */
  access_level_ceiling?: string[];
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

  // Delete-everything guard runs on the USER conditions ONLY: an empty filter is
  // null (no delete), and the ceiling below must never rescue it into a delete.
  if (conditions.length === 0) return null;

  // RBAC §6: the principal ceiling is a NARROWING restriction appended after the
  // guard — it shrinks the doomed set to rows at/below the caller's clearance.
  // No-op (undefined/empty) for legacy/local/full-clearance callers.
  if (filter.access_level_ceiling && filter.access_level_ceiling.length > 0) {
    conditions.push(`access_level IN (${filter.access_level_ceiling.map(() => '?').join(',')})`);
    params.push(...filter.access_level_ceiling);
  }
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

    // Prepare the two shadow-index DELETEs once and bind per row — better-sqlite3
    // does NOT cache by SQL string, so a per-row helper call (which re-prepares)
    // is ~3x slower on a bulk delete. SQL strings are the shared single source
    // (SQL_FTS_DELETE/SQL_VEC_DELETE), and the bound params (raw rowid + `?? ''`
    // FTS columns, BigInt for vec) match the ftsDelete/vecDelete helpers exactly.
    const deleteFts = db.prepare(SQL_FTS_DELETE);
    const deleteVec = db.prepare(SQL_VEC_DELETE);
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

/**
 * Bi-temporally invalidate a memory AND every descendant chunk (its parent_id
 * subtree) in one statement. Soft-forgetting an ingested PARENT document must
 * tombstone its child chunks too — each chunk carries its own embedding + FTS
 * row and is independently searchable, so leaving them live orphans the
 * "forgotten" document's content in recall (battle-v7 H5). COALESCE preserves
 * any valid_to already stamped on a row. For a childless memory this is exactly
 * invalidateMemory. Returns the number of rows whose valid_to was newly set.
 */
export function invalidateSubtree(db: Database.Database, id: string, validTo?: string): number {
  return db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM memories WHERE id = ?
         UNION ALL
         SELECT m.id FROM memories m JOIN sub ON m.parent_id = sub.id
       )
       UPDATE memories
         SET valid_to = COALESCE(valid_to, COALESCE(?, ${NOW_ISO_SQL}))
       WHERE id IN (SELECT id FROM sub) AND valid_to IS NULL`,
    )
    .run(id, validTo ?? null).changes;
}

/**
 * Inverse of {@link invalidateSubtree}: reinstate a memory AND every descendant
 * chunk into default recall (clears valid_to/tx_expired across the subtree), so
 * memory_restore brings a soft-forgotten ingested document back whole. For a
 * childless memory this is exactly reinstateMemory.
 */
export function reinstateSubtree(db: Database.Database, id: string): number {
  // Only revive rows tombstoned at-or-after the ROOT's own forget instant, so a
  // child chunk that was independently soft-forgotten BEFORE the parent (an
  // earlier valid_to, preserved by invalidateSubtree's COALESCE) stays tombstoned
  // on a parent restore (battle-v8 B4). If the root itself isn't tombstoned
  // (un-condense only), just clear it.
  const root = db
    .prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?')
    .get(id);
  if (!root || root.valid_to === null) {
    return db.prepare('UPDATE memories SET valid_to = NULL, tx_expired = NULL WHERE id = ?').run(id).changes;
  }
  return db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM memories WHERE id = ?
         UNION ALL
         SELECT m.id FROM memories m JOIN sub ON m.parent_id = sub.id
       )
       UPDATE memories SET valid_to = NULL, tx_expired = NULL
       WHERE id IN (SELECT id FROM sub) AND valid_to >= ?`,
    )
    .run(id, root.valid_to).changes;
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

/**
 * Resolve a full UUID OR an 8-char (4–35 char) hex short-id prefix to a single
 * memory id. The recall hooks surface `id.slice(0, 8)`, so this lets `memory_get`
 * accept the exact token the hooks advertise instead of demanding the full UUID.
 *
 * Exact match is tried first (fast path, byte-identical to prior behavior for
 * full ids). Only a hex-looking partial is treated as a prefix — never a LIKE on
 * arbitrary input — and the prefix scan is restricted to live, top-level rows.
 * Returns the full id, an `{ ambiguous }` list when a prefix hits >1 row, or null.
 */
export function resolveMemoryId(
  db: Database.Database,
  idOrPrefix: string,
): string | { ambiguous: string[] } | null {
  const exact = db
    .prepare<[string], { id: string }>('SELECT id FROM memories WHERE id = ?')
    .get(idOrPrefix);
  if (exact) return exact.id;

  // Guard the LIKE: only hex partials shorter than a full UUID are prefixes.
  if (!/^[0-9a-f]{4,35}$/i.test(idOrPrefix)) return null;

  const rows = db
    .prepare<[string], { id: string; title: string | null }>(
      `SELECT id, title FROM memories
       WHERE id LIKE ? AND parent_id IS NULL AND superseded_at IS NULL
         AND valid_to IS NULL AND tx_expired IS NULL
       LIMIT 6`,
    )
    .all(`${idOrPrefix}%`);

  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].id;
  return { ambiguous: rows.map((r) => `${r.id.slice(0, 8)} '${r.title ?? ''}'`) };
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
  // RBAC §6 egress ceiling — only rows at/below the principal's access level.
  if (options.access_level_ceiling && options.access_level_ceiling.length > 0) {
    conditions.push(
      `access_level IN (${options.access_level_ceiling.map(() => '?').join(',')})`,
    );
    params.push(...options.access_level_ceiling);
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
        // F-EXPORT-VAULTPATH chokepoint: strip ONLY the reserved `_vault`
        // container (an ABSOLUTE per-dev local path) here so EVERY tool-facing
        // read surface (get/export/list/search/related/update echo/…) is covered
        // at once — per-tool stripping diverges (battle-v9 lesson). The DB row
        // keeps `_vault`; vault sync reads raw rows, never through rowToMemory.
        // Deliberately NOT the full VAULT_BOOKKEEPING_KEYS set: the legacy flat
        // `vault_path`/`frontmatter` names are AMBIGUOUS with real user metadata
        // in plain (non-vault) usage, and hiding user data on every read is the
        // exact battle-v17 HIGH this branch exists to fix. Legacy flat residue
        // on pre-container vault rows still self-heals at the vault boundary
        // (writer/sync strip it) on the next export→sync cycle.
        const clean = stripReservedVaultContainer(parsed as Record<string, unknown>);
        metadata = Object.keys(clean).length > 0 ? clean : null;
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
    valid_from: row.valid_from ?? null,
    valid_to: row.valid_to ?? null,
    superseded_at: row.superseded_at ?? null,
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    importance_score: row.importance_score,
    confidence_score: row.confidence_score,
    provenance: (row.provenance as Memory['provenance']) ?? 'manual',
    agent_id: row.agent_id ?? null,
    volatility: (row.volatility as Memory['volatility']) ?? null,
    verification_tier: (row.verification_tier as Memory['verification_tier']) ?? null,
    verification_detail: row.verification_detail ?? null,
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

export interface SearchLogRecord {
  query: string;
  results_count: number;
  top_confidence?: number;
  scope?: string;
  namespace?: string;
  cwd?: string | null;
}

/**
 * Best-effort search telemetry (v15). One row per user-facing search — the raw
 * material for tenancy-scoped knowledge-gap detection in the dream cycle. Stores
 * the EFFECTIVE (scope, namespace) the search ran under (post scopeToNamespace /
 * forcedNamespace) so gaps partition like every other table. NEVER throws into
 * the search path: a telemetry failure (un-migrated DB, lock) must not fail a
 * user's search. Supersedes the pre-v15 ~/.mcp-memory/search-log.jsonl file.
 */
export function recordSearch(db: Database.Database, rec: SearchLogRecord): void {
  try {
    db.prepare(
      `INSERT INTO search_log (query, results_count, top_confidence, scope, namespace, cwd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      rec.query,
      rec.results_count,
      rec.top_confidence ?? null,
      rec.scope ?? 'global',
      rec.namespace ?? '',
      rec.cwd ?? null,
    );
  } catch {
    // Telemetry is best-effort — a log failure must never break a search.
  }
}

// ── Quality Scoring ──────────────────────────────────────────────────────

/**
 * Recompute importance from access patterns. battle-v9 CLASS 5: accepts an
 * optional scope/namespace filter clause (the `${clause}` shape buildFilterClause
 * produces — a leading ' AND …' or ''). When supplied (consolidate under
 * MCP_API_NAMESPACE forcing), BOTH the outer WHERE and the normalization
 * denominator subquery are constrained to the tenant, so a forced consolidate no
 * longer rewrites every tenant's importance_score (and the denominator isn't
 * skewed by another tenant's hottest row). Unfiltered (default) is unchanged.
 */
export function updateQualityScores(
  db: Database.Database,
  filterClause = '',
  filterParams: unknown[] = [],
): number {
  const result = db
    .prepare(`
    UPDATE memories SET
      importance_score = MIN(1.0, MAX(0.0,
        0.3 * importance_score +
        0.4 * MIN(1.0, CAST(access_count AS REAL) / MAX(
          (SELECT MAX(access_count) FROM memories WHERE parent_id IS NULL${filterClause}), 1
        )) +
        0.3 * CASE
          WHEN last_accessed_at IS NULL THEN 0.1
          WHEN julianday('now') - julianday(last_accessed_at) < 7 THEN 1.0
          WHEN julianday('now') - julianday(last_accessed_at) < 30 THEN 0.7
          WHEN julianday('now') - julianday(last_accessed_at) < 90 THEN 0.4
          ELSE 0.1
        END
      ))
    WHERE parent_id IS NULL${filterClause}
  `)
    // The subquery (inner) appears before the outer WHERE in the SQL, so its
    // params bind first; both use the same filter.
    .run(...filterParams, ...filterParams);

  return result.changes;
}

// ── Duplicate Detection ──────────────────────────────────────────────────

/**
 * vec0's HARD ceiling on `k` in a KNN query — a MATCH with k>4096 throws
 * "k value in knn query too large". An adaptive-widening cap must never exceed
 * this (battle-v9 rebattle-2 HIGH: capping at the raw partition count crashed
 * detectConflicts/findNearDuplicates — and memory_store's NLI path — on any
 * partition with >4096 vec rows). Past 4096 nearer retired rows in ONE partition,
 * starvation degrades BENIGNLY (no crash, no data loss); a complete fix needs a
 * non-vec0 scan path, deferred as a low-value tail (vec0 retains retired/chunk
 * rows, so a busy partition can reach this over years).
 */
export const VEC0_MAX_K = 4096;

/**
 * Count rows in memories_vec, optionally within a (scope, namespace) partition.
 * The upper bound for an adaptive-widening KNN cap (clamped to {@link VEC0_MAX_K}
 * by callers): widening k beyond the partition's row count can never surface a
 * new row. vec0 supports COUNT with a metadata filter (verified).
 */
export function vecRowCount(db: Database.Database, partition?: MemoryPartition): number {
  const row = partition
    ? db
        .prepare<[string, string], { c: number }>(
          'SELECT COUNT(*) AS c FROM memories_vec WHERE scope = ? AND namespace = ?',
        )
        .get(partition.scope, partition.namespace ?? '')
    : db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM memories_vec').get();
  return row?.c ?? 0;
}

export function findNearDuplicates(
  db: Database.Database,
  embedding: Float32Array,
  distanceThreshold: number,
  limit: number,
  partition?: MemoryPartition,
): Array<{ rowid: number; id: string; distance: number }> {
  const buf = Buffer.from(embedding.buffer);
  // Cross-tenant isolation (battle-v7 H2 / battle-v8 B1): when partitioned, push
  // the (scope, namespace) predicate INTO the vec0 KNN so the k nearest are the
  // k nearest SAME-tenant rows. memories_vec declares scope/namespace as
  // filterable metadata columns and insertMemory stores a null namespace as ''
  // — so a flood of foreign-tenant rows can NEVER starve a same-tenant candidate.
  const sql = partition
    ? 'SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? AND scope = ? AND namespace = ? ORDER BY distance'
    : 'SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance';
  const knn = db.prepare<unknown[], { rowid: number; distance: number }>(sql);
  const memStmt = db.prepare<
    [number],
    { id: string; valid_to: string | null; tx_expired: string | null }
  >('SELECT id, valid_to, tx_expired FROM memories WHERE rowid = ?');

  // battle-v9 item 13 — in-partition retired-row starvation. vec0 rows are
  // RETAINED on bi-temporal invalidation (as_of needs them) and vec0 can't filter
  // valid_to/tx_expired, so retired rows occupy the fixed-k window and the live
  // post-filter below could drop a still-live near-dup that sits just past k.
  // Widen k geometrically until we have `limit` LIVE rows, or the partition is
  // exhausted (vec0 returned < k), or all further rows exceed the distance
  // threshold, or k reaches the partition's TRUE row count (computed lazily only
  // when widening is actually needed — the common no-retired path satisfies
  // `limit` on the first pass, so no extra query/perf change). Capping at the
  // real row count (not an arbitrary 4096) means retired rows can NEVER starve a
  // live near-dup, regardless of how many there are (battle-v9 rebattle LOW).
  const GROWTH = 8;

  const find = db.transaction(() => {
    let k = Math.max(1, limit);
    let maxK: number | undefined; // lazily computed on the first widen
    let results: Array<{ rowid: number; id: string; distance: number }> = [];
    for (;;) {
      const rows = (
        partition ? knn.all(buf, k, partition.scope, partition.namespace ?? '') : knn.all(buf, k)
      ) as { rowid: number; distance: number }[];

      results = [];
      let hitThreshold = false;
      for (const row of rows) {
        if (row.distance > distanceThreshold) {
          // Sorted by distance — everything past here is farther, so a wider k
          // can't surface more in-threshold rows.
          hitThreshold = true;
          break;
        }
        const mem = memStmt.get(Number(row.rowid));
        if (!mem || mem.valid_to !== null || mem.tx_expired !== null) continue;
        results.push({ rowid: Number(row.rowid), id: mem.id, distance: row.distance });
        if (results.length >= limit) break;
      }

      if (results.length >= limit || hitThreshold || rows.length < k) break;
      // Clamp to vec0's hard k-ceiling so a >4096-row partition can't crash the
      // KNN (rebattle-2 HIGH); past that, retired-row starvation is benign.
      if (maxK === undefined) maxK = Math.min(vecRowCount(db, partition), VEC0_MAX_K);
      if (k >= maxK) break;
      k = Math.min(k * GROWTH, maxK);
    }
    return results.slice(0, limit);
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
      (id, source_path, source_hash, memory_id, chunk_ids, content_length, ingested_at, last_checked_at, status, namespace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    record.namespace ?? null,
  );
}

/**
 * RBAC (RB-8): the tracking row is looked up by (source_path, namespace) — the
 * source_path alone was globally unique, so a cross-namespace re-ingest could read
 * (and INSERT-OR-REPLACE clobber) another tenant's anchor. NULL namespace folds to
 * '' to match the unique index and the single-user path.
 */
export function getIngestSourceByPath(
  db: Database.Database,
  sourcePath: string,
  namespace: string | null = null,
): IngestSourceRecord | null {
  return (
    db.prepare<[string, string | null], IngestSourceRecord>(
      "SELECT * FROM ingest_source_tracking WHERE source_path = ? AND IFNULL(namespace, '') = IFNULL(?, '')",
    ).get(sourcePath, namespace) ?? null
  );
}
