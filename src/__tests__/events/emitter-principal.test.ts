/**
 * RBAC v1 §5 — webhook EMIT gate under a principal context. The legacy forced
 * gate (t.namespace === forcedNamespace()) would mis-route a multi-namespace
 * key: a write into namespaces[1] would match namespaces[0]'s targets and skip
 * the right tenant. Principal mode gates on the EVENT's own partition
 * (payload.namespace) with an exact match — wildcards (NULL namespace) stay
 * dropped, exactly as in the env-forced mode (battle-v16 WH-2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { emitMemoryEvent } from '../../events/emitter.js';
import { handleWebhook } from '../../tools/webhooks.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';

const KEY: PrincipalContext = {
  principal: 'multi-bot',
  keyId: 'key-1',
  namespaces: ['sales', 'marketing'],
  maxAccessLevel: 'internal',
};

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
  process.env.MCP_WEBHOOKS = '1';
});
afterEach(() => {
  db.close();
  delete process.env.MCP_WEBHOOKS;
});

async function register(url: string, namespace?: string): Promise<string> {
  const out = await handleWebhook(db, { action: 'register', url, events: '*', namespace });
  return (out.target as { id: string }).id;
}

function deliveredTargets(): string[] {
  return (db.prepare('SELECT target_id FROM webhook_deliveries').all() as Array<{
    target_id: string;
  }>).map((r) => r.target_id);
}

describe('emitMemoryEvent under a principal context', () => {
  it("matches the EVENT's own namespace, not the key default; wildcards dropped", async () => {
    const salesTarget = await register('https://hook.example.com/sales', 'sales');
    const marketingTarget = await register('https://hook.example.com/marketing', 'marketing');
    const wildcardTarget = await register('https://hook.example.com/all'); // NULL = wildcard
    const foreignTarget = await register('https://hook.example.com/hr', 'hr');

    // Write landed in the key's SECOND namespace → only marketing's target fires.
    const n = runWithPrincipal(KEY, () =>
      emitMemoryEvent(db, 'memory.created', {
        id: 'm1', scope: 'project', namespace: 'marketing', version: 1,
      }),
    );
    expect(n).toBe(1);
    expect(deliveredTargets()).toEqual([marketingTarget]);
    expect(deliveredTargets()).not.toContain(wildcardTarget);
    expect(deliveredTargets()).not.toContain(foreignTarget);

    // And a default-namespace write fires only the sales target.
    const n2 = runWithPrincipal(KEY, () =>
      emitMemoryEvent(db, 'memory.created', {
        id: 'm2', scope: 'project', namespace: 'sales', version: 1,
      }),
    );
    expect(n2).toBe(1);
    expect(deliveredTargets().sort()).toEqual([marketingTarget, salesTarget].sort());
  });

  it('a payload with NO namespace matches nothing under a principal (fail closed)', async () => {
    await register('https://hook.example.com/sales', 'sales');
    await register('https://hook.example.com/all'); // wildcard
    const n = runWithPrincipal(KEY, () =>
      emitMemoryEvent(db, 'memory.created', { id: 'm3', scope: 'global', version: 1 }),
    );
    expect(n).toBe(0);
    expect(deliveredTargets()).toEqual([]);
  });

  it('unscoped (no ctx, no env): wildcard + payload-match behaviour unchanged', async () => {
    const wildcard = await register('https://hook.example.com/all');
    const salesTarget = await register('https://hook.example.com/sales', 'sales');
    const foreign = await register('https://hook.example.com/hr', 'hr');
    const n = emitMemoryEvent(db, 'memory.created', {
      id: 'm4', scope: 'project', namespace: 'sales', version: 1,
    });
    expect(n).toBe(2); // wildcard + exact match, foreign filtered
    expect(deliveredTargets().sort()).toEqual([salesTarget, wildcard].sort());
    expect(deliveredTargets()).not.toContain(foreign);
  });
});
