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
