/**
 * vault_search namespace override (footgun fix, session 14).
 *
 * handleVaultSearch searches the DB via hybridSearch, historically pinned to
 * `namespace = basename(vault_path)`. That silently returns nothing when the
 * caller's memories live in a namespace different from the vault folder name
 * (the common case after `memory_export_vault`, which writes a `<vault>/<ns>/`
 * subdir). These tests lock the new explicit `namespace`/`scope` override and
 * the unchanged basename default.
 *
 * Uses createTestDb + MockEmbeddingProvider + handleStore.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleVaultSearch } from '../../tools/vault-search.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

describe('handleVaultSearch — namespace override', () => {
  it('finds memories in an explicit namespace even when it differs from the vault folder name', async () => {
    await handleStore(db, embedder, {
      content: 'Postgres connection pooling via pgBouncer transaction mode.',
      title: 'Pooling',
      scope: 'project',
      namespace: 'acme-rocket',
    });

    // vault folder is named "vault" — basename would search ns "vault" (empty).
    const withOverride = await handleVaultSearch(db, embedder, {
      vault_path: '/tmp/some/vault',
      query: 'connection pooling',
      namespace: 'acme-rocket',
    });
    expect(withOverride.results.length).toBeGreaterThan(0);

    const withoutOverride = await handleVaultSearch(db, embedder, {
      vault_path: '/tmp/some/vault',
      query: 'connection pooling',
    });
    expect(withoutOverride.results.length).toBe(0);
  });

  it('defaults to the vault folder basename when no namespace is given (back-compat)', async () => {
    await handleStore(db, embedder, {
      content: 'Weather gating auto-holds a launch above 30 knots.',
      title: 'Weather',
      scope: 'project',
      namespace: 'mynotes',
    });

    const hit = await handleVaultSearch(db, embedder, {
      vault_path: '/home/me/mynotes',
      query: 'wind gating launch hold',
    });
    expect(hit.results.length).toBeGreaterThan(0);
  });
});
