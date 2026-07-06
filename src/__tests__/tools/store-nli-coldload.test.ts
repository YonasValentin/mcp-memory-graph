/**
 * F-NLI-COLDLOAD — an NLI model-load failure must NOT fail the write.
 *
 * THE BUG (availability): handleStore awaited detectContradictions() bare, and
 * nli.classify() lazy-loads the ~284MB MNLI model on first use. When that load
 * fails (first-ever cold start mid-download, slow/offline link), the rejection
 * ("Failed to load NLI model …") propagated and the WHOLE memory_store failed —
 * a user-visible write failure for an optional enrichment pass. E2E evidence:
 * 2 store failures during a cold model download; immediate retry succeeded.
 *
 * THE FIX: the NLI contradiction pass is wrapped in try/catch. On error the
 * store logs `nli_pass_skipped` (warn), skips contradiction detection for THIS
 * call (same semantics as MCP_NLI_DISABLED=1), and proceeds on the normal
 * heuristic path — the store succeeds. The failure is NOT cached: the retry
 * contract lives in CrossEncoderNli's init memo (nli-init-dedup.test.ts) and a
 * later store with a working classifier still detects contradictions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import type { NliClassifier } from '../../graph/contradiction.js';
import type { EmbeddingProvider } from '../../types.js';
import { logger } from '../../lib/logger.js';

/** Places PREMISE/HYPOTHESIS 0.45 L2 apart (inside the 0.7 NLI shortlist), so
 *  the classifier is actually invoked (mirrors store-nli-bidirectional). */
class ProximityEmbedder implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'proximity-test';
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    if (text.includes('PREMISE')) v[0] = 1;
    else if (text.includes('HYPOTHESIS')) {
      v[0] = 0.89875;
      v[1] = 0.43846;
    } else v[2] = 1;
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** Simulates the lazy load failing mid-download: EVERY classify() rejects the
 *  way CrossEncoderNli.loadModel does when the model is unavailable. */
class ColdLoadNli implements NliClassifier {
  calls = 0;
  async classify(): Promise<{ label: 'contradiction'; score: number }> {
    this.calls++;
    throw new Error(
      'Failed to load NLI model "Xenova/nli-deberta-v3-xsmall": fetch failed (mid-download)',
    );
  }
}

/** Symmetric (genuine) contradiction: fires when exactly one side is negated. */
class SymmetricNli implements NliClassifier {
  async classify(premise: string, hypothesis: string) {
    return premise.includes('NOT') !== hypothesis.includes('NOT')
      ? { label: 'contradiction' as const, score: 0.95 }
      : { label: 'neutral' as const, score: 0.1 };
  }
}

let db: Database.Database;
const embedder = new ProximityEmbedder();
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function validToOf(id: string): string | null {
  return (
    db
      .prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?')
      .get(id)?.valid_to ?? null
  );
}

describe('handleStore — F-NLI-COLDLOAD: classify() load failure degrades, never fails the write', () => {
  it('store SUCCEEDS when nli.classify throws the model-load error (warn logged, no contradicted entry, neighbor untouched)', async () => {
    const existing = await handleStore(db, embedder, {
      content: 'PREMISE the service listens on port 3000',
    });
    expect(validToOf(existing.memory.id)).toBeNull();

    const warnSpy = vi.spyOn(logger, 'warn');
    const nli = new ColdLoadNli();

    const result = await handleStore(
      db,
      embedder,
      { content: 'HYPOTHESIS the service does NOT listen on port 3000' },
      nli,
    );

    // The write must succeed on the heuristic path — NLI is optional enrichment.
    expect(result.stored).toBe(true);
    expect(result.operation).toBe('ADD');
    // The classifier WAS reached (the shortlist was non-empty) and failed.
    expect(nli.calls).toBeGreaterThan(0);
    // No contradiction may be reported or acted on for this call …
    expect((result.conflicts ?? []).some((c) => c.type === 'contradicted')).toBe(false);
    // … so the near neighbor survives un-retired (no silent data loss).
    expect(validToOf(existing.memory.id)).toBeNull();
    // The degradation is observable, not silent.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'nli_pass_skipped',
        err: expect.stringContaining('Failed to load NLI model'),
      }),
    );
  });

  it('the failure is NOT cached at the store layer — the next store with a working classifier detects the contradiction', async () => {
    const existing = await handleStore(db, embedder, {
      content: 'PREMISE the service listens on port 3000',
    });

    // First attempt: cold-load failure → degraded store, neighbor survives.
    await handleStore(
      db,
      embedder,
      { content: 'HYPOTHESIS the service does NOT listen on port 3000' },
      new ColdLoadNli(),
    );
    expect(validToOf(existing.memory.id)).toBeNull();

    // Retire the degraded twin so the retry below has ONE clean near neighbor.
    const twinId = db
      .prepare<[], { id: string }[]>("SELECT id FROM memories WHERE content LIKE 'HYPOTHESIS%'")
      .all()[0].id;
    db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(new Date().toISOString(), twinId);

    // Retry with a now-working classifier (the model finished downloading) and
    // on_conflict='supersede' to opt into the retire: the genuine contradiction is
    // detected and the old fact retired (proving the cold-load failure wasn't cached).
    const retry = await handleStore(
      db,
      embedder,
      { content: 'HYPOTHESIS the service does NOT listen on port 3000', on_conflict: 'supersede' },
      new SymmetricNli(),
    );
    expect(retry.stored).toBe(true);
    expect(retry.operation).toBe('DELETE');
    expect(validToOf(existing.memory.id)).not.toBeNull();
  });
});
