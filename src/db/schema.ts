import type Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
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
      provenance_detail TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
    CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
    CREATE INDEX IF NOT EXISTS idx_memories_department ON memories(department);
    CREATE INDEX IF NOT EXISTS idx_memories_document_type ON memories(document_type);
    CREATE INDEX IF NOT EXISTS idx_memories_parent_id ON memories(parent_id);
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);
    CREATE INDEX IF NOT EXISTS idx_memories_scope_namespace ON memories(scope, namespace);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title,
      content,
      tags,
      author,
      department,
      content=memories,
      content_rowid=rowid
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      embedding float[384],
      scope TEXT,
      namespace TEXT
    );

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
      PRIMARY KEY (vault_path, file_path),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vault_sync_vault ON vault_sync_meta(vault_path);
    CREATE INDEX IF NOT EXISTS idx_vault_sync_memory ON vault_sync_meta(memory_id);

    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score);
    CREATE INDEX IF NOT EXISTS idx_memories_access_count ON memories(access_count);

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

    CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_at);
    CREATE INDEX IF NOT EXISTS idx_memories_condensation ON memories(condensation_level, importance_score, access_count);

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

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  const existing = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version');

  if (!existing) {
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      '4',
    );
  }
}
