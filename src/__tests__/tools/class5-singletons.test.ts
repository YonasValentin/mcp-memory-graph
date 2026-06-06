/**
 * battle-v9 CLASS 5 — singleton fixes (behavioral coverage for the testable ones).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import {
  insertMemory,
  updateMemory,
  updateQualityScores,
  findNearDuplicates,
} from '../../db/repository.js';
import { handleExport } from '../../tools/export.js';
import { handleImport } from '../../tools/import.js';
import { exportGraph } from '../../graph/graph-export.js';
import { storeExtractedEntities } from '../../graph/entity-store.js';
import { hardSplitContent } from '../../chunking/strategies.js';
import { runMigrations } from '../../db/migrations.js';
import { MemorySearchSchema } from '../../schemas/index.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
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

describe('CLASS 5 — updateMemory refreshes the vec0 partition on a namespace-only change', () => {
  it('a re-scope without content change relocates the row in partitioned KNN', () => {
    const id = randomUUID();
    insertMemory(db, row(id, { namespace: 'old' }), unit());
    // namespace-only update (no content change) — the import REMAP case.
    updateMemory(db, id, { namespace: 'new' });

    const probe = unit();
    expect(
      findNearDuplicates(db, probe, 2, 5, { scope: 'global', namespace: 'new' }).map((r) => r.id),
    ).toContain(id);
    expect(
      findNearDuplicates(db, probe, 2, 5, { scope: 'global', namespace: 'old' }).map((r) => r.id),
    ).not.toContain(id);
  });
});

describe('CLASS 5 — updateQualityScores confines its rewrite to the filtered tenant', () => {
  it('only the filtered namespace has its importance recomputed', () => {
    const recent = new Date().toISOString();
    const a = randomUUID();
    const b = randomUUID();
    insertMemory(db, row(a, { namespace: 'A', access_count: 10, last_accessed_at: recent }), unit(0));
    insertMemory(db, row(b, { namespace: 'B', access_count: 10, last_accessed_at: recent }), unit(1));

    updateQualityScores(db, ' AND namespace = ?', ['A']);

    const imp = (id: string) =>
      db.prepare<[string], { importance_score: number }>('SELECT importance_score FROM memories WHERE id = ?').get(id)!
        .importance_score;
    // A recomputed (max access_count in-tenant → high importance), B untouched.
    expect(imp(a)).toBeGreaterThan(0.5);
    expect(imp(b)).toBe(0.5);
  });
});

describe('CLASS 5 — confidence_score survives an export→import round-trip', () => {
  it('a restored memory keeps its confidence_score (not reset to 0.5)', async () => {
    const id = randomUUID();
    insertMemory(db, row(id, { confidence_score: 0.93 }), unit());
    const dump = handleExport(db, {});

    const db2 = createTestDb();
    await handleImport(db2, embedder, { data: dump.memories, overwrite: false });
    const got = db2
      .prepare<[string], { confidence_score: number }>('SELECT confidence_score FROM memories WHERE id = ?')
      .get(id)!;
    expect(got.confidence_score).toBeCloseTo(0.93, 5);
  });
});

describe('CLASS 5 — date fields reject a non-ISO datetime', () => {
  it('MemorySearchSchema rejects a partial date_from', () => {
    expect(MemorySearchSchema.safeParse({ query: 'x', date_from: '2026-03-01' }).success).toBe(false);
    expect(
      MemorySearchSchema.safeParse({ query: 'x', date_from: '2026-03-01T00:00:00Z' }).success,
    ).toBe(true);
  });
});

describe('CLASS 5 — chunker hard-split is codepoint-aware', () => {
  it('never splits an astral emoji into lone surrogates', () => {
    // 10 astral emoji (2 UTF-16 code units each = 20 units). chunkSize 5 forces
    // cuts that would land mid-pair under a naive slice.
    const content = '🔥'.repeat(10);
    const pieces = hardSplitContent(content, 5);
    expect(pieces.join('')).toBe(content);
    // No piece may start/end on a lone surrogate (would render as U+FFFD).
    for (const p of pieces) {
      expect(p).toBe(Buffer.from(p, 'utf16le').toString('utf16le')); // round-trips clean
      expect([...p].every((ch) => ch !== '�')).toBe(true);
      // each piece is whole codepoints: its code-unit length is even (pairs intact)
      expect(p.length % 2).toBe(0);
    }
  });
});

describe('CLASS 5 — vault graph export honours the egress cap', () => {
  it('drops a confidential memory (and its now-unreferenced entity) from the sidecar', () => {
    const pub = randomUUID();
    const conf = randomUUID();
    insertMemory(db, row(pub, { content: 'public uses postgres', access_level: 'public' }), unit(0));
    insertMemory(db, row(conf, { content: 'secret uses kafka', access_level: 'confidential' }), unit(1));
    storeExtractedEntities(db, conf, [{ name: 'KafkaSecret', type: 'tool', confidence: 0.9 }], 'regex');

    const capped = exportGraph(db, {}, { max_access_level: 'public' });
    const ids = capped.memories.map((m) => m.id);
    expect(ids).toContain(pub);
    expect(ids).not.toContain(conf);
    expect(capped.entities.map((e) => e.name)).not.toContain('KafkaSecret');

    // No cap → confidential leaks (control).
    expect(exportGraph(db, {}).memories.map((m) => m.id)).toContain(conf);
  });
});

describe('CLASS 5 — migration v13 normalizes legacy space-format timestamps', () => {
  it('rewrites a space-separated valid_to to ISO-Z', () => {
    const mdb = createTestDb(); // schema already initialized (v13)
    // Seed a row, force a legacy space-format valid_to, and rewind the schema so
    // the v13 migration runs.
    mdb.prepare(
      "INSERT INTO memories (id, content, created_at) VALUES ('legacy', 'x', '2026-01-01T00:00:00.000Z')",
    ).run();
    mdb.prepare("UPDATE memories SET valid_to = '2026-02-01 09:30:00' WHERE id = 'legacy'").run();
    mdb.prepare("UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'").run();

    runMigrations(mdb);

    const vt = mdb
      .prepare<[], { valid_to: string }>("SELECT valid_to FROM memories WHERE id = 'legacy'")
      .get()!;
    expect(vt.valid_to).toBe('2026-02-01T09:30:00Z');
  });
});
