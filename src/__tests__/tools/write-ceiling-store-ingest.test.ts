/**
 * RBAC §6 write-path — RB-8 (12th + 13th instances). The write-path coverage
 * tripwire flagged store.ts and ingest.ts as the two fetch-then-mutate files that
 * are NOT caller-supplied-id reconciles. Auditing them proved both ceiling-blind:
 *
 *  • memory_store's conflict scan (detectConflicts / findNearDuplicates) partitions
 *    on (scope, namespace) ONLY — never access_level — and handleStore received no
 *    ceiling. So a sub-ceiling principal storing in their namespace could have an
 *    over-ceiling near-duplicate surfaced as a NOOP/UPDATE/DELETE target: retiring
 *    it (declassify-by-destruction), merging+echoing its content, or echoing it via
 *    NOOP. The access-level egress/destruction ceiling must gate the conflict scan.
 *
 *  • memory_ingest reconciles a prior ingest by source-path via
 *    getIngestSourceByPath, whose query is `WHERE source_path = ?` — namespace- AND
 *    ceiling-blind — and handleIngest received no ceiling. A re-ingest of a colliding
 *    source-path could handleUpdate + delete the chunks of a parent in ANOTHER
 *    namespace or above the caller's ceiling.
 *
 * These tests assert the FIXED invariant: a sub-ceiling / cross-namespace writer
 * leaves the protected row untouched and unechoed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import { handleIngest } from '../../tools/ingest.js';
import type { EmbeddingProvider } from '../../types.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';
import { principalAccessCeiling } from '../../lib/tenancy.js';

// Identical vector for everything → vectorSim ≈ 1; any second store with keyword
// overlap lands as a duplicate/superseded conflict, exercising the supersede path.
const sameVecEmbedder: EmbeddingProvider = {
  dimensions: 384,
  modelName: 'samevec',
  async initialize() {},
  isReady() {
    return true;
  },
  async embed() {
    const v = new Float32Array(384);
    v[0] = 1;
    return v;
  },
  async embedBatch(texts: string[]) {
    const v = new Float32Array(384);
    v[0] = 1;
    return texts.map(() => v);
  },
};

function key(maxAccessLevel: PrincipalContext['maxAccessLevel'], ns: string): PrincipalContext {
  return { principal: 'k', keyId: 'k1', namespaces: [ns], maxAccessLevel };
}

let db: Database.Database;
const prevEnv = process.env.MCP_API_NAMESPACE;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prevEnv;
});

function validTo(id: string): string | null {
  return (
    db
      .prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?')
      .get(id)?.valid_to ?? null
  );
}

describe('RB-8: memory_store conflict scan honours the principal access ceiling', () => {
  it('a sub-ceiling principal cannot retire/echo an over-ceiling same-namespace near-duplicate', async () => {
    process.env.MCP_API_NAMESPACE = 'ns1';

    // Seed a CONFIDENTIAL fact in ns1 (as a fully-cleared writer).
    const seeded = await handleStore(db, sameVecEmbedder, {
      content: 'Deploy uses Docker on production servers',
      scope: 'global',
      namespace: 'ns1',
      access_level: 'confidential',
    });
    expect(validTo(seeded.memory.id)).toBeNull(); // live

    // A principal capped at 'internal' tries to supersede it with near-identical
    // content. The conflict scan must NOT surface the confidential row.
    const ceiling = runWithPrincipal(key('internal', 'ns1'), () => principalAccessCeiling());
    expect(ceiling).toEqual(['public', 'internal']);

    // The attack content shares keywords (so detectConflicts fires) but is NOT a
    // superstring of the confidential fact, so any leak would have to come from the
    // protected row — not from the caller's own input being echoed back.
    const attackContent = 'Production servers run their workloads via Docker today';
    const result = await runWithPrincipal(key('internal', 'ns1'), () =>
      handleStore(
        db,
        sameVecEmbedder,
        {
          content: attackContent,
          scope: 'global',
          namespace: 'ns1',
          access_level: 'internal',
          on_conflict: 'supersede',
        },
        undefined,
        ceiling,
      ),
    );

    // (1) the confidential row is NOT retired (no declassify-by-destruction)
    expect(validTo(seeded.memory.id), 'confidential row must stay live').toBeNull();
    // (2) the response is the caller's OWN new row — not a NOOP/UPDATE echo of the
    //     over-ceiling row, and not carrying the protected fact's content.
    expect(result.memory.id, 'must not echo the over-ceiling row').not.toBe(seeded.memory.id);
    expect(result.memory.content, 'response must be the caller-supplied row').toBe(attackContent);
    expect(result.memory.content, 'must not leak confidential content').not.toContain(
      'Deploy uses Docker on production servers',
    );
  });

  it('full-clearance principal still dedups normally (no over-block)', async () => {
    process.env.MCP_API_NAMESPACE = 'ns1';
    const seeded = await handleStore(db, sameVecEmbedder, {
      content: 'Cache TTL is 60 seconds',
      scope: 'global',
      namespace: 'ns1',
      access_level: 'confidential',
    });
    const ceiling = runWithPrincipal(key('restricted', 'ns1'), () => principalAccessCeiling());
    // A cleared principal supersedes it → the old fact IS retired (normal behaviour).
    await runWithPrincipal(key('restricted', 'ns1'), () =>
      handleStore(
        db,
        sameVecEmbedder,
        {
          content: 'Cache TTL is 60 seconds exactly',
          scope: 'global',
          namespace: 'ns1',
          access_level: 'confidential',
          on_conflict: 'supersede',
        },
        undefined,
        ceiling,
      ),
    );
    expect(validTo(seeded.memory.id), 'cleared principal dedups normally').not.toBeNull();
  });
});

describe('RB-8: memory_ingest re-ingest is namespace- and ceiling-scoped', () => {
  it('a re-ingest of a colliding source-path cannot mutate a parent in another namespace', async () => {
    // First ingest tracked under source 'shared/doc.md' in nsA.
    const a = await handleIngest(db, sameVecEmbedder, {
      content: 'Alpha document body, first revision, several sentences of content here.',
      source: 'shared/doc.md',
      scope: 'global',
      namespace: 'nsA',
      access_level: 'confidential',
    });
    const aContentBefore = db
      .prepare<[string], { content: string }>('SELECT content FROM memories WHERE id = ?')
      .get(a.parent_id)?.content;

    // A writer forced to nsB re-ingests the SAME source-path. It must NOT reconcile
    // onto nsA's tracked parent (cross-tenant content overwrite + chunk deletion).
    process.env.MCP_API_NAMESPACE = 'nsB';
    await runWithPrincipal(key('confidential', 'nsB'), () =>
      handleIngest(
        db,
        sameVecEmbedder,
        {
          content: 'Beta totally different body that should never touch the alpha doc parent row.',
          source: 'shared/doc.md',
          scope: 'global',
          namespace: 'nsB',
          access_level: 'confidential',
        },
        principalAccessCeiling(),
      ),
    );

    const aContentAfter = db
      .prepare<[string], { content: string }>('SELECT content FROM memories WHERE id = ?')
      .get(a.parent_id)?.content;
    expect(aContentAfter, "nsA's parent must be untouched by an nsB re-ingest").toBe(aContentBefore);
    expect(validTo(a.parent_id), "nsA's parent must stay live").toBeNull();
  });
});
