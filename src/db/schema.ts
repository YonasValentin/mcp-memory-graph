import type Database from 'better-sqlite3';

/**
 * The current schema version baked into this codebase. Updated together with
 * a new entry in `runMigrations`.
 */
export const CURRENT_SCHEMA_VERSION = 13;

/**
 * Persistent memory-to-memory edge store (Pillar 1). Edges carry a confidence
 * tag (EXTRACTED | INFERRED | AMBIGUOUS) and a source_kind (wikilink |
 * co_occurrence | similarity | typed). Shared verbatim by {@link initializeSchema}
 * (fresh DBs) and migration v5 (existing DBs) so the two paths never diverge.
 * The bi-temporal validity columns (valid_from / valid_to / tx_expired, v6)
 * are baked in here for fresh DBs; migration v6 ALTERs them onto edges that
 * predate v6 (created_at is the transaction-created time, tx_created).
 */
export const MEMORY_LINKS_DDL = `
  CREATE TABLE IF NOT EXISTS memory_links (
    id TEXT PRIMARY KEY NOT NULL,
    source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'links_to',
    confidence TEXT NOT NULL DEFAULT 'INFERRED',
    confidence_score REAL NOT NULL DEFAULT 0.5,
    source_kind TEXT NOT NULL DEFAULT 'wikilink',
    evidence_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT,
    valid_from TEXT,
    valid_to TEXT,
    tx_expired TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mlinks_source ON memory_links(source_memory_id);
  CREATE INDEX IF NOT EXISTS idx_mlinks_target ON memory_links(target_memory_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mlinks_pair
    ON memory_links(source_memory_id, target_memory_id, relation);
`;

/**
 * MemGPT-style pinned "core memory" block per (scope, namespace) (Pillar 5).
 * A small, bounded, always-in-context text block the agent reads each session
 * and self-edits via tools — its working RAM, distinct from the large archival
 * memory store. The namespace uses '' as a sentinel when none, so the composite
 * (scope, namespace) primary key works without NULLs. Shared verbatim by
 * {@link initializeSchema} (fresh DBs) and migration v8 (existing DBs) so the
 * two paths never diverge.
 */
export const CORE_MEMORY_DDL = `
  CREATE TABLE IF NOT EXISTS core_memory (
    scope TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    char_limit INTEGER NOT NULL DEFAULT 2000,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scope, namespace)
  );
`;

/**
 * Active-infrastructure event bus (M3.1). `webhook_targets` are the registered
 * outbound sinks; `webhook_deliveries` is a crash-durable, bounded delivery
 * queue (one row per (event, target)) so a mutation that fires while the sink is
 * down is retried later instead of lost. Persisting the queue — rather than an
 * in-process buffer — is what makes the bus survive a restart on a single-file
 * local server. `secret` signs the HMAC-SHA256 body; `failure_count` +
 * `circuit_open_until` implement a per-target circuit breaker so one dead sink
 * never blocks the dispatcher. Shared verbatim by {@link initializeSchema}
 * (fresh DBs) and migration v11 (existing DBs) so the two paths never diverge.
 * The bus is OFF unless `MCP_WEBHOOKS=1` — these tables stay empty otherwise.
 */
export const WEBHOOKS_DDL = `
  CREATE TABLE IF NOT EXISTS webhook_targets (
    id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,
    events TEXT NOT NULL DEFAULT '*',
    scope TEXT,
    namespace TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    failure_count INTEGER NOT NULL DEFAULT 0,
    circuit_open_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_delivery_at TEXT
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL REFERENCES webhook_targets(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_target ON webhook_deliveries(target_id);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ready ON webhook_deliveries(status, next_attempt_at);
`;

/**
 * The embedding dimension the memories_vec virtual table is built against.
 * Sourced from MCP_MEMORY_DIMENSIONS or 384 (Xenova/all-MiniLM-L6-v2 default).
 * Mismatched embeddings against an existing DB throw on init — see
 * {@link assertDimensionConsistency}.
 */
export function configuredDimensions(): number {
  const raw = process.env.MCP_MEMORY_DIMENSIONS ?? '384';
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 8192) {
    throw new Error(
      `Invalid MCP_MEMORY_DIMENSIONS=${raw}. Expected an integer between 1 and 8192.`,
    );
  }
  return parsed;
}

interface TableInfoRow {
  name: string;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare<[string], TableInfoRow>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * Required columns on `memories` for the v4 schema. Any partial state where
 * the table exists but is missing one of these is treated as a legacy upgrade
 * and refused — `runMigrations` is the migration path.
 */
const V4_MEMORY_COLUMNS = [
  'id', 'scope', 'namespace', 'title', 'content', 'document_type', 'source',
  'author', 'department', 'tags', 'access_level', 'language', 'metadata',
  'parent_id', 'chunk_index', 'version', 'created_at', 'updated_at', 'expires_at',
  'access_count', 'last_accessed_at', 'importance_score', 'confidence_score',
  'superseded_at', 'condensation_level', 'condensed_at', 'provenance', 'provenance_detail',
];

function ensureV4MemoryColumns(db: Database.Database): void {
  const missing = V4_MEMORY_COLUMNS.filter((c) => !columnExists(db, 'memories', c));
  if (missing.length > 0) {
    throw new Error(
      `Database appears to be from a previous schema version: ` +
      `'memories' table is missing columns [${missing.join(', ')}]. ` +
      `This usually means the database was created by an older release. ` +
      `Run 'node dist/index.js migrate' to upgrade, or back up and recreate.`,
    );
  }
}

/**
 * Initializes a fresh DB or validates an existing one. Idempotent.
 * Behavior:
 *   - Empty DB: creates the full current schema and stamps schema_version=CURRENT.
 *   - Existing DB passing the v4 floor with NO schema_version row: stamps the
 *     verified floor (schema_version=4) so the caller's runMigrations applies
 *     v5–v9 and converges it with a fresh DB. (Never stamps CURRENT here — that
 *     would skip later migrations and brick the first write.)
 *   - DB at any partial/legacy state below v4: throws a clear error pointing at
 *     the `migrate` command. Never silently marks a partial DB as current.
 *   - DB with a different embedding_dim: throws (set MCP_MEMORY_DIMENSIONS to
 *     match the value stored in schema_meta).
 */
export function initializeSchema(db: Database.Database): void {
  // Always present after this call so the rest of the code can read it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  const dim = configuredDimensions();

  if (tableExists(db, 'memories')) {
    // Existing DB — validate, do not rewrite.
    ensureV4MemoryColumns(db);
    assertDimensionConsistency(db, dim);

    const versionRow = db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version');
    if (!versionRow) {
      // Schema_meta is fresh on an existing DB. We can only verify the v4 floor
      // (ensureV4MemoryColumns above), so stamp the verified floor (4) — NOT
      // CURRENT_SCHEMA_VERSION. The caller then runs runMigrations, which applies
      // v5–v9 to converge a true v4 DB with a fresh one. Stamping CURRENT here
      // would skip every later migration and brick the first write.
      db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        '4',
      );
    }
    return;
  }

  // Fresh DB — execute the full schema below.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      namespace TEXT,
      title TEXT,
      content TEXT NOT NULL,
      document_type TEXT,
      source TEXT,
      author TEXT,
      department TEXT,
      tags TEXT,
      access_level TEXT NOT NULL DEFAULT 'public',
      language TEXT NOT NULL DEFAULT 'en',
      metadata TEXT,
      parent_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
      chunk_index INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      importance_score REAL NOT NULL DEFAULT 0.5,
      confidence_score REAL NOT NULL DEFAULT 0.5,
      superseded_at TEXT,
      condensation_level TEXT NOT NULL DEFAULT 'full',
      condensed_at TEXT,
      provenance TEXT NOT NULL DEFAULT 'manual',
      provenance_detail TEXT,
      valid_from TEXT,
      valid_to TEXT,
      tx_expired TEXT,
      stability REAL NOT NULL DEFAULT 1.0,
      agent_id TEXT,
      content_hash TEXT,
      signature TEXT,
      pubkey TEXT,
      signed_at TEXT,
      revalidation_status TEXT,
      embedding_model TEXT,
      embedding_dim INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
    CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
    CREATE INDEX IF NOT EXISTS idx_memories_department ON memories(department);
    CREATE INDEX IF NOT EXISTS idx_memories_document_type ON memories(document_type);
    CREATE INDEX IF NOT EXISTS idx_memories_parent_id ON memories(parent_id);
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);
    CREATE INDEX IF NOT EXISTS idx_memories_scope_namespace ON memories(scope, namespace);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score);
    CREATE INDEX IF NOT EXISTS idx_memories_access_count ON memories(access_count);
    CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_at);
    CREATE INDEX IF NOT EXISTS idx_memories_condensation ON memories(condensation_level, importance_score, access_count);
    -- battle-v9 CLASS 3: at most ONE live session-note memory per source. The
    -- partial UNIQUE index is the cross-process backstop that stops two
    -- concurrent memory_session_note CREATEs from inserting duplicate session
    -- memories (the app then catches the UNIQUE error and appends instead).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_source_live ON memories(source)
      WHERE document_type = 'session' AND parent_id IS NULL
        AND valid_to IS NULL AND tx_expired IS NULL;

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title,
      content,
      tags,
      author,
      department,
      content=memories,
      content_rowid=rowid
    );
  `);

  // memories_vec uses a parameterized dimension; can't be in the static block above.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      embedding float[${dim}],
      scope TEXT,
      namespace TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY NOT NULL,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      title TEXT,
      metadata TEXT,
      version INTEGER NOT NULL,
      changed_by TEXT,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vault_sync_meta (
      vault_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      memory_id TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      content_hash TEXT,
      PRIMARY KEY (vault_path, file_path),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vault_sync_vault ON vault_sync_meta(vault_path);
    CREATE INDEX IF NOT EXISTS idx_vault_sync_memory ON vault_sync_meta(memory_id);

    CREATE TABLE IF NOT EXISTS memory_access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      access_type TEXT NOT NULL DEFAULT 'search',
      query_text TEXT,
      result_rank INTEGER,
      score REAL,
      accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_access_log_memory ON memory_access_log(memory_id);
    CREATE INDEX IF NOT EXISTS idx_access_log_accessed_at ON memory_access_log(accessed_at);

    CREATE TABLE IF NOT EXISTS ingest_source_tracking (
      id TEXT PRIMARY KEY NOT NULL,
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      chunk_ids TEXT,
      content_length INTEGER NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'current',
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_source_path ON ingest_source_tracking(source_path);
    CREATE INDEX IF NOT EXISTS idx_ingest_source_memory ON ingest_source_tracking(memory_id);

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'concept',
      description TEXT,
      mention_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_mention_count ON entities(mention_count DESC);

    CREATE TABLE IF NOT EXISTS entity_aliases (
      id TEXT PRIMARY KEY NOT NULL,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      source TEXT DEFAULT 'auto'
    );
    CREATE INDEX IF NOT EXISTS idx_alias_entity ON entity_aliases(entity_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_normalized ON entity_aliases(normalized_alias);

    CREATE TABLE IF NOT EXISTS entity_relationships (
      id TEXT PRIMARY KEY NOT NULL,
      source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'related_to',
      strength REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rel_source ON entity_relationships(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON entity_relationships(target_entity_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_pair_type ON entity_relationships(source_entity_id, target_entity_id, type);

    CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'mention',
      extracted_by TEXT DEFAULT 'regex',
      confidence REAL NOT NULL DEFAULT 0.5,
      PRIMARY KEY (memory_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_me_entity ON memory_entities(entity_id);
    CREATE INDEX IF NOT EXISTS idx_me_memory ON memory_entities(memory_id);

    CREATE TABLE IF NOT EXISTS memory_conflicts (
      id TEXT PRIMARY KEY NOT NULL,
      old_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      new_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      conflict_type TEXT NOT NULL DEFAULT 'superseded',
      description TEXT,
      resolved_at TEXT,
      resolved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conflict_old ON memory_conflicts(old_memory_id);
    CREATE INDEX IF NOT EXISTS idx_conflict_new ON memory_conflicts(new_memory_id);

    CREATE TABLE IF NOT EXISTS memory_originals (
      memory_id TEXT PRIMARY KEY NOT NULL,
      original_content TEXT NOT NULL,
      original_title TEXT,
      preserved_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
  `);

  // Memory-to-memory edge store (Pillar 1).
  db.exec(MEMORY_LINKS_DDL);

  // Pinned "core memory" block per (scope, namespace) (Pillar 5).
  db.exec(CORE_MEMORY_DDL);

  // Active-infrastructure event bus (M3.1) — empty unless MCP_WEBHOOKS=1.
  db.exec(WEBHOOKS_DDL);

  // Stamp the schema version + embedding dimension for future opens.
  const haveVersion = !!db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version');
  if (!haveVersion) {
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(CURRENT_SCHEMA_VERSION),
    );
  }
  const haveDim = !!db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('embedding_dim');
  if (!haveDim) {
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
      'embedding_dim',
      String(dim),
    );
  }
}

/**
 * Validate that the configured embedder dimension matches what the
 * memories_vec table was built for. Mismatches silently drop sqlite-vec
 * inserts later — fail loudly on open instead.
 */
export function assertDimensionConsistency(db: Database.Database, configured: number): void {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('embedding_dim');
  if (!row) {
    // Older DB that pre-dates the recorded dim — accept and stamp on next write.
    return;
  }
  const stored = parseInt(row.value, 10);
  if (Number.isFinite(stored) && stored !== configured) {
    throw new Error(
      `Embedding dimension mismatch: DB was built with float[${stored}] but ` +
      `MCP_MEMORY_DIMENSIONS=${configured}. Set MCP_MEMORY_DIMENSIONS=${stored} ` +
      `or rebuild the DB.`,
    );
  }
}
