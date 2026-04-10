import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 2,
    up: (db) => {
      db.exec(`
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
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      // ALTER TABLE doesn't support IF NOT EXISTS — use try/catch per column
      const addColumn = (sql: string) => {
        try { db.exec(sql); } catch { /* column already exists */ }
      };
      addColumn('ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0');
      addColumn('ALTER TABLE memories ADD COLUMN last_accessed_at TEXT');
      addColumn('ALTER TABLE memories ADD COLUMN importance_score REAL NOT NULL DEFAULT 0.5');
      addColumn('ALTER TABLE memories ADD COLUMN confidence_score REAL NOT NULL DEFAULT 0.5');

      db.exec(`

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
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      const addColumn = (sql: string) => {
        try { db.exec(sql); } catch { /* column already exists */ }
      };

      // New columns on memories
      addColumn("ALTER TABLE memories ADD COLUMN superseded_at TEXT");
      addColumn("ALTER TABLE memories ADD COLUMN condensation_level TEXT NOT NULL DEFAULT 'full'");
      addColumn("ALTER TABLE memories ADD COLUMN condensed_at TEXT");
      addColumn("ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'manual'");
      addColumn("ALTER TABLE memories ADD COLUMN provenance_detail TEXT");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_at);
        CREATE INDEX IF NOT EXISTS idx_memories_condensation ON memories(condensation_level, importance_score, access_count);

        -- Entity tables
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

        -- Conflict tracking
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

        -- Original content preservation for condensation
        CREATE TABLE IF NOT EXISTS memory_originals (
          memory_id TEXT PRIMARY KEY NOT NULL,
          original_content TEXT NOT NULL,
          original_title TEXT,
          preserved_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version');

  const currentVersion = row ? parseInt(row.value, 10) : 0;

  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) {
    return;
  }

  const applyMigrations = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(
        String(migration.version),
        'schema_version',
      );
    }
  });

  applyMigrations();
}
