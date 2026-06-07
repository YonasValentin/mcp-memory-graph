/**
 * battle-v15 EGR-1 / GT-1 / GT-3 — graph.json sidecar tenancy.
 *
 * The v14 structural multi-tenancy claim is "every consumer query filters by the
 * new (scope,namespace) column." exportGraph's MEMORY and LINK selects do, but
 * its ENTITY select did not — so writeGraphSidecar under a forced namespace wrote
 * EVERY tenant's entity names + mention_count (activity volume) into the pinned
 * tenant's git-committed .memory/graph.json (EGR-1/GT-1), and mergeGraphs
 * collapsed two legitimately-distinct per-namespace entities by normalized_name
 * alone (GT-3). These tests pin the namespace-scoped behaviour.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { exportGraph, mergeGraphs, type ExportedEntity } from '../../graph/graph-export.js';
import type { EgressPolicy } from '../../vault/writer.js';

type DB = ReturnType<typeof createTestDb>;

/** Insert a top-level memory + an entity it mentions, both in one namespace. */
function seed(db: DB, ns: string, memId: string, entId: string, entName: string, mentions = 1): void {
  db.prepare(
    `INSERT INTO memories (id, scope, namespace, content, document_type, created_at, updated_at, valid_from)
     VALUES (?, 'project', ?, ?, 'note', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(memId, ns, `mem ${entName}`);
  db.prepare(
    `INSERT INTO entities (id, name, normalized_name, type, mention_count, scope, namespace)
     VALUES (?, ?, ?, 'concept', ?, 'project', ?)`,
  ).run(entId, entName, entName.toLowerCase(), mentions, ns);
  db.prepare(`INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)`).run(memId, entId);
}

describe('exportGraph entity tenancy (EGR-1/GT-1)', () => {
  it('scopes entities to the namespace, leaking no foreign tenant entity names or mention_count', () => {
    const db = createTestDb();
    seed(db, 'alpha', 'm-alpha', 'e-alpha', 'AlphaPublicThing', 2);
    seed(db, 'bravo', 'm-bravo', 'e-bravo', 'BravoConfidentialService', 99);

    const artifact = exportGraph(db, { namespace: 'alpha' });

    const names = artifact.entities.map((e) => e.name);
    expect(names).toContain('AlphaPublicThing');
    // The core leak: bravo's confidential entity name + its 99 mention_count
    // must NOT appear in alpha's sidecar.
    expect(names).not.toContain('BravoConfidentialService');
    expect(artifact.entities.every((e) => e.mention_count !== 99)).toBe(true);
  });

  it('unforced (single-user, no namespace) still exports the whole entity graph', () => {
    const db = createTestDb();
    seed(db, 'alpha', 'm-alpha', 'e-alpha', 'AlphaThing', 1);
    seed(db, 'bravo', 'm-bravo', 'e-bravo', 'BravoThing', 1);

    const artifact = exportGraph(db, {}); // no namespace → whole graph
    const names = artifact.entities.map((e) => e.name).sort();
    expect(names).toEqual(['AlphaThing', 'BravoThing']);
  });

  it('emits namespace on each exported entity so the artifact is self-describing', () => {
    const db = createTestDb();
    seed(db, 'alpha', 'm-alpha', 'e-alpha', 'AlphaThing', 1);
    const artifact = exportGraph(db, { namespace: 'alpha' });
    expect(artifact.entities[0]?.namespace).toBe('alpha');
  });

  it('rebattle: keeps an entity referenced only by an ingested CHILD chunk when egress drops an unrelated memory', () => {
    const db = createTestDb();
    // Public parent doc + a child chunk that is the SOLE mention of entity E.
    db.prepare(
      `INSERT INTO memories (id, scope, namespace, content, access_level, created_at, updated_at, valid_from)
       VALUES ('parent-1', 'project', '', 'parent doc', 'public', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO memories (id, scope, namespace, content, access_level, parent_id, chunk_index, created_at, updated_at, valid_from)
       VALUES ('child-1', 'project', '', 'chunk mentioning PgChunkEntity', 'public', 'parent-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO entities (id, name, normalized_name, type, mention_count, scope, namespace)
       VALUES ('e-pg', 'PgChunkEntity', 'pgchunkentity', 'concept', 1, 'project', '')`,
    ).run();
    db.prepare(`INSERT INTO memory_entities (memory_id, entity_id) VALUES ('child-1', 'e-pg')`).run();
    // An UNRELATED confidential memory that an egress cap will block (dropped=true).
    db.prepare(
      `INSERT INTO memories (id, scope, namespace, content, access_level, created_at, updated_at, valid_from)
       VALUES ('secret-1', 'project', '', 'unrelated secret', 'confidential', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const egress: EgressPolicy = { max_access_level: 'public' };
    const artifact = exportGraph(db, {}, egress);
    // The child-chunk-only entity must survive (its parent was not blocked).
    expect(artifact.entities.map((e) => e.name)).toContain('PgChunkEntity');
  });
});

describe('mergeGraphs entity collapse keys on (normalized_name, namespace) (GT-3)', () => {
  const ent = (id: string, ns: string, mentions: number): ExportedEntity => ({
    id,
    name: 'PostgreSQL',
    normalized_name: 'postgresql',
    type: 'concept',
    mention_count: mentions,
    namespace: ns,
  });

  it('keeps two same-named entities that belong to DIFFERENT namespaces', () => {
    const a = { version: 1, memories: [], links: [], entities: [ent('e-acme', 'acme', 2)] };
    const b = { version: 1, memories: [], links: [], entities: [ent('e-globex', 'globex', 9)] };
    const merged = mergeGraphs(a, b);
    expect(merged.entities).toHaveLength(2);
    const ids = merged.entities.map((e) => e.id).sort();
    expect(ids).toEqual(['e-acme', 'e-globex']);
  });

  it('still collapses two same-named entities in the SAME namespace (git-team union)', () => {
    const a = { version: 1, memories: [], links: [], entities: [ent('e-devA', 'team', 2)] };
    const b = { version: 1, memories: [], links: [], entities: [ent('e-devB', 'team', 9)] };
    const merged = mergeGraphs(a, b);
    expect(merged.entities).toHaveLength(1);
    expect(merged.entities[0]?.mention_count).toBe(9); // higher mention_count wins
  });

  it('treats a legacy artifact with no namespace field as the shared partition', () => {
    const legacy: ExportedEntity = {
      id: 'e-legacy',
      name: 'Redis',
      normalized_name: 'redis',
      type: 'concept',
      mention_count: 3,
    } as ExportedEntity;
    const a = { version: 1, memories: [], links: [], entities: [legacy] };
    const b = { version: 1, memories: [], links: [], entities: [{ ...legacy, id: 'e-legacy2', mention_count: 5 }] };
    const merged = mergeGraphs(a, b);
    expect(merged.entities).toHaveLength(1);
    expect(merged.entities[0]?.mention_count).toBe(5);
  });
});
