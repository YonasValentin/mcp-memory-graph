import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';
import { handleForget } from '../../tools/forget.js';
import { registerWebhookTarget, countPendingDeliveries, getReadyDeliveries } from '../../events/store.js';

const embedder = new MockEmbeddingProvider();

/** Read the event_type of the most recent delivery. */
function lastEvent(db: Database.Database): string | undefined {
  return getReadyDeliveries(db, new Date().toISOString(), 100).at(-1)?.event_type;
}

describe('M3 mutation → event-bus wiring (real tool path)', () => {
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

  it('handleStore enqueues memory.created', async () => {
    await handleStore(db, embedder, { content: 'a durable fact about pgbouncer pooling', scope: 'project' });
    expect(countPendingDeliveries(db)).toBe(1);
    expect(lastEvent(db)).toBe('memory.created');
  });

  it('handleUpdate enqueues memory.updated', async () => {
    const r = await handleStore(db, embedder, { content: 'first version of the note', scope: 'project' });
    const before = countPendingDeliveries(db);
    await handleUpdate(db, embedder, { id: r.memory.id, content: 'second, edited version of the note' });
    expect(countPendingDeliveries(db)).toBe(before + 1);
    expect(lastEvent(db)).toBe('memory.updated');
  });

  it('handleForget soft enqueues memory.forgotten', async () => {
    const r = await handleStore(db, embedder, { content: 'a fact to forget later on', scope: 'project' });
    const before = countPendingDeliveries(db);
    handleForget(db, { id: r.memory.id });
    expect(countPendingDeliveries(db)).toBe(before + 1);
    expect(lastEvent(db)).toBe('memory.forgotten');
  });

  it('emits nothing when the bus is disabled', async () => {
    delete process.env.MCP_WEBHOOKS;
    await handleStore(db, embedder, { content: 'silent write, no events', scope: 'project' });
    expect(countPendingDeliveries(db)).toBe(0);
  });
});
