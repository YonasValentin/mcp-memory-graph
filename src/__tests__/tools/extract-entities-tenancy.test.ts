/**
 * v14 — the LLM-driven memory_extract_entities tool stamps the owning memory's
 * partition onto entities, relationships, AND aliases, so two tenants may both
 * register the same alias and neither sees the other's graph.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory } from '../../db/repository.js';
import { handleExtractEntities } from '../../tools/extract-entities.js';
import type { MemoryRow } from '../../types.js';

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

describe('v14 — handleExtractEntities stamps partition on entity + alias', () => {
  afterEach(() => {
    delete process.env.MCP_API_NAMESPACE;
  });

  it('SINGLE-USER (unforced): entities/aliases land in the shared partition', () => {
    insertMemory(db, row('m', { scope: 'project', namespace: 'projA' }), unit());
    handleExtractEntities(db, {
      memory_id: 'm',
      entities: [
        { name: 'PostgreSQL', type: 'tool', aliases: ['pg'] },
        { name: 'Acme', type: 'organization' },
      ],
      relationships: [{ source: 'PostgreSQL', target: 'Acme', type: 'used_by' as never }],
    });
    // G5: the graph partition is the forced namespace or '' — not the memory's ns.
    const es = db.prepare('SELECT DISTINCT namespace FROM entities').all() as Array<{ namespace: string }>;
    for (const e of es) expect(e.namespace).toBe('');
    const al = db.prepare("SELECT namespace FROM entity_aliases WHERE normalized_alias = 'pg'").get() as {
      namespace: string;
    };
    expect(al.namespace).toBe('');
  });

  it('MULTI-TENANT (forced): two tenants may both register the same alias (per-namespace unique)', () => {
    insertMemory(db, row('mA', { scope: 'project', namespace: 'tenant-a' }), unit(0));
    insertMemory(db, row('mB', { scope: 'project', namespace: 'tenant-b' }), unit(1));
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    const ra = handleExtractEntities(db, {
      memory_id: 'mA',
      entities: [{ name: 'PostgreSQL', type: 'tool', aliases: ['pg'] }],
    });
    process.env.MCP_API_NAMESPACE = 'tenant-b';
    const rb = handleExtractEntities(db, {
      memory_id: 'mB',
      entities: [{ name: 'PostgreSQL', type: 'tool', aliases: ['pg'] }],
    });
    expect(ra.aliases_added).toBe(1);
    expect(rb.aliases_added).toBe(1);
    const count = db.prepare("SELECT COUNT(*) c FROM entity_aliases WHERE normalized_alias = 'pg'").get() as {
      c: number;
    };
    expect(count.c).toBe(2);
    const ns = db
      .prepare("SELECT namespace FROM entity_aliases WHERE normalized_alias = 'pg' ORDER BY namespace")
      .all() as Array<{ namespace: string }>;
    expect(ns.map((r) => r.namespace)).toEqual(['tenant-a', 'tenant-b']);
  });
});
