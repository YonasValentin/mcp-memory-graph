import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleImport } from '../../tools/import.js';
import { handleExport } from '../../tools/export.js';

const embedder = new MockEmbeddingProvider();

/**
 * M2.7 — memory_import namespace forcing (REMAP).
 *
 * Unlike every other write tool, memory_import is NOT namespace-forced by the
 * server.ts withForcedNs wrap: each item carries its OWN namespace under data[],
 * so a top-level wrap is a no-op. That let a namespace-pinned deployment
 * (MCP_API_NAMESPACE set) import FOREIGN-namespace items — a tenancy escape.
 *
 * Decision = REMAP: when handleImport receives a forcedNamespace, every imported
 * item is relabeled to that namespace BEFORE insert, and the count of relabeled
 * items is surfaced as `remapped`.
 */
/**
 * Source-text wiring guard (F1b precedent): the handler-level tests above prove
 * the REMAP logic, but the tenancy escape is only ACTUALLY closed if server.ts
 * passes forcedNamespace() into handleImport. createServer is smoke-only (not
 * unit-tested), so a source tripwire is the regression net — a future refactor
 * that drops the 4th arg reverts the leak silently otherwise.
 */
describe('memory_import wiring guard (server.ts passes the forced namespace)', () => {
  it('the memory_import registration calls handleImport with forcedNamespace()', () => {
    const serverSrc = readFileSync(
      fileURLToPath(new URL('../../server.ts', import.meta.url)),
      'utf8',
    );
    expect(serverSrc).toContain('handleImport(getDb(), await getEmbedder(), parsed, forcedNamespace())');
    expect(serverSrc).toMatch(/forcedNamespace,?\s*\n\s*}\s*from '\.\/lib\/tenancy\.js'/);
  });
});

describe('memory_import namespace forcing (M2.7 — REMAP)', () => {
  // ── Phase 1: forcedNamespace set → foreign-ns items land in the forced ns ──
  it('remaps foreign-namespace items to the forced namespace and counts them', async () => {
    const db = createTestDb();
    const res = await handleImport(
      db,
      embedder,
      {
        data: [
          { content: 'Item from tenant-a', namespace: 'tenant-a' },
          { content: 'Item from tenant-b', namespace: 'tenant-b' },
          { content: 'Item with no namespace at all' },
        ],
        overwrite: false,
      },
      'tenant-forced',
    );

    expect(res.errors).toBe(0);
    expect(res.imported).toBe(3);
    // All three were relabeled (two foreign + one null → forced).
    expect(res.remapped).toBe(3);

    const rows = handleExport(db, {}).memories;
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.namespace).toBe('tenant-forced');
    }
    // No foreign namespace survived the import.
    const namespaces = new Set(rows.map(r => r.namespace));
    expect(namespaces).toEqual(new Set(['tenant-forced']));
  });

  // ── Phase 2: forcedNamespace set → even already-matching items reported ─────
  it('remaps items that already match the forced namespace (idempotent relabel)', async () => {
    const db = createTestDb();
    const res = await handleImport(
      db,
      embedder,
      {
        data: [{ content: 'Already in the forced ns', namespace: 'tenant-forced' }],
        overwrite: false,
      },
      'tenant-forced',
    );

    expect(res.imported).toBe(1);
    expect(res.remapped).toBe(1);
    expect(handleExport(db, {}).memories[0].namespace).toBe('tenant-forced');
  });

  // ── Phase 3: no forcedNamespace → per-item namespace preserved (current) ───
  it('preserves per-item namespace when no forced namespace is configured', async () => {
    const db = createTestDb();
    const res = await handleImport(
      db,
      embedder,
      {
        data: [
          { content: 'Item from tenant-a', namespace: 'tenant-a' },
          { content: 'Item from tenant-b', namespace: 'tenant-b' },
          { content: 'Item with no namespace' },
        ],
        overwrite: false,
      },
      // no forcedNamespace argument
    );

    expect(res.imported).toBe(3);
    // Nothing was relabeled.
    expect(res.remapped).toBe(0);

    const byContent = new Map(
      handleExport(db, {}).memories.map(r => [r.content, r.namespace ?? null]),
    );
    expect(byContent.get('Item from tenant-a')).toBe('tenant-a');
    expect(byContent.get('Item from tenant-b')).toBe('tenant-b');
    expect(byContent.get('Item with no namespace')).toBeNull();
  });

  // ── Phase 4: forced remap also rewrites the namespace of OVERWRITE updates ──
  it('remaps the namespace on an overwrite update of an existing memory', async () => {
    const db = createTestDb();
    // Seed an item that lives in the forced namespace.
    await handleImport(
      db,
      embedder,
      { data: [{ id: 'fixed-id', content: 'original', namespace: 'tenant-forced' }], overwrite: false },
      'tenant-forced',
    );

    // A foreign-namespace export tries to overwrite the same id; the remap must
    // keep it inside the forced namespace.
    const res = await handleImport(
      db,
      embedder,
      {
        data: [{ id: 'fixed-id', content: 'updated content', namespace: 'tenant-evil' }],
        overwrite: true,
      },
      'tenant-forced',
    );

    expect(res.imported).toBe(1);
    expect(res.remapped).toBe(1);
    const row = handleExport(db, {}).memories.find(r => r.id === 'fixed-id');
    expect(row?.namespace).toBe('tenant-forced');
    expect(row?.content).toBe('updated content');
  });
});
