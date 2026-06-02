/**
 * T1 — MCP-layer tenancy tests. These cover the shared policy module that BOTH
 * surfaces call: the MCP stdio tools (server.ts) and the REST read API
 * (api/routes.ts). The REST behaviour is also covered end-to-end in
 * api/remote-namespace.test.ts; this pins the MCP side (server.ts uses these
 * exact helpers for withForcedNs / idInForcedNs / the query_structured filter).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  forcedNamespace,
  scopeToNamespace,
  scopeFilterToNamespace,
  idIsInForcedNamespace,
} from '../../lib/tenancy.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { handleStore } from '../../tools/store.js';

const prev = process.env.MCP_API_NAMESPACE;
afterEach(() => {
  if (prev === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prev;
});

describe('forcedNamespace (length-checked env reader)', () => {
  it('returns undefined when unset or empty, the value when set', () => {
    delete process.env.MCP_API_NAMESPACE;
    expect(forcedNamespace()).toBeUndefined();
    process.env.MCP_API_NAMESPACE = '';
    expect(forcedNamespace()).toBeUndefined();
    process.env.MCP_API_NAMESPACE = 'team';
    expect(forcedNamespace()).toBe('team');
  });
});

describe('scopeToNamespace (= withForcedNs)', () => {
  it('overrides any caller namespace when scoping is on', () => {
    process.env.MCP_API_NAMESPACE = 'nsA';
    expect(scopeToNamespace({ namespace: 'nsB', limit: 5 })).toEqual({ namespace: 'nsA', limit: 5 });
  });
  it('passes options through untouched when scoping is off', () => {
    delete process.env.MCP_API_NAMESPACE;
    const opts = { namespace: 'nsB', limit: 5 };
    expect(scopeToNamespace(opts)).toBe(opts);
  });
});

describe('scopeFilterToNamespace (query_structured case)', () => {
  it('forces namespace under filter, preserving other filter fields', () => {
    process.env.MCP_API_NAMESPACE = 'nsA';
    expect(
      scopeFilterToNamespace({ filter: { namespace: 'nsB', scope: 'project' }, limit: 10 }),
    ).toEqual({ filter: { namespace: 'nsA', scope: 'project' }, limit: 10 });
  });
  it('creates a filter when none was supplied', () => {
    process.env.MCP_API_NAMESPACE = 'nsA';
    expect(scopeFilterToNamespace({ limit: 10 })).toEqual({ filter: { namespace: 'nsA' }, limit: 10 });
  });
  it('passes through untouched when scoping is off', () => {
    delete process.env.MCP_API_NAMESPACE;
    const opts = { filter: { namespace: 'nsB' }, limit: 10 };
    expect(scopeFilterToNamespace(opts)).toBe(opts);
  });
});

describe('idIsInForcedNamespace (by-id ownership)', () => {
  let db: Database.Database;
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db?.close();
  });

  it('allows any id when scoping is off', async () => {
    delete process.env.MCP_API_NAMESPACE;
    const a = await handleStore(db, embedder, { content: 'x', scope: 'project', namespace: 'nsA' });
    expect(idIsInForcedNamespace(db, a.memory.id)).toBe(true);
    expect(idIsInForcedNamespace(db, 'no-such-id')).toBe(true);
  });

  it('allows own-namespace ids and rejects foreign / unknown ids when scoped', async () => {
    process.env.MCP_API_NAMESPACE = 'nsA';
    const own = await handleStore(db, embedder, { content: 'own', scope: 'project', namespace: 'nsA' });
    const foreign = await handleStore(db, embedder, { content: 'foreign', scope: 'project', namespace: 'nsB' });
    expect(idIsInForcedNamespace(db, own.memory.id)).toBe(true);
    expect(idIsInForcedNamespace(db, foreign.memory.id)).toBe(false);
    expect(idIsInForcedNamespace(db, 'no-such-id')).toBe(false);
  });
});
