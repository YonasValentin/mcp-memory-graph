import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { invalidateMemory, updateMemory } from '../../db/repository.js';
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
    valid_to: null,
    provenance: 'manual',
    access_level: 'internal',
  };
}

/** A tombstoned (deleted) memory: same id, `valid_to` stamped. */
function tombstone(id: string, updated_at: string, valid_to: string): ExportedMemory {
  return { ...mem(id, updated_at), valid_to };
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

  it('exports invalidated memories AS TOMBSTONES (valid_to set), not absent', async () => {
    // A deleted memory must travel in the artifact as a tombstone so a merge can
    // suppress the other branch's live copy. Dropping it would let the live copy
    // resurrect the deletion (the Bruno claim gap).
    const db = createTestDb();
    const keep = await store(db, 'kept memory note', 'Keep');
    const gone = await store(db, 'invalidated memory note', 'Gone');
    invalidateMemory(db, gone.id);

    const art = exportGraph(db);
    const byId = new Map(art.memories.map((m) => [m.id, m]));
    // Live memory present with no tombstone.
    expect(byId.get(keep.id)?.valid_to).toBeNull();
    // Deleted memory PRESENT but tombstoned (valid_to stamped).
    expect(byId.has(gone.id)).toBe(true);
    expect(byId.get(gone.id)?.valid_to).not.toBeNull();
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

  it('treats a memory with NO valid_to field (legacy artifact) as LIVE, not a tombstone', () => {
    // Older artifacts predate the valid_to field. The merge must read a missing
    // valid_to as null (live), so legacy graphs union normally — newer updated_at
    // wins, nothing is mistaken for a deletion.
    const legacyOld = { ...mem('Z', '2026-01-01T00:00:00.000Z') } as ExportedMemory;
    delete (legacyOld as { valid_to?: string | null }).valid_to;
    const legacyNew = { ...mem('Z', '2026-05-01T00:00:00.000Z'), content: 'NEWER Z' } as ExportedMemory;
    delete (legacyNew as { valid_to?: string | null }).valid_to;

    const ab = mergeGraphs(artifact([legacyOld]), artifact([legacyNew]));
    const ba = mergeGraphs(artifact([legacyNew]), artifact([legacyOld]));
    expect(ab).toEqual(ba);
    const z = ab.memories.find((m) => m.id === 'Z')!;
    expect(z.content).toBe('NEWER Z'); // later updated_at wins — normal live merge
  });

  it('a later REAL live edit beats an earlier same-day tombstone after merge (updated_at must collate with valid_to)', async () => {
    // Regression for the timestamp-format divergence. updateMemory stamps
    // updated_at, and the union merge lexically compares it against the ISO-Z
    // `valid_to` tombstone. If updateMemory wrote datetime('now')'s
    // space-separated form, a genuinely-later same-day live edit would sort
    // BELOW an older tombstone ('T' 0x54 > ' ' 0x20 at index 10) and be
    // silently suppressed on git merge (data loss). Drives the real write path.
    const db = createTestDb();
    const x = await store(db, 'note about Docker and merging', 'X');
    updateMemory(db, x.id, { title: 'X edited later today' });

    const live = exportGraph(db); // X live; updated_at from the real updateMemory
    const xLive = live.memories.find((m) => m.id === x.id)!;
    // An EARLIER same-day deletion of the same id, stamped ISO-Z as the code does.
    const earlierToday = `${xLive.updated_at.slice(0, 10)}T00:00:01.000Z`;
    const tomb = artifact([{ ...xLive, valid_to: earlierToday }]);

    const ab = mergeGraphs(tomb, live);
    const ba = mergeGraphs(live, tomb);
    expect(ab).toEqual(ba); // order-independent
    // The later live edit must WIN — the older tombstone must not suppress it.
    expect(ab.memories.find((m) => m.id === x.id)!.valid_to).toBeNull();
  });

  it('a tombstone suppresses the other branch\'s live copy (no resurrection), both directions', () => {
    // Branch A deletes memory X (tombstone, valid_to set). Branch B still has a
    // live X (same updated_at — invalidation does not bump updated_at). The merge
    // MUST keep X tombstoned, not resurrect the live copy. And mergeGraphs(A,B)
    // must equal mergeGraphs(B,A).
    const ts = '2026-01-01T00:00:00.000Z';
    const deletedX = tombstone('X', ts, '2026-02-01T00:00:00.000Z');
    const liveX = mem('X', ts);

    const a = artifact([deletedX]);
    const b = artifact([liveX]);

    const ab = mergeGraphs(a, b);
    const ba = mergeGraphs(b, a);

    expect(ab).toEqual(ba); // order-independent
    const x = ab.memories.find((m) => m.id === 'X')!;
    expect(x.valid_to).toBe('2026-02-01T00:00:00.000Z'); // stays deleted
  });

  it('a NEWER live edit wins over an OLDER tombstone (re-creation), both directions', () => {
    // A memory deleted at T1, then genuinely re-created/edited at T2 > T1 on the
    // other branch. The newer live edit should win — deletion is not permanent if
    // a later edit supersedes it. updated_at carries the recency signal here.
    const deletedOld = tombstone('Y', '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z');
    const liveNew: ExportedMemory = { ...mem('Y', '2026-03-01T00:00:00.000Z'), content: 'REVIVED' };

    const a = artifact([deletedOld]);
    const b = artifact([liveNew]);

    const ab = mergeGraphs(a, b);
    const ba = mergeGraphs(b, a);
    expect(ab).toEqual(ba);
    const y = ab.memories.find((m) => m.id === 'Y')!;
    expect(y.valid_to).toBeNull(); // revived
    expect(y.content).toBe('REVIVED');
  });

  it('the EARLIER tombstone wins when both branches deleted the same memory', () => {
    // Both branches deleted X. invalidateMemory keeps the FIRST valid_to
    // (COALESCE), so the merge must converge on the earlier deletion instant —
    // and do so identically in both directions.
    const ts = '2026-01-01T00:00:00.000Z';
    const earlier = tombstone('X', ts, '2026-02-01T00:00:00.000Z');
    const later = tombstone('X', ts, '2026-05-01T00:00:00.000Z');

    const a = artifact([earlier]);
    const b = artifact([later]);

    const ab = mergeGraphs(a, b);
    const ba = mergeGraphs(b, a);
    expect(ab).toEqual(ba);
    expect(ab.memories.find((m) => m.id === 'X')!.valid_to).toBe('2026-02-01T00:00:00.000Z');
  });

  it('two tombstones with the SAME valid_to converge via a stable full-record tie-break', () => {
    // Both branches deleted X at the exact same instant but the rows differ in
    // other fields (e.g. divergent content captured before deletion). The
    // earlier-deletion rule is a no-op here, so a stable full-record compare must
    // pick the same winner regardless of merge direction.
    const vt = '2026-02-01T00:00:00.000Z';
    const fromA: ExportedMemory = { ...tombstone('X', '2026-01-01T00:00:00.000Z', vt), content: 'A-content' };
    const fromB: ExportedMemory = { ...tombstone('X', '2026-01-01T00:00:00.000Z', vt), content: 'B-content' };

    const ab = mergeGraphs(artifact([fromA]), artifact([fromB]));
    const ba = mergeGraphs(artifact([fromB]), artifact([fromA]));
    expect(ab).toEqual(ba); // order-independent
    const x = ab.memories.find((m) => m.id === 'X')!;
    expect(x.valid_to).toBe(vt); // still deleted at the shared instant
  });

  it('a tombstone with a LATER deletion instant wins over a live copy at the same updated_at', () => {
    // Tombstone valid_to is later than the live copy's updated_at → the deletion
    // is the more recent fact about X → it wins, symmetrically.
    const liveX = mem('X', '2026-01-01T00:00:00.000Z');
    const deletedLater = tombstone('X', '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');

    const a = artifact([liveX]);
    const b = artifact([deletedLater]);
    const ab = mergeGraphs(a, b);
    const ba = mergeGraphs(b, a);
    expect(ab).toEqual(ba);
    expect(ab.memories.find((m) => m.id === 'X')!.valid_to).toBe('2026-06-01T00:00:00.000Z');
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
