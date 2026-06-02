import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleSearch } from '../../tools/search.js';

const embedder = new MockEmbeddingProvider();

/**
 * Personal (user-scoped) memories must not bleed into an unscoped query — which a
 * project/global search usually is. They surface only when scope='user' is asked
 * explicitly. Prevents a teammate's project recall from leaking private notes.
 */
describe('scope privacy — unscoped search excludes user scope', () => {
  it('omits user-scoped memories when no scope is given, includes them when scope=user', async () => {
    const db = createTestDb();
    await handleStore(db, embedder, { content: 'Project uses pgBouncer pooling', scope: 'project', namespace: 'acme' });
    await handleStore(db, embedder, { content: 'My personal standup time is 9:30', scope: 'user' });

    const unscoped = await handleSearch(db, embedder, { query: 'standup pooling notes', limit: 20 });
    const unscopedText = JSON.stringify(unscoped.results ?? []);
    expect((unscoped.results ?? []).length).toBeGreaterThan(0);
    expect(/standup|personal/i.test(unscopedText)).toBe(false); // private note must not leak
    expect(/pgbouncer|pooling/i.test(unscopedText)).toBe(true); // project note still found

    const asUser = await handleSearch(db, embedder, { query: 'standup pooling notes', scope: 'user', limit: 20 });
    const userText = JSON.stringify(asUser.results ?? []);
    expect(/standup|personal/i.test(userText)).toBe(true); // explicit scope=user returns it
  });
});
