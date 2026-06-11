/**
 * battle-v15 BYID-1 / BYID-2 / RT-1 — by-id tenancy residuals under MCP_API_NAMESPACE.
 *
 * BYID-1: memory_import REMAPs each item's own namespace + blocks foreign-id
 *   theft, but copied parent_id verbatim. A pinned tenant B could import a row
 *   whose parent_id points at tenant A's document → (a) B's content surfaces as
 *   a "chunk" of A's doc via memory_get(include_chunks), (b) A deleting the
 *   parent FK-cascades B's row away. Fix: under forcing, null any parent_id that
 *   doesn't resolve to a memory in the forced namespace; scope the chunk read to
 *   the parent's namespace too (defense-in-depth).
 * BYID-2: consolidate's access-log rotation DELETE was globally unscoped, so a
 *   tenant B run pruned tenant A's >90d access-log rows.
 * RT-1: memory_verify by-id lacked the idInForcedNs guard every other by-id read
 *   tool has — a cross-tenant existence + signed-integrity oracle. Source-level
 *   wiring guard (the createServer dispatch path is smoke-only).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleImport } from '../../tools/import.js';
import { handleGet } from '../../tools/get.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { handleStore } from '../../tools/store.js';

type DB = ReturnType<typeof createTestDb>;
const embedder = new MockEmbeddingProvider();

describe('BYID-1 — import parent_id cross-tenant injection', () => {
  it('nulls a parent_id that points at a foreign namespace when forcing is on', async () => {
    const db = createTestDb();
    // Tenant A document (unforced store).
    const aDoc = (await handleStore(db, embedder, { content: 'A parent doc', scope: 'project', namespace: 'tenantA' })).memory;

    // Tenant B imports a row whose parent_id steals A's document id.
    const res = await handleImport(
      db,
      embedder,
      { data: [{ content: 'INJECTED-BY-B', scope: 'project', namespace: 'evil', parent_id: aDoc.id }], overwrite: false },
      'tenantB', // forced namespace
    );
    expect(res.imported).toBe(1);

    // The imported row must live in tenantB with NO foreign parent edge.
    const injected = db
      .prepare<[], { id: string; namespace: string; parent_id: string | null }>(
        "SELECT id, namespace, parent_id FROM memories WHERE content = 'INJECTED-BY-B'",
      )
      .get();
    expect(injected?.namespace).toBe('tenantB');
    expect(injected?.parent_id).toBeNull();
  });

  it('memory_get(include_chunks) does not surface a foreign-namespace child as a chunk', async () => {
    const db = createTestDb();
    const aDoc = (await handleStore(db, embedder, { content: 'A parent doc', scope: 'project', namespace: 'tenantA' })).memory;
    // Force a hostile child row directly (simulating a pre-fix stored injection).
    db.prepare(
      `INSERT INTO memories (id, scope, namespace, content, parent_id, chunk_index, created_at, updated_at, valid_from)
       VALUES ('evil-child', 'project', 'tenantB', 'INJECTED', ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(aDoc.id);

    const got = handleGet(db, { id: aDoc.id, include_chunks: true });
    const chunkContents = (got?.chunks ?? []).map((c) => c.content);
    expect(chunkContents).not.toContain('INJECTED');
  });

  it('single-user import (no forcing) still honors a legitimate same-namespace parent_id', async () => {
    const db = createTestDb();
    const parent = (await handleStore(db, embedder, { content: 'doc', scope: 'project', namespace: 'proj' })).memory;
    const res = await handleImport(
      db,
      embedder,
      { data: [{ content: 'real chunk', scope: 'project', namespace: 'proj', parent_id: parent.id }], overwrite: false },
      undefined, // unforced
    );
    expect(res.imported).toBe(1);
    const child = db
      .prepare<[], { parent_id: string | null }>("SELECT parent_id FROM memories WHERE content = 'real chunk'")
      .get();
    expect(child?.parent_id).toBe(parent.id);
  });
});

describe('BYID-2 — consolidate access-log rotation is namespace-scoped', () => {
  it('a tenant B consolidate does not prune tenant A access-log rows', async () => {
    const db = createTestDb();
    const aMem = (await handleStore(db, embedder, { content: 'A mem', scope: 'project', namespace: 'tenantA' })).memory;
    // An aged (>90d) tenant-A access-log row.
    db.prepare(
      `INSERT INTO memory_access_log (memory_id, access_type, accessed_at) VALUES (?, 'get', '2000-01-01T00:00:00.000Z')`,
    ).run(aMem.id);

    const before = db.prepare<[string], { n: number }>(
      'SELECT COUNT(*) AS n FROM memory_access_log WHERE memory_id = ?',
    ).get(aMem.id);
    expect(before?.n).toBe(1);

    // Consolidate as tenant B (forced).
    await handleConsolidate(db, embedder, { dry_run: false, namespace: 'tenantB' });

    const after = db.prepare<[string], { n: number }>(
      'SELECT COUNT(*) AS n FROM memory_access_log WHERE memory_id = ?',
    ).get(aMem.id);
    expect(after?.n).toBe(1); // A's aged row survives B's consolidate
  });
});

describe('RT-1 — memory_verify by-id is namespace-forced (source wiring guard)', () => {
  const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts');
  const src = readFileSync(serverSrc, 'utf8');

  it('memory_verify registration carries the by-id ownership guard', () => {
    // Mirror memory_get: optional id, guard only when present. The §6 re-battle
    // close OR'd an `|| !idWithinCeiling(parsed.id)` clause into the SAME guard,
    // so assert the namespace substring (intact) not the pre-ceiling full line.
    expect(src).toContain('parsed.id && (!idInForcedNs(parsed.id)');
    // And the guard (namespace + ceiling) must appear in the memory_verify block.
    const verifyIdx = src.indexOf("instrument('memory_verify'");
    expect(verifyIdx).toBeGreaterThan(-1);
    // Window widened from 600 → 1000: the §6 ceiling close added explanatory
    // comments before the guard, pushing it past the old slice length.
    const block = src.slice(verifyIdx, verifyIdx + 1000);
    expect(block).toContain('idInForcedNs(parsed.id)');
    expect(block).toContain('idWithinCeiling(parsed.id)');
  });
});
