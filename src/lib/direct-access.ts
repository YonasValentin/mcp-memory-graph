import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { initializeSchema, CURRENT_SCHEMA_VERSION } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import { TransformersEmbeddingProvider } from '../embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../embeddings/cache.js';
import type { EmbeddingProvider } from '../types.js';

let embedderPromise: Promise<EmbeddingProvider> | null = null;

function readSchemaVersion(db: Database.Database): number {
  let row: { value: string } | undefined;
  try {
    row = db
      .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
  } catch {
    // schema_meta table absent → uninitialized DB.
    return 0;
  }
  if (!row) return 0;
  // battle-v9 CLASS 5 (P11 parity): the migration path validates the recorded
  // version with /^\d+$/ and refuses a corrupt value; the read-only path coerced
  // it with Number(), so '12abc'→12 or '1e9'→1000000000 could masquerade as a
  // known schema and slip past the below-version guard. Apply the SAME check.
  if (!/^\d+$/.test(row.value)) {
    throw new Error(
      `Corrupt schema_version in schema_meta: '${row.value}'. Expected a canonical ` +
        `non-negative decimal integer. Refusing read-only access against an unknown ` +
        `schema; restore from backup or recreate the database.`,
    );
  }
  return Number(row.value);
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

/**
 * Disposes the process-wide memoized embedder (if one was constructed) and
 * clears the singleton so a later {@link getEmbedder} rebuilds it. For graceful
 * shutdown of long-running processes that hold the real model.
 *
 * BATTLE-V3 P14 caveat: disposal frees the onnxruntime session but does NOT
 * make an abrupt `process.exit()` safe — the native ORT worker still aborts
 * with `mutex lock failed` (exit 134) if the process is hard-exited. Scripts
 * that load the real embedder must let the event loop drain naturally (set
 * `process.exitCode`, never call `process.exit()`); `disposeEmbedder()` is the
 * graceful-shutdown release hook, not a force-exit fix.
 */
export async function disposeEmbedder(): Promise<void> {
  if (!embedderPromise) return;
  /* c8 ignore start -- real-embedder release path; getEmbedder above is likewise ignored */
  const pending = embedderPromise;
  embedderPromise = null;
  try {
    const embedder = await pending;
    await embedder.dispose?.();
  } catch {
    // A never-resolved (failed-init) embedder has nothing to release.
  }
  /* c8 ignore stop */
}
