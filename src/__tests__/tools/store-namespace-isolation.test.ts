/**
 * battle-v7 H1 + H2 — multi-tenant namespace isolation of the store-path
 * conflict/dedup scan and the NLI contradiction shortlist.
 *
 * THE BUG (HIGH, data-loss): both the heuristic conflict scan (detectConflicts)
 * and the NLI contradiction shortlist (findNearDuplicates) ran a GLOBAL
 * memories_vec MATCH with no (scope, namespace) filter. So a write into
 * project B's namespace could be:
 *   H1) silently dropped as a "duplicate" of a near-identical fact that lives
 *       in project A's namespace (NOOP → the B write never persists), or
 *   H2) treated as a contradiction that bi-temporally RETIRES project A's fact.
 * A real two-tenant deployment sharing one DB therefore loses data across the
 * tenant boundary.
 *
 * THE FIX: detectConflicts + findNearDuplicates take an optional `partition`
 * ({scope, namespace}); handleStore passes the writing memory's partition so a
 * candidate in a different (scope, namespace) is never a conflict/dup/contradiction
 * candidate. Single-tenant deployments (one namespace) are unaffected — every
 * candidate shares the partition, so the pre-fix behavior is byte-identical.
 *
 * Deterministic: a marker-keyed embedder that ignores the namespace context
 * prefix (so identical content in two namespaces collides in vector space the
 * way the REAL semantic embedder does), plus the StubNli pattern from
 * store-nli-write-gate.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import type { NliClassifier } from '../../graph/contradiction.js';
import type { EmbeddingProvider } from '../../types.js';

/**
 * Keys the vector ONLY on a content marker, ignoring the namespace/title/type
 * context prefix that contextualizeForEmbedding prepends. So the SAME content
 * stored in two different namespaces produces the SAME vector — reproducing what
 * the real semantic embedder does (a tiny namespace prefix barely moves the
 * vector), which the hash-based MockEmbeddingProvider does NOT.
 */
class MarkerEmbedder implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'marker-test';
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    if (text.includes('DUPTOPIC')) {
      v[5] = 1; // identical vector for both tenants' duplicate content
    } else if (text.includes('PREMISE')) {
      v[0] = 1;
    } else if (text.includes('HYPOTHESIS')) {
      // 0.45 L2 from PREMISE: inside the 0.7 NLI shortlist, outside the 0.4
      // heuristic break — exactly the window the NLI gate operates in.
      v[0] = 0.89875;
      v[1] = 0.43846;
    } else {
      v[9] = 1;
    }
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** Symmetric negation-pair stub (exactly one side negated) — satisfies the H6
 *  bidirectional gate that handleStore now applies. */
class StubNli implements NliClassifier {
  async classify(premise: string, hypothesis: string) {
    return premise.includes('NOT') !== hypothesis.includes('NOT')
      ? { label: 'contradiction' as const, score: 0.95 }
      : { label: 'neutral' as const, score: 0.1 };
  }
}

let db: Database.Database;
const embedder = new MarkerEmbedder();

beforeEach(() => {
  db = createTestDb();
});

function liveCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE valid_to IS NULL').get() as { c: number }).c;
}
function validToOf(id: string): string | null {
  return (
    db.prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?').get(id)
      ?.valid_to ?? null
  );
}

describe('handleStore — H1: cross-namespace dedup is isolated', () => {
  it('an identical fact in a DIFFERENT namespace is stored anew, not deduped away', async () => {
    const content = 'DUPTOPIC the billing API uses PostgreSQL row-level security for tenant isolation';

    const a = await handleStore(db, embedder, { content, namespace: 'project-a' });
    expect(a.stored).toBe(true);

    const b = await handleStore(db, embedder, { content, namespace: 'project-b' });

    // Project B's write must persist as its own row — NOT collapse into A's.
    expect(b.stored).toBe(true);
    expect(b.operation).not.toBe('NOOP');
    expect(b.memory.id).not.toBe(a.memory.id);
    expect(liveCount()).toBe(2);
  });

  it('still dedups an identical fact WITHIN the same namespace (no regression)', async () => {
    const content = 'DUPTOPIC the billing API uses PostgreSQL row-level security for tenant isolation';

    const a = await handleStore(db, embedder, { content, namespace: 'project-a' });
    const a2 = await handleStore(db, embedder, { content, namespace: 'project-a' });

    expect(a2.stored).toBe(false);
    expect(a2.memory.id).toBe(a.memory.id);
    expect(liveCount()).toBe(1);
  });
});

describe('handleStore — H2: cross-namespace NLI contradiction is isolated', () => {
  const nli = new StubNli();

  it('a contradicting fact in a DIFFERENT namespace does NOT retire another project’s fact', async () => {
    const premise = await handleStore(db, embedder, { content: 'PREMISE the service listens on port 3000', namespace: 'project-a' }, nli);
    expect(premise.stored).toBe(true);

    const hypo = await handleStore(db, embedder, { content: 'HYPOTHESIS the service does NOT listen on port 3000', namespace: 'project-b' }, nli);
    expect(hypo.stored).toBe(true);

    // Project A's fact must remain valid — project B cannot retire it.
    expect(validToOf(premise.memory.id)).toBeNull();
  });

  it('still retires a contradicted fact WITHIN the same namespace (no regression)', async () => {
    const premise = await handleStore(db, embedder, { content: 'PREMISE the service listens on port 3000', namespace: 'project-a' }, nli);
    const hypo = await handleStore(db, embedder, { content: 'HYPOTHESIS the service does NOT listen on port 3000', namespace: 'project-a' }, nli);

    expect(hypo.stored).toBe(true);
    expect(hypo.operation).toBe('DELETE'); // NLI contradiction path
    expect(validToOf(premise.memory.id)).not.toBeNull(); // retired
  });
});
