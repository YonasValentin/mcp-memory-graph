/**
 * RBAC v1 §2 — tenancy helpers in PRINCIPAL mode (AsyncLocalStorage context).
 * Resolution order: principal ctx → MCP_API_NAMESPACE env → unscoped. The
 * legacy env-pinned behaviour is pinned byte-identically by the EXISTING
 * tenancy test files (which run with no ALS context and must pass unmodified);
 * this file covers the new per-request mode:
 *   - scopeToNamespace / scopeFilterToNamespace: member → keep, unset →
 *     default ctx.namespaces[0], foreign → throw 'Namespace not permitted'
 *     (explicit deny beats silent redirect — a silent rewrite of a
 *     caller-chosen foreign namespace would corrupt writes).
 *   - idIsInForcedNamespace / vaultPathInForcedNamespace: SET-membership.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  forcedNamespace,
  scopeToNamespace,
  scopeFilterToNamespace,
  idIsInForcedNamespace,
  vaultPathInForcedNamespace,
} from '../../lib/tenancy.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { handleStore } from '../../tools/store.js';

const KEY: PrincipalContext = {
  principal: 'sales-bot',
  keyId: 'key-1',
  namespaces: ['sales', 'marketing'],
  maxAccessLevel: 'internal',
};

const prev = process.env.MCP_API_NAMESPACE;
afterEach(() => {
  if (prev === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prev;
});

describe('forcedNamespace — resolution order', () => {
  it('principal ctx → namespaces[0] (the per-request default)', () => {
    delete process.env.MCP_API_NAMESPACE;
    expect(runWithPrincipal(KEY, () => forcedNamespace())).toBe('sales');
  });

  it('principal ctx WINS over a set env (env is the legacy fallback only)', () => {
    process.env.MCP_API_NAMESPACE = 'env-tenant';
    expect(runWithPrincipal(KEY, () => forcedNamespace())).toBe('sales');
    expect(forcedNamespace()).toBe('env-tenant'); // outside the run: env again
  });
});

describe('scopeToNamespace — principal mode', () => {
  beforeEach(() => {
    delete process.env.MCP_API_NAMESPACE;
  });

  it('member namespace is KEPT (multi-namespace key switches per call)', () => {
    const opts = { namespace: 'marketing', limit: 5 };
    const out = runWithPrincipal(KEY, () => scopeToNamespace(opts));
    expect(out).toEqual({ namespace: 'marketing', limit: 5 });
  });

  it('unset namespace defaults to namespaces[0]', () => {
    const out = runWithPrincipal(KEY, () => scopeToNamespace({ limit: 5 } as { namespace?: string; limit: number }));
    expect(out).toEqual({ namespace: 'sales', limit: 5 });
  });

  it("foreign namespace THROWS 'Namespace not permitted' (no silent redirect)", () => {
    expect(() =>
      runWithPrincipal(KEY, () => scopeToNamespace({ namespace: 'hr', limit: 5 })),
    ).toThrow('Namespace not permitted');
  });

  it('principal rules apply even when env is ALSO set (ctx wins)', () => {
    process.env.MCP_API_NAMESPACE = 'hr';
    // env says hr, but the key does not include hr → still denied.
    expect(() =>
      runWithPrincipal(KEY, () => scopeToNamespace({ namespace: 'hr' })),
    ).toThrow('Namespace not permitted');
    // and an unset namespace defaults to the KEY's default, not the env value.
    expect(runWithPrincipal(KEY, () => scopeToNamespace({})).namespace).toBe('sales');
  });
});

describe('scopeFilterToNamespace — principal mode', () => {
  beforeEach(() => {
    delete process.env.MCP_API_NAMESPACE;
  });

  it('member filter.namespace is KEPT, other filter fields preserved', () => {
    const opts = { filter: { namespace: 'marketing', scope: 'project' }, limit: 10 };
    const out = runWithPrincipal(KEY, () => scopeFilterToNamespace(opts));
    expect(out).toEqual({ filter: { namespace: 'marketing', scope: 'project' }, limit: 10 });
  });

  it('unset filter.namespace defaults to namespaces[0] (filter created if absent)', () => {
    const noFilter = runWithPrincipal(KEY, () => scopeFilterToNamespace({ limit: 10 }));
    expect(noFilter).toEqual({ filter: { namespace: 'sales' }, limit: 10 });
    const partial = runWithPrincipal(KEY, () =>
      scopeFilterToNamespace({ filter: { scope: 'project' } as { scope?: string; namespace?: string }, limit: 10 }),
    );
    expect(partial).toEqual({ filter: { scope: 'project', namespace: 'sales' }, limit: 10 });
  });

  it('foreign filter.namespace THROWS', () => {
    expect(() =>
      runWithPrincipal(KEY, () => scopeFilterToNamespace({ filter: { namespace: 'hr' } })),
    ).toThrow('Namespace not permitted');
  });
});

describe('idIsInForcedNamespace — principal mode is SET-membership', () => {
  let db: Database.Database;
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  beforeEach(() => {
    delete process.env.MCP_API_NAMESPACE;
    db = createTestDb();
  });
  afterEach(() => {
    db?.close();
  });

  it('allows ANY member namespace, rejects foreign and unknown ids', async () => {
    const inDefault = await handleStore(db, embedder, {
      content: 'sales doc', scope: 'project', namespace: 'sales',
    });
    const inSecond = await handleStore(db, embedder, {
      content: 'marketing doc', scope: 'project', namespace: 'marketing',
    });
    const foreign = await handleStore(db, embedder, {
      content: 'hr doc', scope: 'project', namespace: 'hr',
    });
    runWithPrincipal(KEY, () => {
      expect(idIsInForcedNamespace(db, inDefault.memory.id)).toBe(true);
      expect(idIsInForcedNamespace(db, inSecond.memory.id)).toBe(true); // membership, not equality
      expect(idIsInForcedNamespace(db, foreign.memory.id)).toBe(false);
      expect(idIsInForcedNamespace(db, 'no-such-id')).toBe(false); // non-confirmation preserved
    });
  });

  it('a NULL-namespace row is NOT a member of any principal set', async () => {
    const nullNs = await handleStore(db, embedder, { content: 'global note', scope: 'global' });
    runWithPrincipal(KEY, () => {
      expect(idIsInForcedNamespace(db, nullNs.memory.id)).toBe(false);
    });
  });
});

describe('vaultPathInForcedNamespace — principal mode is SET-membership', () => {
  beforeEach(() => {
    delete process.env.MCP_API_NAMESPACE;
  });

  it('any member basename passes, foreign fails, trailing separator tolerated', () => {
    runWithPrincipal(KEY, () => {
      expect(vaultPathInForcedNamespace('/vaults/sales')).toBe(true);
      expect(vaultPathInForcedNamespace('/vaults/marketing')).toBe(true);
      expect(vaultPathInForcedNamespace('/vaults/marketing/')).toBe(true);
      expect(vaultPathInForcedNamespace('/vaults/hr')).toBe(false);
    });
    // outside the run, unscoped → unrestricted (legacy local default)
    expect(vaultPathInForcedNamespace('/vaults/hr')).toBe(true);
  });
});
