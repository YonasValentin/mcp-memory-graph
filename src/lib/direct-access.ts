import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import { TransformersEmbeddingProvider } from '../embeddings/transformers.js';
import type { EmbeddingProvider } from '../types.js';

let cachedEmbedder: EmbeddingProvider | null = null;

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
 */
export async function getEmbedder(): Promise<EmbeddingProvider> {
  if (cachedEmbedder) {
    return cachedEmbedder;
  }

  const provider = new TransformersEmbeddingProvider();
  await provider.initialize();
  cachedEmbedder = provider;
  return cachedEmbedder;
}
