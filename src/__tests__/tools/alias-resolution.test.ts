import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExtractEntities } from '../../tools/extract-entities.js';
import { handleGraph } from '../../tools/graph.js';
import {
  entityIdsByNameOrAlias,
  resolveToCanonicalName,
  normalizeName,
} from '../../graph/entity-store.js';
import { linkQueryEntities } from '../../search/hybrid.js';

const embedder = new MockEmbeddingProvider();

function entityId(db: ReturnType<typeof createTestDb>, normalized: string): string {
  return db
    .prepare<[string], { id: string }>('SELECT id FROM entities WHERE normalized_name = ?')
    .get(normalized)!.id;
}

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

/**
 * Alias resolution must reach the SEARCH/PPR seed path too (ALIAS-2/3), not just
 * memory_graph. `entityIdsByNameOrAlias` is the single source of alias→entity-id
 * resolution; `linkQueryEntities` (the use_graph / PageRank seed) consumes it so
 * a query naming only an alias still seeds the canonical entity. Direct
 * entity-name matches always win — an alias never shadows a real entity.
 */
describe('entityIdsByNameOrAlias — shared alias→entity resolver (ALIAS-2)', () => {
  it('resolves a registered alias and the canonical name to the same entity id', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'We run PostgreSQL as the primary database.' });
    handleExtractEntities(db, {
      memory_id: m.memory.id,
      entities: [{ name: 'PostgreSQL', type: 'tool', aliases: ['PG', 'Postgres'] }],
    });
    const pg = entityId(db, 'postgresql');

    expect(entityIdsByNameOrAlias(db, [normalizeName('PostgreSQL')])).toEqual([pg]);
    expect(entityIdsByNameOrAlias(db, [normalizeName('PG')])).toEqual([pg]);
    // Direct name + alias dedupe to one id.
    expect(entityIdsByNameOrAlias(db, [normalizeName('PostgreSQL'), normalizeName('Postgres')])).toEqual([pg]);
    // Unknown names resolve to nothing.
    expect(entityIdsByNameOrAlias(db, [normalizeName('Nonexistent')])).toEqual([]);
    // Empty in → empty out (no malformed SQL).
    expect(entityIdsByNameOrAlias(db, [])).toEqual([]);
  });

  it('resolveToCanonicalName follows an alias but a direct name wins', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'Go and Golang notes.' });
    handleExtractEntities(db, {
      memory_id: m.memory.id,
      entities: [
        { name: 'Go', type: 'tool' },
        { name: 'Golang', type: 'tool', aliases: ['go-lang'] },
      ],
    });
    // Alias resolves to the owner's canonical normalized_name.
    expect(resolveToCanonicalName(db, normalizeName('go-lang'))).toBe('golang');
    // A real entity name is never redirected.
    expect(resolveToCanonicalName(db, 'go')).toBe('go');
    // Unknown is returned unchanged.
    expect(resolveToCanonicalName(db, 'unknownthing')).toBe('unknownthing');
  });
});

describe('linkQueryEntities expands aliases for the graph seed (ALIAS-3)', () => {
  it('seeds the canonical entity when the query names only an alias', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, {
      content: 'We run PostgreSQL as the primary database.',
    });
    handleExtractEntities(db, {
      memory_id: m.memory.id,
      entities: [{ name: 'PostgreSQL', type: 'tool', aliases: ['PG'] }],
    });
    const pg = entityId(db, 'postgresql');

    // The query uses the ALIAS 'PG', never the canonical name.
    const seeds = linkQueryEntities(db, 'PG connection pool tuning');
    expect(seeds).toContain(pg);
  });
});
