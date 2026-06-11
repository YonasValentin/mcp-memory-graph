/**
 * F1b — MCP_API_NAMESPACE WRITE/read isolation across the REST of the
 * namespace-bearing tool surface.
 *
 * F1 closed memory_store. But memory_ingest, memory_session_note, and the three
 * core_memory tools (get/append/replace) all passed their bare parsed input to
 * their handlers too — so on a namespace-forced deployment a caller could still
 * write into (ingest/session_note/core_memory_append/replace) or read from
 * (core_memory_get) another namespace. Each of these schemas carries a top-level
 * `namespace`, so the fix is the same one withForcedNs (= scopeToNamespace) wrap
 * the read tools already use.
 *
 * (memory_import is intentionally NOT covered here: its schema has no top-level
 * namespace — the namespace lives per-item under `data[]` — so a withForcedNs
 * wrap is a no-op. Forcing imported items needs a per-item remap-or-reject
 * decision and is tracked as a separate follow-up.)
 *
 * Two complementary guards, mirroring tenancy-store.test.ts (F1):
 *  1. BEHAVIOUR — the parse->scopeToNamespace seam each registration uses must
 *     persist/read the FORCED namespace, overriding the caller value. Asserted
 *     via real row reads (the memories / core_memory tables).
 *  2. WIRING — server.ts must actually apply withForcedNs to every one of these
 *     registrations (createServer dispatch is smoke-only), pinned at the source
 *     level like embedder-single-source.test.ts (M1) and F1.
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
import {
  MemoryIngestSchema,
  MemorySessionNoteSchema,
  CoreMemoryAppendSchema,
  CoreMemoryGetSchema,
} from '../../schemas/index.js';
import { handleIngest } from '../../tools/ingest.js';
import { handleSessionNote } from '../../tools/session-note.js';
import { handleCoreMemoryGet, handleCoreMemoryAppend } from '../../tools/core-memory.js';

const prev = process.env.MCP_API_NAMESPACE;
afterEach(() => {
  if (prev === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prev;
});

const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());

function countInNamespace(db: Database.Database, ns: string): number {
  return (
    db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM memories WHERE namespace = ?')
      .get(ns)?.n ?? 0
  );
}

describe('write/read isolation under MCP_API_NAMESPACE (F1b)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    process.env.MCP_API_NAMESPACE = 'nsForced';
  });
  afterEach(() => {
    db?.close();
  });

  it('memory_ingest persists chunks under the forced namespace, not the caller value', async () => {
    await handleIngest(
      db,
      embedder,
      scopeToNamespace(
        MemoryIngestSchema.parse({
          content: 'A document long enough to chunk. '.repeat(40),
          namespace: 'callerNs',
        }),
      ),
    );
    expect(countInNamespace(db, 'nsForced')).toBeGreaterThan(0);
    expect(countInNamespace(db, 'callerNs')).toBe(0);
  });

  it('memory_session_note creates the session memory under the forced namespace', async () => {
    await handleSessionNote(
      db,
      embedder,
      scopeToNamespace(
        MemorySessionNoteSchema.parse({
          session_id: 's1-f1b',
          text: 'first note',
          namespace: 'callerNs',
        }),
      ),
    );
    const row = db
      .prepare<[string], { namespace: string | null }>(
        "SELECT namespace FROM memories WHERE source = 'session:s1-f1b'",
      )
      .get();
    expect(row?.namespace).toBe('nsForced');
  });

  it('core_memory_append writes the block under the forced namespace, and get reads it back', () => {
    handleCoreMemoryAppend(
      db,
      scopeToNamespace(
        CoreMemoryAppendSchema.parse({ scope: 'project', namespace: 'callerNs', text: 'core-block-text' }),
      ),
    );
    const row = db
      .prepare<[], { namespace: string }>('SELECT namespace FROM core_memory')
      .get();
    expect(row?.namespace).toBe('nsForced');

    // A get that asked for the caller namespace is forced to nsForced — where the
    // block actually lives — so it returns the appended content (read isolation).
    const got = handleCoreMemoryGet(
      db,
      scopeToNamespace(CoreMemoryGetSchema.parse({ scope: 'project', namespace: 'callerNs' })),
    );
    expect(JSON.stringify(got)).toContain('core-block-text');
  });
});

describe('server.ts wires every namespace-bearing tool through withForcedNs (F1b wiring guard)', () => {
  // Each of these write/read handlers carries a top-level namespace and must be
  // force-scoped on a namespace-forced deployment. The bare `parsed` form is the
  // pre-fix write/read-isolation leak.
  it.each([
    // store + ingest now also thread principalAccessCeiling() (RB-8); assert the
    // withForcedNs forcing MECHANISM, not the full arg list (the ceiling addition
    // is pinned by write-path-coverage-tripwire).
    'handleStore(getDb(), await getEmbedder(), withForcedNs(parsed)',
    'handleIngest(getDb(), await getEmbedder(), withForcedNs(parsed)',
    // session_note also threads principalAccessCeiling() (RB-8); assert the
    // withForcedNs forcing mechanism, not the full arg list.
    'handleSessionNote(getDb(), await getEmbedder(), withForcedNs(parsed)',
    'handleCoreMemoryGet(getDb(), withForcedNs(parsed))',
    'handleCoreMemoryAppend(getDb(), withForcedNs(parsed))',
    'handleCoreMemoryReplace(getDb(), withForcedNs(parsed))',
  ])('registration force-scopes: %s', (expected) => {
    const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts');
    const src = readFileSync(serverSrc, 'utf8');
    expect(src).toContain(expected);
  });
});
