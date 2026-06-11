/**
 * RBAC v1 §5 — memory_links read guard under a principal context. The legacy
 * foreignEndpointGuard pinned the OTHER endpoint to the single forced
 * namespace; equality against namespaces[0] would hide a multi-namespace key's
 * own edges whose endpoints live in namespaces[1]. Principal mode is
 * SET-membership: an edge is visible iff its other endpoint's namespace is in
 * the key's permitted set — exactly the rows the key may read by id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import {
  createMemoryLink,
  getOutgoingLinks,
  getBacklinks,
} from '../../graph/memory-links.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';

const KEY: PrincipalContext = {
  principal: 'multi-bot',
  keyId: 'key-1',
  namespaces: ['sales', 'marketing'],
  maxAccessLevel: 'internal',
};

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
const prev = process.env.MCP_API_NAMESPACE;
beforeEach(() => {
  delete process.env.MCP_API_NAMESPACE;
  db = createTestDb();
});
afterEach(() => {
  db.close();
  if (prev === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prev;
});

async function store(content: string, namespace: string): Promise<string> {
  const r = await handleStore(db, embedder, { content, scope: 'project', namespace });
  return r.memory.id;
}

describe('foreignEndpointGuard under a principal context', () => {
  it('shows edges to ANY member namespace, hides foreign endpoints', async () => {
    const a = await store('note in sales', 'sales');
    const b = await store('note in marketing', 'marketing');
    const c = await store('note in hr', 'hr');
    // Build the edges UNSCOPED (legitimate pre-existing graph, e.g. a migrated
    // single-user corpus later served multi-tenant).
    expect(createMemoryLink(db, { sourceId: a, targetId: b })).not.toBe('');
    expect(createMemoryLink(db, { sourceId: a, targetId: c })).not.toBe('');

    runWithPrincipal(KEY, () => {
      const out = getOutgoingLinks(db, a);
      expect(out.map((l) => l.target_memory_id)).toEqual([b]); // c (hr) hidden
      const back = getBacklinks(db, b);
      expect(back.map((l) => l.source_memory_id)).toEqual([a]); // a (sales) visible
    });

    // Unscoped: both edges visible (single-user behaviour unchanged).
    expect(getOutgoingLinks(db, a)).toHaveLength(2);
  });

  it('a backlink from a foreign source is hidden', async () => {
    const mine = await store('target in sales', 'sales');
    const foreign = await store('source in hr', 'hr');
    expect(createMemoryLink(db, { sourceId: foreign, targetId: mine })).not.toBe('');
    runWithPrincipal(KEY, () => {
      expect(getBacklinks(db, mine)).toHaveLength(0);
    });
    expect(getBacklinks(db, mine)).toHaveLength(1);
  });

  it('createMemoryLink still refuses cross-namespace edges under a principal', async () => {
    const a = await store('sales note', 'sales');
    const b = await store('marketing note', 'marketing');
    const sameNsTarget = await store('another sales note', 'sales');
    runWithPrincipal(KEY, () => {
      // forcedNamespace() is truthy in principal mode → the same-namespace
      // invariant applies, even between the key's OWN namespaces.
      expect(createMemoryLink(db, { sourceId: a, targetId: b })).toBe('');
      expect(createMemoryLink(db, { sourceId: a, targetId: sameNsTarget })).not.toBe('');
    });
  });
});
