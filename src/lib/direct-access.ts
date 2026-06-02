import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { initializeSchema, CURRENT_SCHEMA_VERSION } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import { TransformersEmbeddingProvider } from '../embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../embeddings/cache.js';
import type { EmbeddingProvider } from '../types.js';

let cachedEmbedder: EmbeddingProvider | null = null;

function readSchemaVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
    return row ? Number(row.value) : 0;
  } catch {
    // schema_meta table absent → uninitialized DB.
    return 0;
  }
}

/**
 * Opens the database for READ-ONLY consumers (hook scripts, CLI queries,
 * backup, graph export). It must NOT mutate the schema: if the DB is below the
 * current schema version it throws rather than silently migrating — migration
 * is exclusively {@link getReadWriteDb}'s job. This prevents a "read-only"
 * command (e.g. `backup`) from ALTERing the very DB it is snapshotting.
 */
export function getReadOnlyDb(): Database.Database {
  const db = getDatabase();
  const version = readSchemaVersion(db);
  if (version < CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema is v${version}, below the required v${CURRENT_SCHEMA_VERSION}. ` +
        'Read-only access will not migrate it — run a read-write command first ' +
        '(e.g. `memory migrate`, `memory init`, or start the server).',
    );
  }
  return db;
}

/**
 * Opens the database, initializes the schema, and runs pending migrations.
 * This is the ONLY accessor permitted to mutate the schema.
 */
export function getReadWriteDb(): Database.Database {
  const db = getDatabase();
  initializeSchema(db);
  runMigrations(db);
  return db;
}

/**
 * Returns a ready-to-use embedding provider. The model is loaded lazily on
 * the first call and cached for the lifetime of the process.
 *
 * Coverage note: the actual transformer model is loaded from the network/
 * disk on first call; integration tests cover this path in CI's heavyweight
 * lane. Unit tests inject a `MockEmbeddingProvider` instead. The body is
 * excluded from coverage because invoking it requires the real HF model.
 */
/* c8 ignore start */
export async function getEmbedder(): Promise<EmbeddingProvider> {
  if (cachedEmbedder) {
    return cachedEmbedder;
  }

  const inner = new TransformersEmbeddingProvider();
  await inner.initialize();
  cachedEmbedder = new CachedEmbeddingProvider(inner);
  return cachedEmbedder;
}
/* c8 ignore stop */
