import { describe, it, expect } from 'vitest';
import type { EmbeddingProvider } from '../../types.js';
import {
  EmbeddingRegistry,
  selectEmbedder,
  truncateTo,
} from '../../embeddings/registry.js';
import { OllamaEmbeddingProvider } from '../../embeddings/ollama.js';

/** Minimal stub provider that emits a constant vector of a given dimension. */
class StubProvider implements EmbeddingProvider {
  constructor(readonly modelName: string, readonly dimensions: number, private fill = 1) {}
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(): Promise<Float32Array> {
    return new Float32Array(this.dimensions).fill(this.fill);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimensions).fill(this.fill));
  }
}

describe('M6.4 EmbeddingRegistry', () => {
  it('registers, retrieves, and treats the first provider as local', () => {
    const r = new EmbeddingRegistry();
    r.register('local', new StubProvider('local', 384));
    r.register('remote', new StubProvider('remote', 384));
    expect(r.has('remote')).toBe(true);
    expect(r.localKey).toBe('local');
    expect(r.get('remote').modelName).toBe('remote');
  });

  it('honors an explicit local:true designation', () => {
    const r = new EmbeddingRegistry();
    r.register('remote', new StubProvider('remote', 384));
    r.register('local', new StubProvider('local', 384), { local: true });
    expect(r.localKey).toBe('local');
  });

  it('throws on duplicate key and unknown key', () => {
    const r = new EmbeddingRegistry();
    r.register('a', new StubProvider('a', 384));
    expect(() => r.register('a', new StubProvider('a', 384))).toThrow(/already registered/);
    expect(() => r.get('nope')).toThrow(/Unknown embedding provider/);
  });
});

describe('M6.4 selectEmbedder privacy gate', () => {
  const r = new EmbeddingRegistry();
  r.register('local', new StubProvider('local', 384));
  r.register('remote', new StubProvider('remote', 384));

  it('FORCES local for confidential/restricted regardless of preference', () => {
    for (const access_level of ['confidential', 'restricted'] as const) {
      const p = selectEmbedder(r, { operation: 'store', access_level, scope: 'project', preferred: 'remote' });
      expect(p.modelName).toBe('local');
    }
  });

  it('honors preferred for public/internal when registered', () => {
    const p = selectEmbedder(r, { operation: 'store', access_level: 'public', scope: 'project', preferred: 'remote' });
    expect(p.modelName).toBe('remote');
  });

  it('falls back to local for an unregistered preference', () => {
    const p = selectEmbedder(r, { operation: 'store', access_level: 'internal', scope: 'project', preferred: 'ghost' });
    expect(p.modelName).toBe('local');
  });
});

describe('M6.4 truncateTo (Matryoshka, single-dim invariant)', () => {
  it('returns the same provider when dimensions already match', () => {
    const p = new StubProvider('p', 384);
    expect(truncateTo(p, 384)).toBe(p);
  });

  it('truncates a wider provider to the DB dimension and renormalizes to unit length', async () => {
    const wide = new StubProvider('wide', 768, 1);
    const adapted = truncateTo(wide, 384);
    expect(adapted.dimensions).toBe(384);
    const v = await adapted.embed('x');
    expect(v.length).toBe(384);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('refuses to up-project a narrower provider', () => {
    expect(() => truncateTo(new StubProvider('narrow', 128), 384)).toThrow(/narrower/);
  });
});

describe('M6.4 OllamaEmbeddingProvider (injected fetch — no network)', () => {
  function fakeFetch(rows: number[][], status = 200): typeof fetch {
    return (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ embeddings: rows }),
      text: async () => 'err',
    })) as unknown as typeof fetch;
  }

  it('embeds via /api/embed and validates the returned dimension', async () => {
    const p = new OllamaEmbeddingProvider({
      model: 'all-minilm',
      dimensions: 3,
      fetchImpl: fakeFetch([[0.1, 0.2, 0.3]]),
    });
    await p.initialize();
    expect(p.isReady()).toBe(true);
    const v = await p.embed('hello');
    expect(Array.from(v)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });

  it('throws on a dimension mismatch (memories_vec would hard-throw)', async () => {
    const p = new OllamaEmbeddingProvider({ model: 'm', dimensions: 4, fetchImpl: fakeFetch([[1, 2, 3]]) });
    await expect(p.embed('x')).rejects.toThrow(/dimension/);
  });

  it('throws on a non-OK HTTP response', async () => {
    const p = new OllamaEmbeddingProvider({ model: 'm', dimensions: 3, fetchImpl: fakeFetch([], 500) });
    await expect(p.embed('x')).rejects.toThrow(/HTTP 500/);
  });

  it('batch embeds and returns one vector per input', async () => {
    const p = new OllamaEmbeddingProvider({
      model: 'm',
      dimensions: 2,
      fetchImpl: fakeFetch([[1, 0], [0, 1]]),
    });
    const out = await p.embedBatch(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[1].length).toBe(2);
  });
});
