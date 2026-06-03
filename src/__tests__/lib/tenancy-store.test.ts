/**
 * F1 — MCP_API_NAMESPACE WRITE isolation for memory_store.
 *
 * The 7 read/query MCP tools wrap their input in withForcedNs (= scopeToNamespace)
 * so a namespace-forced deployment overrides any caller namespace. The write path
 * (server.ts memory_store -> handleStore) previously did NOT, so a caller could
 * persist a row under another namespace even though read isolation held — a
 * write-isolation leak (read isolation holds, write isolation leaks).
 *
 * Two complementary guards:
 *  1. BEHAVIOUR — the shared policy seam the fix uses (scopeToNamespace +
 *     handleStore) must persist the FORCED namespace, overriding the caller value
 *     when scoping is on, and keep the caller value when off. Asserted via a real
 *     row read (the same SELECT idIsInForcedNamespace uses) — observable storage,
 *     not the helper return. Mirrors lib/tenancy.test.ts.
 *  2. WIRING — server.ts memory_store must actually apply withForcedNs to its
 *     parsed input before handleStore. createServer's dispatch is smoke-only and
 *     loading the real embedder in a unit test is unsafe, so this pins the wiring
 *     at the source level, the same way embedder-single-source.test.ts (M1) does.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { scopeToNamespace } from '../../lib/tenancy.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { handleStore } from '../../tools/store.js';

const prev = process.env.MCP_API_NAMESPACE;
afterEach(() => {
  if (prev === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prev;
});

function storedNamespace(db: Database.Database, id: string): string | null {
  const row = db
    .prepare<[string], { namespace: string | null }>('SELECT namespace FROM memories WHERE id = ?')
    .get(id);
  return row ? row.namespace : null;
}

describe('memory_store write isolation under MCP_API_NAMESPACE (F1)', () => {
  let db: Database.Database;
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db?.close();
  });

  it('persists under the forced namespace, overriding the caller value, when scoping is on', async () => {
    process.env.MCP_API_NAMESPACE = 'nsForced';
    const stored = await handleStore(
      db,
      embedder,
      scopeToNamespace({ content: 'write isolation', scope: 'project', namespace: 'callerNs' }),
    );
    expect(storedNamespace(db, stored.memory.id)).toBe('nsForced');
  });

  it('keeps the caller namespace when scoping is off', async () => {
    delete process.env.MCP_API_NAMESPACE;
    const stored = await handleStore(
      db,
      embedder,
      scopeToNamespace({ content: 'no scoping', scope: 'project', namespace: 'callerNs' }),
    );
    expect(storedNamespace(db, stored.memory.id)).toBe('callerNs');
  });
});

describe('server.ts wires memory_store through withForcedNs (F1 wiring guard)', () => {
  it('the memory_store registration force-scopes its parsed input before handleStore', () => {
    const serverSrc = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../server.ts',
    );
    const src = readFileSync(serverSrc, 'utf8');
    // Isolate the memory_store registration block (up to the next "── N." marker).
    const start = src.indexOf("'memory_store',");
    expect(start).toBeGreaterThan(-1);
    const after = src.indexOf('── 2. memory_search', start);
    const block = src.slice(start, after === -1 ? undefined : after);
    // The write path must mirror the reads: handleStore receives withForcedNs(...)
    // wrapped input, never the bare parsed value (which leaks writes across
    // namespaces on a namespace-forced deployment).
    expect(block).toContain('handleStore(getDb(), await getEmbedder(), withForcedNs(parsed)');
  });
});
