import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';
import type { EmbeddingProvider } from '../../types.js';

const embedder = new MockEmbeddingProvider();

/**
 * v19 trust-surfacing: volatility is auto-derived + persisted at write time, and
 * verification_tier round-trips on store + update. A contradiction/supersede
 * match on the DEFAULT add path now surfaces a loud `warnings[]` line.
 */
describe('v19 volatility persistence', () => {
  it('auto-derives volatile for deploy/state content', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'The fix is deployed to PROD and verified live' });
    expect(m.memory.volatility).toBe('volatile');
  });

  it('auto-derives normal for durable content and stable from document_type', async () => {
    const db = createTestDb();
    const normal = await handleStore(db, embedder, { content: 'ALTER PROCEDURE replaces the whole stored proc body.' });
    expect(normal.memory.volatility).toBe('normal');
    const stable = await handleStore(db, embedder, { content: 'currently in effect', document_type: 'contract' });
    expect(stable.memory.volatility).toBe('stable');
  });

  it('honours an explicit volatility override', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'deployed live', volatility: 'stable' });
    expect(m.memory.volatility).toBe('stable');
  });
});

describe('v19 verification_tier round-trip', () => {
  it('persists verification_tier + detail on store', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, {
      content: 'event-24 fires +1 day after the Salgstjek',
      verification_tier: 'source_verified',
      verification_detail: 'checked live UAT plan 2026-06-18',
    });
    expect(m.memory.verification_tier).toBe('source_verified');
    expect(m.memory.verification_detail).toBe('checked live UAT plan 2026-06-18');
  });

  it('defaults verification_tier to null (neutral) when omitted', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'a plain claim' });
    expect(m.memory.verification_tier).toBeNull();
  });

  it('lets verification_tier be set after the fact via update', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'asserted claim, verify later' });
    expect(m.memory.verification_tier).toBeNull();
    const updated = await handleUpdate(db, embedder, { id: m.memory.id, verification_tier: 'source_verified' });
    expect(updated?.verification_tier).toBe('source_verified');
  });
});

// Identical vector → vectorSim ~= 1; keyword Jaccard drives overlap into the
// superseded band (0.75, 0.85]. Same recipe as store-superseded-band-add.
const sameVecEmbedder: EmbeddingProvider = {
  dimensions: 384,
  modelName: 'samevec',
  async initialize() {},
  isReady() {
    return true;
  },
  async embed() {
    const v = new Float32Array(384);
    v[0] = 1;
    return v;
  },
  async embedBatch(texts: string[]) {
    const v = new Float32Array(384);
    v[0] = 1;
    return texts.map(() => v);
  },
};

describe('v19 contradiction/supersede warnings on the default add path', () => {
  it('surfaces a loud warning when a near-match is kept (op=ADD)', async () => {
    const db: Database.Database = createTestDb();
    const old = await handleStore(db, sameVecEmbedder, { content: 'alpha beta gamma delta zulu', title: 'Deploy note' });
    const n = await handleStore(db, sameVecEmbedder, { content: 'alpha beta gamma delta yankee' });

    expect(n.operation).toBe('ADD');
    expect(n.warnings).toBeDefined();
    expect(n.warnings!.length).toBeGreaterThanOrEqual(1);
    // names the conflicting memory + suggests the supersede remedy
    expect(n.warnings!.join('\n')).toContain(old.memory.id);
    expect(n.warnings!.join('\n')).toMatch(/supersede/i);
  });

  it('emits no warning when on_conflict=supersede already retired the old fact (op=DELETE)', async () => {
    const db: Database.Database = createTestDb();
    await handleStore(db, sameVecEmbedder, { content: 'alpha beta gamma delta zulu' });
    const n = await handleStore(db, sameVecEmbedder, {
      content: 'alpha beta gamma delta yankee',
      on_conflict: 'supersede',
    });
    expect(n.operation).toBe('DELETE');
    expect(n.warnings).toBeUndefined();
  });
});
