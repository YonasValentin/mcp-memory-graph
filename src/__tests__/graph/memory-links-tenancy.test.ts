/**
 * v14 — memory_links + memory_conflicts carry the partition of their endpoint
 * memories. Co-occurrence/typed edges never cross tenants: an edge whose
 * endpoints live in different namespaces is refused at the source, so a forced
 * tenant's graph walk can never hop to a foreign memory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory } from '../../db/repository.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { recordConflicts } from '../../graph/conflict-resolver.js';
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

describe('v14 — memory_links stamp + same-tenant constraint', () => {
  afterEach(() => {
    delete process.env.MCP_API_NAMESPACE;
  });

  it('an edge between two same-namespace memories carries that partition', () => {
    insertMemory(db, row('a', { scope: 'project', namespace: 'projA' }), unit(0));
    insertMemory(db, row('b', { scope: 'project', namespace: 'projA' }), unit(1));
    const id = createMemoryLink(db, { sourceId: 'a', targetId: 'b', relation: 'links_to' });
    expect(id).not.toBe('');
    const e = db.prepare('SELECT scope, namespace FROM memory_links WHERE id = ?').get(id) as {
      scope: string;
      namespace: string;
    };
    expect(e).toEqual({ scope: 'project', namespace: 'projA' });
  });

  it('refuses a cross-namespace edge UNDER A FORCED NAMESPACE (multi-tenant)', () => {
    process.env.MCP_API_NAMESPACE = 'projA';
    insertMemory(db, row('a', { scope: 'project', namespace: 'projA' }), unit(0));
    insertMemory(db, row('b', { scope: 'project', namespace: 'projB' }), unit(1));
    const id = createMemoryLink(db, { sourceId: 'a', targetId: 'b', relation: 'links_to' });
    expect(id).toBe('');
    const count = db.prepare('SELECT COUNT(*) c FROM memory_links').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('SINGLE-USER (unforced): links two SAME-namespace memories even if scope differs (vault round-trip regression)', () => {
    // A vault round-trip writes scope:global into frontmatter (writer.ts), so a
    // global-scope note and a project-scope note coexist in one vault namespace.
    // A [[wikilink]] between them is a legitimate user edge and must be created —
    // v14's original (scope AND namespace) guard wrongly dropped it.
    insertMemory(db, row('g', { scope: 'global', namespace: 'myvault' }), unit(0));
    insertMemory(db, row('p', { scope: 'project', namespace: 'myvault' }), unit(1));
    const id = createMemoryLink(db, { sourceId: 'g', targetId: 'p', sourceKind: 'wikilink' });
    expect(id).not.toBe('');
  });

  it('SINGLE-USER (unforced): does NOT refuse a cross-namespace edge (pre-v14 behaviour preserved)', () => {
    insertMemory(db, row('a', { scope: 'project', namespace: 'projA' }), unit(0));
    insertMemory(db, row('b', { scope: 'project', namespace: 'projB' }), unit(1));
    const id = createMemoryLink(db, { sourceId: 'a', targetId: 'b', sourceKind: 'wikilink' });
    expect(id).not.toBe('');
  });
});

describe('v14 — memory_conflicts stamp from the new memory', () => {
  it('a recorded conflict carries the new memory partition', () => {
    insertMemory(db, row('old', { scope: 'project', namespace: 'projA' }), unit(0));
    insertMemory(db, row('new', { scope: 'project', namespace: 'projA' }), unit(1));
    recordConflicts(
      db,
      [{ type: 'superseded', existing_memory_id: 'old', overlap_score: 0.9, description: 'x' }],
      'new',
    );
    const c = db.prepare('SELECT scope, namespace FROM memory_conflicts').get() as {
      scope: string;
      namespace: string;
    };
    expect(c).toEqual({ scope: 'project', namespace: 'projA' });
  });
});
