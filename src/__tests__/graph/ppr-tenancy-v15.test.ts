/**
 * battle-v15 PPR-1 — the HippoRAG Personalized-PageRank path is the one shared-
 * graph-table reader v14 left un-namespaced. entityIdsByNameOrAlias (the seed
 * resolver), pagerank.buildGraph (reads the whole entity_relationships table)
 * and rankMemoriesByPPR's final memory join carried no namespace predicate, so a
 * forced tenant's graph walk interned foreign entities and ranked foreign
 * memories — only the unrelated downstream hybrid fetch filter stopped the
 * content reaching the caller. These tests make the PPR path namespace-consistent
 * with every other v14 consumer (defense-in-depth: a future refactor of the
 * fetch filter can no longer expose a foreign tenant's graph-reachable memories).
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { entityIdsByNameOrAlias } from '../../graph/entity-store.js';
import { rankMemoriesByPPR } from '../../graph/pagerank.js';

type DB = ReturnType<typeof createTestDb>;

/** Seed a memory + an entity it mentions + a relationship, all in one namespace. */
function seedTenant(db: DB, ns: string, suffix: string): { entId: string; memId: string } {
  const memId = `mem-${suffix}`;
  const entId = `ent-${suffix}`;
  const ent2Id = `ent2-${suffix}`;
  db.prepare(
    `INSERT INTO memories (id, scope, namespace, content, created_at, updated_at, valid_from)
     VALUES (?, 'project', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(memId, ns, `mem ${suffix}`);
  // Two same-NAME entities across tenants ('postgresql'), distinct per v14 identity.
  for (const [id, n] of [[entId, 'postgresql'], [ent2Id, 'redis']] as const) {
    db.prepare(
      `INSERT INTO entities (id, name, normalized_name, type, mention_count, scope, namespace)
       VALUES (?, ?, ?, 'concept', 3, 'project', ?)`,
    ).run(id, n, n, ns);
  }
  db.prepare(`INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)`).run(memId, entId);
  db.prepare(
    `INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, type, strength, evidence_count, scope, namespace)
     VALUES (?, ?, ?, 'co_occurs', 0.5, 2, 'project', ?)`,
  ).run(`rel-${suffix}`, entId, ent2Id, ns);
  return { entId, memId };
}

describe('PPR-1 — entityIdsByNameOrAlias namespace scoping', () => {
  it('returns only the forced namespace entity id for a name shared across tenants', () => {
    const db = createTestDb();
    const a = seedTenant(db, 'tenant-a', 'a');
    const b = seedTenant(db, 'tenant-b', 'b');

    // Unforced: both tenants' 'postgresql' entities resolve (single-user bridge).
    const unscoped = entityIdsByNameOrAlias(db, ['postgresql']);
    expect(unscoped.sort()).toEqual([a.entId, b.entId].sort());

    // Forced to tenant-a: only a's entity id.
    const scoped = entityIdsByNameOrAlias(db, ['postgresql'], 'tenant-a');
    expect(scoped).toEqual([a.entId]);
  });
});

describe('PPR-1 — rankMemoriesByPPR namespace scoping', () => {
  it('ranks only the forced namespace memories', () => {
    const db = createTestDb();
    const a = seedTenant(db, 'tenant-a', 'a');
    const b = seedTenant(db, 'tenant-b', 'b');

    // Seed PPR from BOTH tenants' entity ids (simulating an unfiltered seed) but
    // force the ranking to tenant-a: only a's memory may surface.
    const ranked = rankMemoriesByPPR(db, [a.entId, b.entId], { limit: 50, namespace: 'tenant-a' });
    const ids = ranked.map((r) => r.memory_id);
    expect(ids).toContain(a.memId);
    expect(ids).not.toContain(b.memId);
  });

  it('unforced ranks across namespaces (single-user graph bridge unchanged)', () => {
    const db = createTestDb();
    const a = seedTenant(db, 'tenant-a', 'a');
    const b = seedTenant(db, 'tenant-b', 'b');
    const ranked = rankMemoriesByPPR(db, [a.entId, b.entId], { limit: 50 });
    const ids = ranked.map((r) => r.memory_id);
    expect(ids).toContain(a.memId);
    expect(ids).toContain(b.memId);
  });
});
