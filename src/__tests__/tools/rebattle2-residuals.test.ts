/**
 * battle-v9 RE-BATTLE WAVE 2 residuals (5 confirmed; 3 HIGH). The wave-1 fixes
 * were themselves attacked:
 *  A HIGH  removing MAX_K=4096 made the widening request k>4096 → vec0 throws
 *          ("k value in knn query too large") → memory_store crashes. Cap is now
 *          min(partitionCount, VEC0_MAX_K=4096); >4096 degrades benignly.
 *  B MED   handleRelated (single vector arm) had no widening → retired rows
 *          starved live neighbours to zero. Now widens (capped).
 *  C LOW   hybridSearch vector arm fixed oversampleLimit → vector-only/no-overlap
 *          recall starved. k now inflated by the partition's retired-row count.
 *  D HIGH  memory_canvas wrote content to a vault .canvas with NO egress filter.
 *  E HIGH  memory_questions 'gap' leaked foreign-tenant entity names over /mcp.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { insertMemory, findNearDuplicates, invalidateMemory } from '../../db/repository.js';
import { detectConflicts } from '../../graph/conflict-resolver.js';
import { handleRelated } from '../../tools/related.js';
import { hybridSearch } from '../../search/hybrid.js';
import { buildCanvas } from '../../vault/canvas.js';
import { handleStore } from '../../tools/store.js';
import { handleQuestions } from '../../tools/questions.js';
import type { EmbeddingProvider, MemoryRow } from '../../types.js';

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
const probeEmbedder: EmbeddingProvider = {
  dimensions: 384, modelName: 'probe', initialize: async () => {}, isReady: () => true,
  embed: async () => unit([[0, 1]]), embedBatch: async (t) => t.map(() => unit([[0, 1]])),
};

/** Fast bulk insert of N rows into memories + memories_vec (one transaction). */
function bulkInsert(n: number, namespace: string, vec: Float32Array, retired: boolean) {
  const mem = db.prepare(
    `INSERT INTO memories (id,scope,namespace,content,version,created_at,updated_at,valid_from,valid_to,importance_score,confidence_score,access_count)
     VALUES (?,?,?,?,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',?,0.5,0.5,0)`,
  );
  const vecStmt = db.prepare('INSERT INTO memories_vec(rowid, embedding, scope, namespace) VALUES (?, ?, ?, ?)');
  const buf = Buffer.from(vec.buffer);
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `bulk-${namespace}-${i}`;
      const info = mem.run(id, 'global', namespace, `c${i}`, retired ? '2026-02-01T00:00:00.000Z' : null);
      vecStmt.run(BigInt(info.lastInsertRowid as number), buf, 'global', namespace);
    }
  });
  tx();
}

describe('A — >4096-row partition does not crash the KNN (vec0 hard k-cap restored)', () => {
  it('findNearDuplicates + detectConflicts do not throw on a 4100-row partition', () => {
    bulkInsert(4100, 'big', unit([[0, 0.99], [2, 0.05]]), false);
    const probe = unit([[0, 1]]);
    const part = { scope: 'global', namespace: 'big' };
    expect(() => findNearDuplicates(db, probe, 0.6, 1, part)).not.toThrow();
    expect(() => detectConflicts(db, probe, 'c0', undefined, part)).not.toThrow();
  });
});

describe('B — handleRelated widens past retired neighbours', () => {
  it('returns a live neighbour hidden behind 25 nearer retired rows', async () => {
    const target = randomUUID();
    insertMemory(db, row(target, { namespace: 'p', content: 'the seed memory' }), unit([[0, 1]]));
    for (let i = 0; i < 25; i++) {
      const id = `r${i}`;
      insertMemory(db, row(id, { namespace: 'p' }), unit([[0, 0.99], [2, 0.06]]));
      invalidateMemory(db, id);
    }
    const live = randomUUID();
    insertMemory(db, row(live, { namespace: 'p', content: 'a genuinely related live neighbour' }), unit([[0, 0.95], [1, 0.25]]));

    const related = await handleRelated(db, embedder, { id: target, limit: 1 });
    expect(related.map((r) => r.memory.id)).toContain(live);
  });
});

describe('C — hybrid vector arm survives a retired-row flood in vector mode', () => {
  it('finds a live vector hit behind retired rows with search_mode=vector', async () => {
    for (let i = 0; i < 20; i++) {
      const id = `r${i}`;
      insertMemory(db, row(id, { namespace: 'p' }), unit([[0, 0.99], [2, 0.06]]));
      invalidateMemory(db, id);
    }
    const live = randomUUID();
    insertMemory(db, row(live, { namespace: 'p' }), unit([[0, 0.95], [1, 0.25]]));

    const res = await hybridSearch(db, probeEmbedder, {
      query: 'x', search_mode: 'vector', namespace: 'p', limit: 3, offset: 0,
    } as never);
    expect(res.results.map((r) => r.memory.id)).toContain(live);
  });
});

describe('D — memory_canvas honours the egress cap', () => {
  it('drops a confidential / deny-globbed memory from the board', () => {
    const conf = randomUUID();
    const ok = randomUUID();
    insertMemory(db, row(conf, { namespace: 'secrets', access_level: 'confidential', content: 'PROD_DB_PASSWORD=hunter2' }), unit([[0, 1]]));
    insertMemory(db, row(ok, { namespace: 'docs', content: 'public note' }), unit([[1, 1]]));

    const capped = buildCanvas(db, {}, { max_access_level: 'public' });
    expect(JSON.stringify(capped)).not.toContain('hunter2');
    const denied = buildCanvas(db, {}, { deny_globs: ['secrets/**'] });
    expect(JSON.stringify(denied)).not.toContain('hunter2');
    // No policy → present (control).
    expect(JSON.stringify(buildCanvas(db, {}))).toContain('hunter2');
  });
});

describe('E — memory_questions gap does not leak foreign-tenant entities', () => {
  it('a forced namespace never surfaces an entity it never mentioned', async () => {
    // 3 tenant-b memories all mention "redis" (shared entity, mention_count→3).
    for (let i = 0; i < 3; i++) {
      await handleStore(db, embedder, {
        content: `Tenant B uses redis for caching note ${i}`,
        namespace: 'tenant-b',
      });
    }
    // tenant-a never mentions redis.
    await handleStore(db, embedder, { content: 'Tenant A uses postgres', namespace: 'tenant-a' });

    const forced = await handleQuestions(db, { namespace: 'tenant-a' });
    const gapNames = forced.questions.filter((q) => q.type === 'gap').map((q) => q.question);
    expect(gapNames.join(' ')).not.toContain('redis');
  });
});
