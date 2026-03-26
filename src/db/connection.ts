import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

let cachedDb: Database.Database | null = null;

export function getDatabase(dbPath?: string): Database.Database {
  if (cachedDb) {
    return cachedDb;
  }

  const resolvedPath =
    dbPath ??
    process.env.MCP_MEMORY_DB_PATH ??
    path.join(os.homedir(), '.mcp-memory', 'memory.db');

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  sqliteVec.load(db);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  cachedDb = db;
  return db;
}

/**
 * Creates a fresh database connection without caching.
 * Used by tests to get isolated in-memory databases.
 */
export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function closeDatabase(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
}

function handleExit(): void {
  closeDatabase();
}

process.on('exit', handleExit);
process.on('SIGINT', () => {
  handleExit();
  process.exit(0);
});
process.on('SIGTERM', () => {
  handleExit();
  process.exit(0);
});
