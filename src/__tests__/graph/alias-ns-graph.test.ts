import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { handleGraph } from '../../tools/graph.js';
import { resolveToCanonicalName } from '../../graph/entity-store.js';
import { randomUUID } from 'node:crypto';

type DB = ReturnType<typeof createTestDb>;

/** Seed: a memory + a canonical entity + an alias "pg" -> that entity, all in ns. */
function seed(db: DB, ns: string, canonicalNorm: string): { entId: string; memId: string } {
  const memId = `mem-${ns}`;
  const entId = `ent-${ns}`;
  db.prepare(
    `INSERT INTO memories (id, scope, namespace, content, created_at, updated_at, valid_from)
     VALUES (?, 'project', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(memId, ns, `mem ${ns}`);
  db.prepare(
    `INSERT INTO entities (id, name, normalized_name, type, mention_count, scope, namespace)
     VALUES (?, ?, ?, 'tool', 3, 'project', ?)`,
  ).run(entId, canonicalNorm, canonicalNorm, ns);
  db.prepare(`INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)`).run(memId, entId);
  // Alias "pg" -> this tenant's canonical entity, stamped with the tenant ns (v14).
  db.prepare(
    `INSERT INTO entity_aliases (id, entity_id, alias, normalized_alias, source, scope, namespace)
     VALUES (?, ?, 'pg', 'pg', 'llm', 'project', ?)`,
  ).run(randomUUID(), entId, ns);
  return { entId, memId };
}

describe('ALIAS-NS — memory_graph alias resolution ignores forced namespace', () => {
  it('cross-tenant alias collision: tenant-b sees an EMPTY graph for its OWN alias', () => {
    const db = createTestDb();
    // tenant-a registers FIRST (so its row wins the global LIMIT 1 alias lookup).
    seed(db, 'tenant-a', 'postgres');     // a's "pg" -> "postgres"
    const b = seed(db, 'tenant-b', 'postgresql'); // b's "pg" -> "postgresql"

    // resolveToCanonicalName takes NO namespace. Global LIMIT 1 picks tenant-a's
    // canonical name ("postgres") even though we are forced to tenant-b.
    const canonical = resolveToCanonicalName(db, 'pg');
    console.log('resolveToCanonicalName("pg") =', canonical, '(b expects "postgresql")');

    // memory_graph forced to tenant-b, querying b's OWN alias "pg".
    const res = handleGraph(db, { entity: 'pg', depth: 1 }, 'tenant-b');
    console.log('tenant-b graph entities:', res.entities.map((e) => e.name));

    // Tenant-b SHOULD see its own PostgreSQL entity. If the alias resolves to
    // tenant-a's "postgres" globally, the ns-filtered selection finds nothing.
    const names = res.entities.map((e) => e.name);
    expect(names).toContain('postgresql'); // FAILS if alias mis-resolves cross-tenant
  });

  it('control: a single tenant (no collision) resolves its alias correctly', () => {
    const db = createTestDb();
    const b = seed(db, 'tenant-b', 'postgresql');
    const res = handleGraph(db, { entity: 'pg', depth: 1 }, 'tenant-b');
    expect(res.entities.map((e) => e.name)).toContain('postgresql');
  });
});
