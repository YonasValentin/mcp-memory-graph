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
