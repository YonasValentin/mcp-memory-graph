import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  // Version 1 is the initial schema created by schema.ts.
  // Future migrations go here:
  // { version: 2, up: (db) => { db.exec(`ALTER TABLE ...`); } },
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
