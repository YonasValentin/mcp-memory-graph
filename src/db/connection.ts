import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

let cachedDb: Database.Database | null = null;

/**
 * F3-sqlite-vec-teardown (P10/P14): live connections opened via createDatabase
 * are tracked so the process-exit handler can close survivors — leaving a
 * sqlite-vec connection open at exit can abort with "mutex lock failed" (134).
 *
 * Tracking is leak-free by construction: the test suite calls createDatabase
 * thousands of times (:memory:) and most callers never .close(), so we hold
 * only WeakRefs (an unclosed db stays GC-eligible) and a FinalizationRegistry
 * prunes the WeakRef once the GC reclaims a forgotten connection. Explicit
 * .close() deregisters immediately via the wrapper installed below.
 */
const openConnections = new Set<WeakRef<Database.Database>>();
/* c8 ignore start */
// The registry callback fires only when the GC reclaims a forgotten connection
// — not deterministically triggerable from a test (cf. the signal handlers below).
const connectionRefs = new FinalizationRegistry<WeakRef<Database.Database>>((ref) => {
  openConnections.delete(ref);
});
/* c8 ignore stop */

/**
 * Registers a connection for exit-time cleanup and wraps its `close()` so an
 * explicit close deregisters it (no strong reference retained, no leak). The
 * wrapper delegates to the original close, which is itself idempotent, so a
 * double-close stays safe.
 */
function trackConnection(db: Database.Database): void {
  const ref = new WeakRef(db);
  openConnections.add(ref);
  connectionRefs.register(db, ref, ref);

  const originalClose = db.close.bind(db);
  db.close = function patchedClose(this: Database.Database): Database.Database {
    openConnections.delete(ref);
    connectionRefs.unregister(ref);
    return originalClose();
  };
}

export function getDatabase(dbPath?: string): Database.Database {
  if (cachedDb) {
    return cachedDb;
  }

  const resolvedPath =
    dbPath ??
    process.env.MCP_MEMORY_DB_PATH ??
    /* c8 ignore next */
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
  trackConnection(db);
  return db;
}

export function closeDatabase(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
}

/**
 * Closes every still-open connection opened via createDatabase, then clears
 * tracking. Called from the exit handler so a CLI/battle script that forgot to
 * close (e.g. an early process.exit()) does not abort on native teardown.
 */
export function closeAllDatabases(): void {
  for (const ref of openConnections) {
    const db = ref.deref();
    if (db && db.open) {
      db.close();
    }
  }
  openConnections.clear();
}

/* c8 ignore start */
/** Test helper: number of live (not-yet-collected) tracked connections. */
export function trackedConnectionCount(): number {
  let count = 0;
  for (const ref of openConnections) {
    if (ref.deref()?.open) {
      count += 1;
    }
  }
  return count;
}
/* c8 ignore stop */

/* c8 ignore start */
// Process-lifetime signal handlers — fired by the runtime, not callable
// from tests. Excluded from coverage; behavior is verified by manual
// shutdown observation and CI's deploy/restart cycle.
function handleExit(): void {
  closeDatabase();
  closeAllDatabases();
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
/* c8 ignore stop */
