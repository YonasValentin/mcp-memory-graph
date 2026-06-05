/**
 * battle-v7 L4 (emission half) — every memory-mutating tool must enqueue a
 * webhook event, not just store/update/delete/forget.
 *
 * Before: ingest, import, condense, consolidate-merge, and restore mutated
 * memories via direct repository calls and emitted NOTHING, so a webhook
 * subscriber never heard about ingested documents, restored backups, dream-cycle
 * condensation/merges, or recoveries. (The autonomous delivery loop — the other
 * half of L4 — is covered by cli/webhook-dispatch-loop.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleIngest } from '../../tools/ingest.js';
import { handleImport } from '../../tools/import.js';
import { handleCondense, handleRestore } from '../../tools/condense.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { handleForget } from '../../tools/forget.js';
import { insertMemory } from '../../db/repository.js';
import { contextualizeForEmbedding } from '../../search/contextual.js';
import { registerWebhookTarget, countPendingDeliveries, getReadyDeliveries } from '../../events/store.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  process.env.MCP_WEBHOOKS = '1';
  registerWebhookTarget(db, { url: 'https://hooks.example.com/x' });
});
afterEach(() => {
  db.close();
  delete process.env.MCP_WEBHOOKS;
});

function events(): string[] {
  return getReadyDeliveries(db, new Date().toISOString(), 100).map((d) => d.event_type);
}

describe('M3 emission gaps — L4', () => {
  it('memory_ingest enqueues memory.created for a new document', async () => {
    await handleIngest(db, embedder, { content: 'A document long enough to chunk. '.repeat(40) });
    expect(countPendingDeliveries(db)).toBeGreaterThanOrEqual(1);
    expect(events()).toContain('memory.created');
  });

  it('memory_import enqueues memory.created per imported row', async () => {
    await handleImport(db, embedder, {
      data: [
        { content: 'imported fact one about caching', scope: 'project' },
        { content: 'imported fact two about pooling', scope: 'project' },
      ],
    });
    expect(events().filter((e) => e === 'memory.created').length).toBeGreaterThanOrEqual(2);
  });

  it('memory_condense enqueues memory.updated', async () => {
    const r = await handleStore(db, embedder, { content: 'A verbose fact that will be condensed into a short summary.' });
    const before = countPendingDeliveries(db);
    await handleCondense(db, embedder, {
      memories: [{ id: r.memory.id, summary: 'Short summary.' }],
      target_level: 'summary',
    });
    expect(countPendingDeliveries(db)).toBeGreaterThan(before);
    expect(events()).toContain('memory.updated');
  });

  it('memory_restore enqueues memory.updated', async () => {
    const r = await handleStore(db, embedder, { content: 'A fact to soft-forget then restore.' });
    handleForget(db, { id: r.memory.id }); // soft
    const before = countPendingDeliveries(db);
    await handleRestore(db, embedder, { id: r.memory.id });
    expect(countPendingDeliveries(db)).toBeGreaterThan(before);
    expect(events()).toContain('memory.updated');
  });

  it('a consolidate dedup-merge enqueues memory.deleted for the merged-away row', async () => {
    const a: MemoryRow = {
      id: 'mem-a', scope: 'project', namespace: 'ns', title: 'A',
      content: 'shared deduplication content for the merge stage.',
      document_type: null, source: null, author: null, department: null, tags: null,
      access_level: 'internal', language: 'en', metadata: null,
      parent_id: null, chunk_index: null, version: 1,
      created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
      access_count: 0, last_accessed_at: null, importance_score: 0.9, confidence_score: 0.8,
    };
    const ctxVec = await embedder.embed(
      contextualizeForEmbedding(a.content, { title: a.title, document_type: a.document_type, namespace: a.namespace }),
    );
    insertMemory(db, a, ctxVec);
    insertMemory(db, { ...a, id: 'mem-b', importance_score: 0.4, content: 'a wholly different secondary clause to append.' }, ctxVec);

    await handleConsolidate(db, embedder, { similarity_threshold: 0.5, max_operations: 10 });
    expect(events()).toContain('memory.deleted');
  });
});
