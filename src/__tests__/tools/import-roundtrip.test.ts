import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExport } from '../../tools/export.js';
import { handleImport } from '../../tools/import.js';
import { MemoryImportSchema } from '../../schemas/index.js';

const embedder = new MockEmbeddingProvider();

/**
 * The no-lock-in promise: memory_export output must feed straight back into
 * memory_import (the backup/restore + migration path) without edits, and the
 * restore must be lossless — same id, original timestamps, and agent_id.
 */
describe('export -> import lossless round-trip (no-lock-in)', () => {
  it('accepts memory_export output verbatim (null optional fields) and imports it', async () => {
    const src = createTestDb();
    await handleStore(src, embedder, {
      content: 'Round-trip fact about Postgres pooling',
      title: 'RT',
      scope: 'global',
      tags: ['db', 'rt'],
      agent_id: 'agent-007',
    });
    const exported = handleExport(src, {});
    expect(exported.memories.length).toBe(1);

    // The export payload carries JSON null for absent optionals (source, author,
    // department, namespace, metadata, expires_at). The import schema must ACCEPT
    // that verbatim — this is exactly what server.ts does on a restore.
    const parsed = MemoryImportSchema.parse({ data: exported.memories, overwrite: false });

    const dst = createTestDb();
    const res = await handleImport(dst, embedder, parsed);
    expect(res.errors).toBe(0);
    expect(res.imported).toBe(1);
  });

  it('preserves id, original created_at/updated_at, and agent_id on restore', async () => {
    const src = createTestDb();
    await handleStore(src, embedder, {
      content: 'Another fact to round-trip with attribution',
      title: 'Attr',
      scope: 'global',
      agent_id: 'agent-42',
    });
    const orig = handleExport(src, {}).memories[0];

    const dst = createTestDb();
    await handleImport(
      dst,
      embedder,
      MemoryImportSchema.parse({ data: [orig], overwrite: false }),
    );
    const round = handleExport(dst, {}).memories[0];

    expect(round.id).toBe(orig.id);
    expect(round.created_at).toBe(orig.created_at);
    expect(round.updated_at).toBe(orig.updated_at);
    expect(round.agent_id).toBe('agent-42');
    expect(round.content).toBe(orig.content);
  });

  it('preserves an explicitly-set importance_score on restore (not recomputed)', async () => {
    const src = createTestDb();
    await handleStore(src, embedder, {
      content: 'A criticality-pinned runbook step that must keep its importance',
      title: 'Crit',
      scope: 'global',
      importance_score: 0.93,
    });
    const orig = handleExport(src, {}).memories[0];
    expect(orig.importance_score).toBe(0.93); // export carries it

    const dst = createTestDb();
    await handleImport(
      dst,
      embedder,
      MemoryImportSchema.parse({ data: [orig], overwrite: false }),
    );
    const round = handleExport(dst, {}).memories[0];

    // Without the fix, import recomputes importance via computeContentSignal and
    // silently drops the explicit 0.93 — a lossy backup/restore.
    expect(round.importance_score).toBe(0.93);
  });
});
