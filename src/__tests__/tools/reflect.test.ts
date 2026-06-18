/**
 * Pillar 5 (T14): Generative-Agents-style reflection — agent-driven, NO LLM in
 * the server. `memory_reflect` has two modes:
 *
 *  - mode 'gather': the server does the cheap local work — SELECT the most
 *    reflection-worthy memories (high importance × recent) as "material" and
 *    hand the consuming agent an instruction to synthesize insights.
 *  - mode 'store': the agent synthesizes 1–3 higher-level insights and stores
 *    them back here, tagged provenance='reflection' and `derived_from`-linked
 *    to the source memories.
 *
 * Uses createTestDb + MockEmbeddingProvider + handleStore so runs stay fast.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleReflect } from '../../tools/reflect.js';
import { getMemoryById } from '../../db/repository.js';
import { getOutgoingLinks } from '../../graph/memory-links.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

function setImportance(id: string, score: number): void {
  db.prepare('UPDATE memories SET importance_score = ? WHERE id = ?').run(score, id);
}

describe('handleReflect — mode gather', () => {
  it('returns material ordered by importance desc, with count, instruction, and snippet', async () => {
    const a = await handleStore(db, embedder, { content: 'Low importance fact about widgets.' });
    const b = await handleStore(db, embedder, { content: 'High importance fact about the architecture.' });
    const c = await handleStore(db, embedder, { content: 'Medium importance fact about deploys.' });

    setImportance(a.memory.id, 0.1);
    setImportance(b.memory.id, 0.9);
    setImportance(c.memory.id, 0.5);

    const result = await handleReflect(db, embedder, { mode: 'gather' });

    expect(result.mode).toBe('gather');
    expect(result.count).toBe(3);
    expect(result.material).toHaveLength(3);
    // Ordered by importance descending: b (0.9), c (0.5), a (0.1).
    expect(result.material.map((m) => m.id)).toEqual([b.memory.id, c.memory.id, a.memory.id]);
    expect(result.material[0].importance_score).toBe(0.9);
    expect(typeof result.instruction).toBe('string');
    expect(result.instruction.length).toBeGreaterThan(0);
    // snippet present for each item.
    for (const m of result.material) {
      expect(typeof m.snippet).toBe('string');
      expect(m.snippet.length).toBeGreaterThan(0);
    }
  });

  it('respects scope/namespace and excludes invalidated (bi-temporal) memories', async () => {
    const inScope = await handleStore(db, embedder, {
      content: 'Project acme decision about caching.',
      scope: 'project',
      namespace: 'acme',
    });
    // Different namespace — must be excluded.
    await handleStore(db, embedder, {
      content: 'Other project decision.',
      scope: 'project',
      namespace: 'other',
    });
    // Same scope/namespace but invalidated (retired) — must be excluded.
    const retired = await handleStore(db, embedder, {
      content: 'Stale acme decision to be retired.',
      scope: 'project',
      namespace: 'acme',
    });
    db.prepare("UPDATE memories SET valid_to = datetime('now') WHERE id = ?").run(retired.memory.id);

    const result = await handleReflect(db, embedder, {
      mode: 'gather',
      scope: 'project',
      namespace: 'acme',
    });

    expect(result.count).toBe(1);
    expect(result.material.map((m) => m.id)).toEqual([inScope.memory.id]);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await handleStore(db, embedder, { content: `Fact number ${i} about the system.` });
    }
    const result = await handleReflect(db, embedder, { mode: 'gather', limit: 2 });
    expect(result.count).toBe(2);
    expect(result.material).toHaveLength(2);
  });
});

describe('handleReflect — mode store', () => {
  it('stores the insight with provenance=reflection and derived_from links to sources', async () => {
    const s1 = await handleStore(db, embedder, { content: 'We always deploy on Fridays and it breaks.' });
    const s2 = await handleStore(db, embedder, { content: 'Friday deploys caused two incidents this quarter.' });

    const result = await handleReflect(db, embedder, {
      mode: 'store',
      insight: 'Pattern: Friday deploys are high-risk and should be avoided.',
      source_ids: [s1.memory.id, s2.memory.id],
      title: 'Friday deploy risk',
    });

    expect(result.mode).toBe('store');
    expect(typeof result.insight_id).toBe('string');
    expect(result.provenance).toBe('reflection');
    expect(result.links_created).toBe(2);

    // The stored memory carries provenance='reflection'.
    const stored = getMemoryById(db, result.insight_id);
    expect(stored).not.toBeNull();
    const prov = db
      .prepare<[string], { provenance: string }>('SELECT provenance FROM memories WHERE id = ?')
      .get(result.insight_id);
    expect(prov?.provenance).toBe('reflection');

    // Two outgoing derived_from edges, one to each source.
    const links = getOutgoingLinks(db, result.insight_id);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.relation === 'derived_from')).toBe(true);
    const targets = links.map((l) => l.target_memory_id).sort();
    expect(targets).toEqual([s1.memory.id, s2.memory.id].sort());
  });

  it('skips non-existent source_ids and only links existing ones', async () => {
    const s1 = await handleStore(db, embedder, { content: 'Real source memory.' });

    const result = await handleReflect(db, embedder, {
      mode: 'store',
      insight: 'Insight derived from one real source.',
      source_ids: [s1.memory.id, 'does-not-exist-id'],
    });

    expect(result.links_created).toBe(1);
    const links = getOutgoingLinks(db, result.insight_id);
    expect(links).toHaveLength(1);
    expect(links[0].target_memory_id).toBe(s1.memory.id);
  });

  it('returns a clear error when insight or source_ids are missing in store mode', async () => {
    const noInsight = await handleReflect(db, embedder, {
      mode: 'store',
      source_ids: ['some-id'],
    });
    expect(noInsight.error).toBeTruthy();

    const noSources = await handleReflect(db, embedder, {
      mode: 'store',
      insight: 'An insight without sources.',
    });
    expect(noSources.error).toBeTruthy();
  });
});
