import { describe, it, expect, afterEach } from 'vitest';
import { TransformersEmbeddingProvider } from '../../embeddings/transformers.js';

const prev = process.env.MCP_MEMORY_DIMENSIONS;
afterEach(() => {
  if (prev === undefined) delete process.env.MCP_MEMORY_DIMENSIONS;
  else process.env.MCP_MEMORY_DIMENSIONS = prev;
});

describe('TransformersEmbeddingProvider dimensions are validated (EMB-3)', () => {
  it('throws on a non-numeric MCP_MEMORY_DIMENSIONS instead of yielding NaN', () => {
    process.env.MCP_MEMORY_DIMENSIONS = 'not-a-number';
    expect(() => new TransformersEmbeddingProvider()).toThrow(/MCP_MEMORY_DIMENSIONS/);
  });

  it('defaults to 384 when unset', () => {
    delete process.env.MCP_MEMORY_DIMENSIONS;
    expect(new TransformersEmbeddingProvider().dimensions).toBe(384);
  });

  it('honors an explicit constructor dims argument', () => {
    expect(new TransformersEmbeddingProvider('m', 512).dimensions).toBe(512);
  });
});
