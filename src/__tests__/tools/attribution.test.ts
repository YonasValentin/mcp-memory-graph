/**
 * Pillar 7 (T22): multi-agent / team attribution.
 *
 * Tracks WHICH agent wrote WHICH memory via an additive `agent_id` column,
 * distinct from the existing `author` (human/source). Covers the schema v9
 * column, store's agent_id propagation (explicit input, env default, null
 * default = today's behaviour) and the read-only handleAttribution provenance
 * rollup (by_agent / by_author / total) with scope/namespace + bi-temporal
 * filtering. Uses createTestDb + MockEmbeddingProvider so runs stay isolated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleAttribution } from '../../tools/attribution.js';
import { getMemoryById, invalidateMemory } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  delete process.env.MCP_AGENT_ID;
});

describe('migration v9: agent_id column', () => {
  it('a fresh createTestDb has an agent_id column on memories', () => {
    const cols = db
      .prepare('PRAGMA table_info(memories)')
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'agent_id')).toBe(true);
  });
});

describe('handleStore agent_id propagation', () => {
  it('stores an explicit input.agent_id', async () => {
    const res = await handleStore(db, embedder, {
      content: 'Wrote the auth refactor.',
      agent_id: 'agent-A',
    });
    const row = getMemoryById(db, res.memory.id);
    expect(row?.agent_id).toBe('agent-A');
    expect(res.memory.agent_id).toBe('agent-A');
  });

  it('defaults agent_id to null without input and without env (today\'s behaviour)', async () => {
    const res = await handleStore(db, embedder, { content: 'No agent here.' });
    const row = getMemoryById(db, res.memory.id);
    expect(row?.agent_id ?? null).toBeNull();
    expect(res.memory.agent_id).toBeNull();
  });

  it('falls back to MCP_AGENT_ID env when no input.agent_id is given', async () => {
    process.env.MCP_AGENT_ID = 'deploy-1';
    const res = await handleStore(db, embedder, { content: 'Tagged by deployment.' });
    const row = getMemoryById(db, res.memory.id);
    expect(row?.agent_id).toBe('deploy-1');
    expect(res.memory.agent_id).toBe('deploy-1');
  });

  it('explicit input.agent_id overrides the env default', async () => {
    process.env.MCP_AGENT_ID = 'deploy-1';
    const res = await handleStore(db, embedder, {
      content: 'Explicit wins.',
      agent_id: 'agent-B',
    });
    const row = getMemoryById(db, res.memory.id);
    expect(row?.agent_id).toBe('agent-B');
  });
});

describe('handleAttribution', () => {
  it('rolls up by_agent (incl. unattributed), by_author, and total', async () => {
    await handleStore(db, embedder, { content: 'm1', agent_id: 'agent-A', author: 'alice' });
    await handleStore(db, embedder, { content: 'm2', agent_id: 'agent-A', author: 'bob' });
    await handleStore(db, embedder, { content: 'm3', agent_id: 'agent-B', author: 'alice' });
    await handleStore(db, embedder, { content: 'm4', author: 'alice' }); // no agent_id

    const result = handleAttribution(db, {});
    expect(result.total).toBe(4);
    expect(result.by_agent['agent-A']).toBe(2);
    expect(result.by_agent['agent-B']).toBe(1);
    expect(result.by_agent.unattributed).toBe(1);
    expect(result.by_author.alice).toBe(3);
    expect(result.by_author.bob).toBe(1);
  });

  it('filters by scope/namespace', async () => {
    await handleStore(db, embedder, { content: 'p1', scope: 'project', namespace: 'acme', agent_id: 'agent-A' });
    await handleStore(db, embedder, { content: 'p2', scope: 'project', namespace: 'acme', agent_id: 'agent-A' });
    await handleStore(db, embedder, { content: 'g1', scope: 'global', agent_id: 'agent-Z' });

    const result = handleAttribution(db, { scope: 'project', namespace: 'acme' });
    expect(result.total).toBe(2);
    expect(result.by_agent['agent-A']).toBe(2);
    expect(result.by_agent['agent-Z']).toBeUndefined();
  });

  it('excludes bi-temporally invalidated memories', async () => {
    const a = await handleStore(db, embedder, { content: 'live', agent_id: 'agent-A' });
    const b = await handleStore(db, embedder, { content: 'retired', agent_id: 'agent-A' });
    invalidateMemory(db, b.memory.id);

    const result = handleAttribution(db, {});
    expect(result.total).toBe(1);
    expect(result.by_agent['agent-A']).toBe(1);
    expect(a.memory.id).toBeDefined();
  });
});
