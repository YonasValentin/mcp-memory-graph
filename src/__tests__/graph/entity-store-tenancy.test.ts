/**
 * Multi-tenancy v14 — write path stamps the owning-memory partition onto the
 * entity graph. Entity identity is (normalized_name, scope, namespace), so the
 * SAME concept name produces a SEPARATE row per tenant and mention_count is
 * per-tenant for free. scope='global'/ns='' is the cross-project shared bridge.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { findOrCreateEntity, storeExtractedEntities } from '../../graph/entity-store.js';
import { insertMemory } from '../../db/repository.js';
import type { MemoryRow } from '../../types.js';
import type { ExtractedEntity } from '../../graph/entity-extractor.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function unit(i = 0): Float32Array {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
}
function row(id: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id, scope: 'global', namespace: null, title: id, content: `content ${id}`,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.7,
    ...over,
  };
}
const ent = (name: string, type = 'concept'): ExtractedEntity => ({
  name, type, confidence: 0.9,
});

describe('v14 write path — findOrCreateEntity stamps + keys on partition', () => {
  it('stamps scope/namespace on a new entity', () => {
    const id = findOrCreateEntity(db, 'PostgreSQL', 'tool', { scope: 'project', namespace: 'projA' });
    const e = db.prepare('SELECT scope, namespace FROM entities WHERE id = ?').get(id) as {
      scope: string;
      namespace: string;
    };
    expect(e).toEqual({ scope: 'project', namespace: 'projA' });
  });

  it('the SAME name in a DIFFERENT partition is a SEPARATE entity row', () => {
    const a = findOrCreateEntity(db, 'PostgreSQL', 'tool', { scope: 'project', namespace: 'projA' });
    const b = findOrCreateEntity(db, 'PostgreSQL', 'tool', { scope: 'project', namespace: 'projB' });
    expect(a).not.toBe(b);
    const count = db
      .prepare("SELECT COUNT(*) c FROM entities WHERE normalized_name = 'postgresql'")
      .get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('the SAME name in the SAME partition reuses the row and bumps mention_count', () => {
    const a = findOrCreateEntity(db, 'PostgreSQL', 'tool', { scope: 'project', namespace: 'projA' });
    const b = findOrCreateEntity(db, 'PostgreSQL', 'tool', { scope: 'project', namespace: 'projA' });
    expect(a).toBe(b);
    const mc = db.prepare('SELECT mention_count FROM entities WHERE id = ?').get(a) as {
      mention_count: number;
    };
    expect(mc.mention_count).toBe(2);
  });

  it('mention_count is per-tenant (one tenant cannot inflate another)', () => {
    findOrCreateEntity(db, 'redis', 'tool', { scope: 'project', namespace: 'projA' });
    findOrCreateEntity(db, 'redis', 'tool', { scope: 'project', namespace: 'projA' });
    findOrCreateEntity(db, 'redis', 'tool', { scope: 'project', namespace: 'projA' });
    const b = findOrCreateEntity(db, 'redis', 'tool', { scope: 'project', namespace: 'projB' });
    const mc = db.prepare('SELECT mention_count FROM entities WHERE id = ?').get(b) as {
      mention_count: number;
    };
    expect(mc.mention_count).toBe(1);
  });

  it('defaults to the global bridge partition when no partition is given', () => {
    const id = findOrCreateEntity(db, 'PostgreSQL', 'tool');
    const e = db.prepare('SELECT scope, namespace FROM entities WHERE id = ?').get(id) as {
      scope: string;
      namespace: string;
    };
    expect(e).toEqual({ scope: 'global', namespace: '' });
  });
});

describe('v14 write path — storeExtractedEntities threads partition end to end', () => {
  it('extracted entities + edges carry the owning memory partition', () => {
    insertMemory(db, row('m1', { scope: 'project', namespace: 'projA' }), unit());
    storeExtractedEntities(db, 'm1', [ent('PostgreSQL', 'tool'), ent('Redis', 'tool')], 'regex', {
      scope: 'project',
      namespace: 'projA',
    });
    const es = db.prepare('SELECT scope, namespace FROM entities').all() as Array<{
      scope: string;
      namespace: string;
    }>;
    expect(es.length).toBe(2);
    for (const e of es) expect(e).toEqual({ scope: 'project', namespace: 'projA' });

    const rels = db.prepare('SELECT scope, namespace FROM entity_relationships').all() as Array<{
      scope: string;
      namespace: string;
    }>;
    expect(rels.length).toBeGreaterThan(0);
    for (const r of rels) expect(r).toEqual({ scope: 'project', namespace: 'projA' });
  });

  it('two tenants extracting the same concept never share an entity row', () => {
    insertMemory(db, row('mA', { scope: 'project', namespace: 'projA' }), unit(0));
    insertMemory(db, row('mB', { scope: 'project', namespace: 'projB' }), unit(1));
    storeExtractedEntities(db, 'mA', [ent('Kafka', 'tool')], 'regex', { scope: 'project', namespace: 'projA' });
    storeExtractedEntities(db, 'mB', [ent('Kafka', 'tool')], 'regex', { scope: 'project', namespace: 'projB' });
    const count = db
      .prepare("SELECT COUNT(*) c FROM entities WHERE normalized_name = 'kafka'")
      .get() as { c: number };
    expect(count.c).toBe(2);
  });
});
