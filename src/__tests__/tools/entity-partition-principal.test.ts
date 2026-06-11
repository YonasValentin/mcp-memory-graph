/**
 * RBAC v1 §5 — entity-graph partition under a principal context. The graph's
 * tenant partition was `forcedNamespace() ?? ''`; under a principal that is
 * namespaces[0], which would CROSS-CONTAMINATE a multi-namespace key: storing
 * into namespaces[1] would land the row's entities in namespaces[0]'s graph
 * partition (visible to other keys pinned to namespaces[0] only). Principal
 * mode partitions by the OWNING ROW's namespace — already validated against
 * the key's set by scopeToNamespace / idInForcedNs upstream.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExtractEntities } from '../../tools/extract-entities.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';

const KEY: PrincipalContext = {
  principal: 'multi-bot',
  keyId: 'key-1',
  namespaces: ['sales', 'marketing'],
  maxAccessLevel: 'internal',
};

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
const prev = process.env.MCP_API_NAMESPACE;
beforeEach(() => {
  delete process.env.MCP_API_NAMESPACE;
  db = createTestDb();
});
afterEach(() => {
  db.close();
  if (prev === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prev;
});

function entityNamespaces(normalizedName: string): string[] {
  return (
    db
      .prepare<[string], { namespace: string }>(
        'SELECT namespace FROM entities WHERE normalized_name = ?',
      )
      .all(normalizedName)
  ).map((r) => r.namespace);
}

describe('store-time regex extraction partitions by the row namespace', () => {
  it('a write into the key’s SECOND namespace partitions entities there', async () => {
    await runWithPrincipal(KEY, () =>
      handleStore(db, embedder, {
        content: 'We moved the cache to Redis last sprint.',
        scope: 'project',
        namespace: 'marketing',
      }),
    );
    expect(entityNamespaces('redis')).toEqual(['marketing']);
  });

  it('a default-namespace write partitions to namespaces[0]', async () => {
    await runWithPrincipal(KEY, () =>
      handleStore(db, embedder, {
        content: 'Postgres is the system of record.',
        scope: 'project',
        // namespace omitted → scopeToNamespace upstream would force sales; here
        // we call the handler directly the way server.ts does post-forcing.
        namespace: 'sales',
      }),
    );
    expect(entityNamespaces('postgres')).toEqual(['sales']);
  });

  it('unscoped single-user behaviour unchanged: shared "" partition', async () => {
    await handleStore(db, embedder, {
      content: 'Docker hosts everything.',
      scope: 'project',
      namespace: 'projA',
    });
    expect(entityNamespaces('docker')).toEqual(['']);
  });
});

describe('memory_extract_entities partitions by the OWNING memory namespace', () => {
  it('LLM-extracted entities for a namespaces[1] memory land in that partition', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'quarterly plan', scope: 'project', namespace: 'marketing',
    });
    runWithPrincipal(KEY, () =>
      handleExtractEntities(db, {
        memory_id: stored.memory.id,
        entities: [{ name: 'Q3 Plan', type: 'concept' }],
      }),
    );
    expect(entityNamespaces('q3plan')).toEqual(['marketing']);
  });

  it('unscoped: extraction stays in the shared "" partition (unchanged)', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'roadmap', scope: 'project', namespace: 'projB',
    });
    handleExtractEntities(db, {
      memory_id: stored.memory.id,
      entities: [{ name: 'Roadmap 2027', type: 'concept' }],
    });
    expect(entityNamespaces('roadmap2027')).toEqual(['']);
  });
});
