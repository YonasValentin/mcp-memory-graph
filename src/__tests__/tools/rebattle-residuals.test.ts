/**
 * battle-v9 RE-BATTLE residuals (4 confirmed by the 6-attacker + 3-skeptic
 * adversarial re-run, in the battle-v9 fixes themselves):
 *  1. HIGH exportGraph honoured only max_access_level, ignoring deny_globs.
 *  2. MED  detectConflicts kept a fixed k=10 (item-13 widening was only added to
 *          findNearDuplicates) — retired rows starve a live conflict.
 *  3. MED  import OVERWRITE path dropped confidence_score/importance_score (only
 *          the new-row branch was fixed).
 *  4. LOW  findNearDuplicates MAX_K=4096 cap re-introduced starvation past 4096
 *          retired rows — cap is now the true partition row count (vecRowCount).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { insertMemory, findNearDuplicates, vecRowCount, invalidateMemory } from '../../db/repository.js';
import { detectConflicts } from '../../graph/conflict-resolver.js';
import { exportGraph } from '../../graph/graph-export.js';
import { storeExtractedEntities } from '../../graph/entity-store.js';
import { handleImport } from '../../tools/import.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function unit(pairs: Array<[number, number]>): Float32Array {
  const v = new Float32Array(384);
  for (const [i, x] of pairs) v[i] = x;
  return v;
}
function row(id: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id, scope: 'global', namespace: null, title: id, content: `content ${id}`,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.5,
    ...over,
  };
}

describe('#1 exportGraph honours deny_globs (not just max_access_level)', () => {
  it('drops a deny-glob-blocked memory + its entity from the sidecar', () => {
    const blocked = randomUUID();
    const ok = randomUUID();
    insertMemory(db, row(blocked, { namespace: 'secrets', content: 'PROD_DB_PASSWORD=hunter2' }), unit([[0, 1]]));
    insertMemory(db, row(ok, { namespace: 'docs', content: 'public note' }), unit([[1, 1]]));
    storeExtractedEntities(db, blocked, [{ name: 'ProdDbPassword', type: 'tool', confidence: 0.9 }], 'regex');

    const artifact = exportGraph(db, {}, { deny_globs: ['secrets/**'] });
    const ids = artifact.memories.map((m) => m.id);
    expect(ids).not.toContain(blocked);
    expect(ids).toContain(ok);
    expect(JSON.stringify(artifact)).not.toContain('hunter2');
    expect(artifact.entities.map((e) => e.name)).not.toContain('ProdDbPassword');

    // No policy → leaks (control).
    expect(exportGraph(db, {}).memories.map((m) => m.id)).toContain(blocked);
  });
});

describe('#2 detectConflicts widens past retired rows', () => {
  it('finds a live duplicate hidden behind 12 nearer RETIRED rows in the partition', () => {
    const probe = unit([[0, 1]]);
    const near = unit([[0, 0.998], [2, 0.06]]); // nearer (retired)
    const live = unit([[0, 0.99], [2, 0.14]]); // farther, live, in 0.4
    const part = { scope: 'global', namespace: 'p' };
    for (let i = 0; i < 12; i++) {
      const id = `r${i}`;
      insertMemory(db, row(id, { namespace: 'p', content: 'unrelated filler text' }), near);
      invalidateMemory(db, id);
    }
    insertMemory(db, row('live0', { namespace: 'p', content: 'the api listens on port 3000' }), live);

    const conflicts = detectConflicts(db, probe, 'the api listens on port 3000', undefined, part);
    expect(conflicts.map((c) => c.existing_memory_id)).toContain('live0');
  });
});

describe('#3 import OVERWRITE preserves confidence_score + importance_score', () => {
  it('a re-import onto an existing id carries the backup trust/criticality', async () => {
    const id = 'fixed-id';
    insertMemory(db, row(id, { content: 'stale', confidence_score: 0.5, importance_score: 0.5 }), unit([[0, 1]]));
    await handleImport(db, embedder, {
      data: [{ id, content: 'new authoritative content', confidence_score: 0.93, importance_score: 0.88 }],
      overwrite: true,
    });
    const got = db
      .prepare<[string], { content: string; confidence_score: number; importance_score: number }>(
        'SELECT content, confidence_score, importance_score FROM memories WHERE id = ?',
      )
      .get(id)!;
    expect(got.content).toBe('new authoritative content'); // overwrite ran
    expect(got.confidence_score).toBeCloseTo(0.93, 5);
    expect(got.importance_score).toBeCloseTo(0.88, 5);
  });
});

describe('#4 findNearDuplicates cap is the true partition row count', () => {
  it('vecRowCount reports the partition + total row counts', () => {
    for (let i = 0; i < 3; i++) insertMemory(db, row(`a${i}`, { namespace: 'A' }), unit([[0, 1]]));
    for (let i = 0; i < 2; i++) insertMemory(db, row(`b${i}`, { namespace: 'B' }), unit([[1, 1]]));
    expect(vecRowCount(db, { scope: 'global', namespace: 'A' })).toBe(3);
    expect(vecRowCount(db, { scope: 'global', namespace: 'B' })).toBe(2);
    expect(vecRowCount(db)).toBe(5);
  });
  it('finds a live near-dup behind many nearer retired rows (cap scales to the partition)', () => {
    const probe = unit([[0, 1]]);
    const near = unit([[0, 0.99], [2, 0.14]]);
    const far = unit([[0, 0.9315], [1, 0.3637]]);
    for (let i = 0; i < 40; i++) {
      const id = `r${i}`;
      insertMemory(db, row(id, { namespace: 'p' }), near);
      invalidateMemory(db, id);
    }
    insertMemory(db, row('live0', { namespace: 'p' }), far);
    // limit=1 — the widening must keep going (cap = partition count = 41) until
    // the single live row is surfaced from behind all 40 retired rows.
    const res = findNearDuplicates(db, probe, 0.6, 1, { scope: 'global', namespace: 'p' });
    expect(res.map((r) => r.id)).toEqual(['live0']);
  });
});
