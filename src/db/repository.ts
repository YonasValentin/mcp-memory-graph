import type Database from 'better-sqlite3';
import type { Memory, MemoryRow, ListOptions, AccessLogEntry, IngestSourceRecord } from '../types.js';

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
        valid_from, valid_to, tx_expired
      ) VALUES (
        @id, @scope, @namespace, @title, @content, @document_type, @source,
        @author, @department, @tags, @access_level, @language, @metadata,
        @parent_id, @chunk_index, @version, @created_at, @updated_at, @expires_at,
        @access_count, @last_accessed_at, @importance_score, @confidence_score,
        @created_at, NULL, NULL
      )
    `);

    const result = stmt.run(memory);
    const rowid = BigInt(result.lastInsertRowid);

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

    for (const field of allowedFields) {
      if (field in updates) {
        setClauses.push(`${field} = ?`);
        params.push(updates[field]);
      }
    }

    setClauses.push('version = version + 1');
    setClauses.push("updated_at = datetime('now')");
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

    return updated;
  });

  return update();
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

  return remove();
}

export interface DeleteFilter {
  scope?: string;
  namespace?: string;
  department?: string;
  document_type?: string;
  before_date?: string;
  expired_only?: boolean;
}

export function deleteMemoriesByFilter(
  db: Database.Database,
  filter: DeleteFilter,
): number {
  const remove = db.transaction(() => {
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
      conditions.push("expires_at IS NOT NULL AND expires_at < datetime('now')");
    }

    if (conditions.length === 0) {
      return 0;
    }

    const whereClause = conditions.join(' AND ');

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

  return remove();
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
  };
}

// ── Access Tracking ──────────────────────────────────────────────────────

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
          importance_score = MIN(1.0, importance_score + 0.03)
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
): Array<{ rowid: number; id: string; distance: number }> {
  const find = db.transaction(() => {
    const rows = db
      .prepare<[Buffer, number], { rowid: number; distance: number }>(
        'SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance',
      )
      .all(Buffer.from(embedding.buffer), limit);

    const results: Array<{ rowid: number; id: string; distance: number }> = [];
    for (const row of rows) {
      if (row.distance > distanceThreshold) break;
      const mem = db
        .prepare<[number], { id: string }>('SELECT id FROM memories WHERE rowid = ?')
        .get(Number(row.rowid));
      if (mem) {
        results.push({ rowid: Number(row.rowid), id: mem.id, distance: row.distance });
      }
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
