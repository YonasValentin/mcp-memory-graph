import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExtractEntities } from '../../tools/extract-entities.js';
import { handleGraph } from '../../tools/graph.js';

const embedder = new MockEmbeddingProvider();

/**
 * entity_aliases must be RESOLVED, not just written (persona P5).
 *
 * memory_extract_entities stored aliases and bumped aliases_added, but no read
 * path resolved an alias → entity: handleGraph matched entities.normalized_name
 * only. So a user who aliased 'PG'/'Postgres' → PostgreSQL still couldn't find
 * the entity by its alias. handleGraph now resolves a normalized alias to its
 * entity's canonical name (direct entity-name match still takes precedence).
 */
describe('memory_graph resolves entity aliases (ALIAS-1)', () => {
  it('looks up an entity by a registered alias', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'We run PostgreSQL as the primary database.' });
    handleExtractEntities(db, {
      memory_id: m.memory.id,
      entities: [{ name: 'PostgreSQL', type: 'tool', aliases: ['PG', 'Postgres'] }],
    });

    // Sanity: direct canonical-name lookup works.
    const direct = handleGraph(db, { entity: 'PostgreSQL', depth: 1, limit: 10 });
    expect(direct.entities.some((e) => e.name === 'PostgreSQL')).toBe(true);

    // The fix: alias lookups resolve to the same entity.
    for (const alias of ['PG', 'Postgres', 'postgres']) {
      const byAlias = handleGraph(db, { entity: alias, depth: 1, limit: 10 });
      expect(byAlias.entities.some((e) => e.name === 'PostgreSQL')).toBe(true);
    }
  });

  it('prefers a direct entity-name match over an alias collision', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'Go and Golang notes.' });
    // 'Go' is a real entity; 'go' is also registered as an alias of 'Golang'.
    handleExtractEntities(db, {
      memory_id: m.memory.id,
      entities: [
        { name: 'Go', type: 'tool' },
        { name: 'Golang', type: 'tool', aliases: ['go'] },
      ],
    });
    const res = handleGraph(db, { entity: 'Go', depth: 1, limit: 10 });
    // Direct name 'Go' wins; we do not silently redirect to Golang.
    expect(res.entities.some((e) => e.name === 'Go')).toBe(true);
  });
});
