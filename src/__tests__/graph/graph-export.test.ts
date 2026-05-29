import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { invalidateMemory } from '../../db/repository.js';
import {
  exportGraph,
  mergeGraphs,
  mergeGraphFiles,
  type GraphArtifact,
  type ExportedMemory,
} from '../../graph/graph-export.js';

const embedder = new MockEmbeddingProvider();

async function store(
  db: ReturnType<typeof createTestDb>,
  content: string,
  title?: string,
  opts?: { scope?: 'global' | 'project'; namespace?: string },
) {
  return (
    await handleStore(db, embedder, {
      content,
      title,
      scope: opts?.scope,
      namespace: opts?.namespace,
    })
  ).memory;
}

/** Minimal artifact builder for the pure-merge tests (no DB). */
function mem(id: string, updated_at: string): ExportedMemory {
  return {
    id,
    title: id,
    content: `content of ${id}`,
    scope: 'global',
    namespace: null,
    tags: [],
    document_type: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at,
    provenance: 'manual',
    access_level: 'internal',
  };
}

function artifact(memories: ExportedMemory[], links: GraphArtifact['links'] = []): GraphArtifact {
  return { version: 1, memories, links, entities: [] };
}

describe('exportGraph — committable graph artifact (Pillar 7, T21)', () => {
  it('exports currently-valid memories, links, and entities, deterministically', async () => {
    const db = createTestDb();
    const m1 = await store(db, 'alpha note about Docker and React', 'A');
    const m2 = await store(db, 'beta note about Docker and Prisma', 'B');
    const m3 = await store(db, 'gamma note about React and Postgres', 'C');
    createMemoryLink(db, {
      sourceId: m1.id,
      targetId: m2.id,
      relation: 'links_to',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      sourceKind: 'wikilink',
    });

    const art = exportGraph(db);
    expect(art.version).toBe(1);
    expect(art.memories).toHaveLength(3);
    // sorted by id
    const ids = art.memories.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids)).toEqual(new Set([m1.id, m2.id, m3.id]));
    // The manual wikilink edge is exported…
    const wikilink = art.links.find((l) => l.source_kind === 'wikilink');
    expect(wikilink).toMatchObject({ source: m1.id, target: m2.id, relation: 'links_to' });
    // …alongside the auto co-occurrence edges (these memories share Docker/React
    // entities, so the co-occurrence -> memory_links bridge (G3-F7) emits them).
    const cooccur = art.links.filter((l) => l.source_kind === 'co_occurrence');
    expect(cooccur.length).toBeGreaterThan(0);
    // entities auto-extracted (Docker/React/... are known tools)
    expect(art.entities.length).toBeGreaterThan(0);

    // deterministic: two runs deep-equal
    const again = exportGraph(db);
    expect(again).toEqual(art);
  });

  it('excludes invalidated (valid_to set) memories', async () => {
    const db = createTestDb();
    const keep = await store(db, 'kept memory note', 'Keep');
    const gone = await store(db, 'invalidated memory note', 'Gone');
    invalidateMemory(db, gone.id);

    const art = exportGraph(db);
    const ids = art.memories.map((m) => m.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(gone.id);
  });

  it('excludes chunk rows (only top-level memories)', async () => {
    const db = createTestDb();
    const parent = await store(db, 'parent doc note', 'Parent');
    // simulate a chunk row by inserting a child memory pointing at the parent
    db.prepare(
      `UPDATE memories SET parent_id = ?, chunk_index = 0 WHERE id = ?`,
    ).run(parent.id, parent.id);
    const child = await store(db, 'standalone other note', 'Other');
    db.prepare(
      `UPDATE memories SET parent_id = ?, chunk_index = 0 WHERE id = ?`,
    ).run(parent.id, child.id);

    const art = exportGraph(db);
    const ids = art.memories.map((m) => m.id);
    // both rows now have a parent_id → excluded as chunks
    expect(ids).not.toContain(child.id);
  });

  it('respects scope/namespace filter', async () => {
    const db = createTestDb();
    const a = await store(db, 'project scoped note one', 'P', { scope: 'project', namespace: 'crawlux' });
    const b = await store(db, 'global scoped note two', 'G', { scope: 'global' });

    const scoped = exportGraph(db, { scope: 'project', namespace: 'crawlux' });
    const ids = scoped.memories.map((m) => m.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});

describe('mergeGraphs — pure union merge (the merge-driver core)', () => {
  it('unions memories by id, newer updated_at wins, no duplicate ids', () => {
    const m1 = mem('m1', '2026-01-02T00:00:00.000Z');
    const m2 = mem('m2', '2026-01-02T00:00:00.000Z');
    const m2newer: ExportedMemory = { ...mem('m2', '2026-03-01T00:00:00.000Z'), content: 'NEWER m2' };
    const m3 = mem('m3', '2026-01-02T00:00:00.000Z');

    const a = artifact([m1, m2]);
    const b = artifact([m2newer, m3]);
    const merged = mergeGraphs(a, b);

    const ids = merged.memories.map((m) => m.id);
    expect(ids).toEqual(['m1', 'm2', 'm3']); // unioned + sorted, no dupes
    const m2out = merged.memories.find((m) => m.id === 'm2')!;
    expect(m2out.content).toBe('NEWER m2'); // newer wins
  });

  it('is order-independent: mergeGraphs(a,b) deep-equals mergeGraphs(b,a)', () => {
    const a = artifact(
      [mem('m1', '2026-01-01T00:00:00.000Z'), mem('m2', '2026-01-01T00:00:00.000Z')],
      [{ source: 'm1', target: 'm2', relation: 'links_to', confidence: 'INFERRED', confidence_score: 0.5, source_kind: 'wikilink', evidence_count: 2, last_seen_at: '2026-01-01T00:00:00.000Z' }],
    );
    const b = artifact(
      [mem('m2', '2026-01-01T00:00:00.000Z'), mem('m3', '2026-01-01T00:00:00.000Z')],
      [{ source: 'm2', target: 'm3', relation: 'links_to', confidence: 'INFERRED', confidence_score: 0.5, source_kind: 'wikilink', evidence_count: 1, last_seen_at: '2026-01-01T00:00:00.000Z' }],
    );

    expect(mergeGraphs(a, b)).toEqual(mergeGraphs(b, a));
  });

  it('is order-independent on same id + SAME updated_at but DIFFERENT content', () => {
    // Two devs edit the same memory and commit in the same wall-clock second:
    // identical id + updated_at, divergent content. A union driver MUST converge
    // both merge directions to the same content, or clones silently diverge.
    const ts = '2026-01-01T00:00:00.000Z';
    const fromA: ExportedMemory = { ...mem('m1', ts), content: 'FROM A' };
    const fromB: ExportedMemory = { ...mem('m1', ts), content: 'FROM B' };
    const a = artifact([fromA]);
    const b = artifact([fromB]);

    const ab = mergeGraphs(a, b);
    const ba = mergeGraphs(b, a);
    expect(ab).toEqual(ba); // full content equality, not just id-set
    expect(ab.memories[0].content).toBe(ba.memories[0].content);
  });

  it('on link collision keeps the max evidence_count', () => {
    const m1 = mem('m1', '2026-01-01T00:00:00.000Z');
    const m2 = mem('m2', '2026-01-01T00:00:00.000Z');
    const a = artifact(
      [m1, m2],
      [{ source: 'm1', target: 'm2', relation: 'links_to', confidence: 'INFERRED', confidence_score: 0.5, source_kind: 'wikilink', evidence_count: 3, last_seen_at: '2026-01-01T00:00:00.000Z' }],
    );
    const b = artifact(
      [m1, m2],
      [{ source: 'm1', target: 'm2', relation: 'links_to', confidence: 'EXTRACTED', confidence_score: 1, source_kind: 'wikilink', evidence_count: 7, last_seen_at: '2026-02-01T00:00:00.000Z' }],
    );

    const merged = mergeGraphs(a, b);
    expect(merged.links).toHaveLength(1);
    expect(merged.links[0].evidence_count).toBe(7);
    expect(merged.links[0].confidence).toBe('EXTRACTED'); // higher confidence kept
  });

  it('on equal-confidence link collision keeps the later last_seen_at edge', () => {
    const m1 = mem('m1', '2026-01-01T00:00:00.000Z');
    const m2 = mem('m2', '2026-01-01T00:00:00.000Z');
    const earlier: ExportedMemory[] = [m1, m2];
    const a = artifact(earlier, [
      { source: 'm1', target: 'm2', relation: 'links_to', confidence: 'INFERRED', confidence_score: 0.5, source_kind: 'similarity', evidence_count: 1, last_seen_at: '2026-01-01T00:00:00.000Z' },
    ]);
    const b = artifact(earlier, [
      { source: 'm1', target: 'm2', relation: 'links_to', confidence: 'INFERRED', confidence_score: 0.5, source_kind: 'wikilink', evidence_count: 1, last_seen_at: '2026-05-01T00:00:00.000Z' },
    ]);

    const merged = mergeGraphs(a, b);
    expect(merged.links[0].source_kind).toBe('wikilink'); // later-seen edge's fields kept
    expect(merged.links[0].last_seen_at).toBe('2026-05-01T00:00:00.000Z');
    // symmetric
    expect(mergeGraphs(b, a)).toEqual(merged);
  });

  it('unions entities by id (higher mention_count wins) and collapses same normalized_name', () => {
    const a: GraphArtifact = {
      version: 1,
      memories: [],
      links: [],
      entities: [
        { id: 'e1', name: 'Docker', normalized_name: 'docker', type: 'tool', mention_count: 2 },
      ],
    };
    const b: GraphArtifact = {
      version: 1,
      memories: [],
      links: [],
      entities: [
        // same id, higher count → wins
        { id: 'e1', name: 'Docker', normalized_name: 'docker', type: 'tool', mention_count: 9 },
        // different id but SAME normalized_name → collapsed (lower count drops)
        { id: 'e2', name: 'docker', normalized_name: 'docker', type: 'tool', mention_count: 1 },
        // distinct entity survives
        { id: 'e3', name: 'React', normalized_name: 'react', type: 'tool', mention_count: 4 },
      ],
    };

    const merged = mergeGraphs(a, b);
    const ids = merged.entities.map((e) => e.id);
    expect(ids).toEqual(['e1', 'e3']); // e2 collapsed into the docker bucket
    expect(merged.entities.find((e) => e.id === 'e1')!.mention_count).toBe(9);
    expect(mergeGraphs(b, a)).toEqual(merged); // order-independent
  });

  it('breaks equal-mention_count entity collisions by lower id (deterministic)', () => {
    const a: GraphArtifact = {
      version: 1,
      memories: [],
      links: [],
      entities: [{ id: 'e9', name: 'Vite', normalized_name: 'vite', type: 'tool', mention_count: 3 }],
    };
    const b: GraphArtifact = {
      version: 1,
      memories: [],
      links: [],
      // different id, SAME normalized_name, SAME mention_count → lower id wins
      entities: [{ id: 'e1', name: 'vite', normalized_name: 'vite', type: 'tool', mention_count: 3 }],
    };

    const merged = mergeGraphs(a, b);
    expect(merged.entities).toHaveLength(1);
    expect(merged.entities[0].id).toBe('e1'); // lower id wins the tie
    expect(mergeGraphs(b, a)).toEqual(merged); // order-independent
  });

  it('is order-independent on same entity id + equal mention_count but different fields', () => {
    // Same id + same mention_count, divergent other fields (name/type) — the
    // lower-id tie-break is a no-op here, so a stable full-record compare must
    // make both merge directions converge.
    const a: GraphArtifact = {
      version: 1,
      memories: [],
      links: [],
      entities: [{ id: 'e1', name: 'Docker', normalized_name: 'docker', type: 'tool', mention_count: 2 }],
    };
    const b: GraphArtifact = {
      version: 1,
      memories: [],
      links: [],
      entities: [{ id: 'e1', name: 'docker-engine', normalized_name: 'docker', type: 'concept', mention_count: 2 }],
    };

    const ab = mergeGraphs(a, b);
    const ba = mergeGraphs(b, a);
    expect(ab).toEqual(ba);
    expect(ab.entities[0].name).toBe(ba.entities[0].name);
  });
});

describe('mergeGraphFiles — thin IO over mergeGraphs', () => {
  it('merges two artifact files into one matching mergeGraphs(A,B)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-merge-'));
    try {
      const a = artifact([mem('m1', '2026-01-01T00:00:00.000Z')]);
      const b = artifact([mem('m2', '2026-01-01T00:00:00.000Z')]);
      const oursPath = join(dir, 'ours.json');
      const theirsPath = join(dir, 'theirs.json');
      const outPath = join(dir, 'out.json');
      writeFileSync(oursPath, JSON.stringify(a));
      writeFileSync(theirsPath, JSON.stringify(b));

      mergeGraphFiles(oursPath, theirsPath, outPath);
      const out = JSON.parse(readFileSync(outPath, 'utf8')) as GraphArtifact;
      expect(out).toEqual(mergeGraphs(a, b));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
