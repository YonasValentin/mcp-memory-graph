import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import { TransformersEmbeddingProvider } from '../embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../embeddings/cache.js';
import type { EmbeddingProvider } from '../types.js';

let embedderPromise: Promise<EmbeddingProvider> | null = null;

/**
 * Opens the database, initializes the schema, and runs pending migrations.
 * Intended for read-only consumers such as hook scripts and CLI queries.
 *
 * The underlying connection module caches the database handle, so repeated
 * calls return the same instance without re-opening.
 */
export function getReadOnlyDb(): Database.Database {
  const db = getDatabase();
  initializeSchema(db);
  runMigrations(db);
  return db;
}

/**
 * Opens the database, initializes the schema, and runs pending migrations.
 * Semantic alias for {@link getReadOnlyDb} -- the underlying connection is
 * identical, but the name communicates write intent to callers.
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
 * This is the SINGLE source of truth for production embedder construction
 * (M1): server.ts and cli/rebuild.ts both delegate here instead of building
 * their own provider. The in-flight Promise is memoized (not just the resolved
 * value) so concurrent first-use does not construct + initialize two models.
 *
 * Coverage note: the actual transformer model is loaded from the network/
 * disk on first call; integration tests cover this path in CI's heavyweight
 * lane. Unit tests inject a `MockEmbeddingProvider` instead. The body is
 * excluded from coverage because invoking it requires the real HF model.
 */
export function getEmbedder(): Promise<EmbeddingProvider> {
  if (!embedderPromise) {
    /* c8 ignore start */
    embedderPromise = (async () => {
      const inner = new TransformersEmbeddingProvider();
      await inner.initialize();
      return new CachedEmbeddingProvider(inner);
    })();
    /* c8 ignore stop */
  }
  return embedderPromise;
}
