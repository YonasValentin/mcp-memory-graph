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
      expires_at TEXT
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
      '1',
    );
  }
}
