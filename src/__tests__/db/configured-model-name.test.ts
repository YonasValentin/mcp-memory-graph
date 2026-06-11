import { describe, it, expect, afterEach } from 'vitest';
import { configuredModelName } from '../../db/schema.js';
import { TransformersEmbeddingProvider } from '../../embeddings/transformers.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../constants/enums.js';

const prevModel = process.env.MCP_MEMORY_MODEL;
afterEach(() => {
  if (prevModel === undefined) delete process.env.MCP_MEMORY_MODEL;
  else process.env.MCP_MEMORY_MODEL = prevModel;
});

describe('configuredModelName() empty-string resolution', () => {
  it('falls back to DEFAULT_EMBEDDING_MODEL when MCP_MEMORY_MODEL is unset', () => {
    delete process.env.MCP_MEMORY_MODEL;
    expect(configuredModelName()).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('falls back to DEFAULT_EMBEDDING_MODEL when MCP_MEMORY_MODEL is the empty string', () => {
    process.env.MCP_MEMORY_MODEL = '';
    expect(configuredModelName()).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('falls back to DEFAULT_EMBEDDING_MODEL when MCP_MEMORY_MODEL is whitespace-only', () => {
    process.env.MCP_MEMORY_MODEL = '   ';
    expect(configuredModelName()).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('returns the literal value when a real model is set', () => {
    process.env.MCP_MEMORY_MODEL = 'Xenova/bge-small-en-v1.5';
    expect(configuredModelName()).toBe('Xenova/bge-small-en-v1.5');
  });
});

describe('TransformersEmbeddingProvider.modelName empty-string resolution', () => {
  it('resolves an empty MCP_MEMORY_MODEL to DEFAULT_EMBEDDING_MODEL (matches transformers.js auto-fallback)', () => {
    process.env.MCP_MEMORY_MODEL = '';
    const provider = new TransformersEmbeddingProvider();
    expect(provider.modelName).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('still honours an explicit constructor argument over the env var', () => {
    process.env.MCP_MEMORY_MODEL = '';
    const provider = new TransformersEmbeddingProvider('Xenova/bge-small-en-v1.5');
    expect(provider.modelName).toBe('Xenova/bge-small-en-v1.5');
  });
});
