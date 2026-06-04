import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import {
  registerWebhookTarget,
  listWebhookTargets,
  deleteWebhookTarget,
  getReadyDeliveries,
  countPendingDeliveries,
  getWebhookTarget,
} from '../../events/store.js';
import { emitMemoryEvent, webhooksEnabled } from '../../events/emitter.js';
import { dispatchPendingWebhooks, signWebhookBody } from '../../events/dispatcher.js';
import { SsrfError } from '../../events/ssrf-guard.js';

const PAYLOAD = { id: 'm1', scope: 'project', namespace: 'ns', title: 'T' };

function fakeFetch(status: number, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
}

const publicLookup = async () => [{ address: '93.184.216.34' }];

describe('webhook bus: registration', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('registers a public https target and lists it', () => {
    const t = registerWebhookTarget(db, { url: 'https://hooks.example.com/x', secret: 's' });
    expect(t.url).toBe('https://hooks.example.com/x');
    expect(listWebhookTargets(db)).toHaveLength(1);
  });

  it('refuses an SSRF target at registration', () => {
    expect(() => registerWebhookTarget(db, { url: 'http://169.254.169.254/x' })).toThrow(SsrfError);
    expect(() => registerWebhookTarget(db, { url: 'http://127.0.0.1/x' })).toThrow(SsrfError);
    expect(listWebhookTargets(db)).toHaveLength(0);
  });

  it('deletes a target and cascades its deliveries', () => {
    const t = registerWebhookTarget(db, { url: 'https://hooks.example.com/x' });
    process.env.MCP_WEBHOOKS = '1';
    emitMemoryEvent(db, 'memory.created', PAYLOAD);
    delete process.env.MCP_WEBHOOKS;
    expect(countPendingDeliveries(db)).toBe(1);
    expect(deleteWebhookTarget(db, t.id)).toBe(true);
    expect(countPendingDeliveries(db)).toBe(0); // cascaded
  });
});

describe('webhook bus: emit gating + filtering', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    delete process.env.MCP_WEBHOOKS;
  });
  afterEach(() => {
    db.close();
    delete process.env.MCP_WEBHOOKS;
  });

  it('is OFF by default — emits nothing without MCP_WEBHOOKS', () => {
    registerWebhookTarget(db, { url: 'https://hooks.example.com/x' });
    expect(webhooksEnabled()).toBe(false);
    expect(emitMemoryEvent(db, 'memory.created', PAYLOAD)).toBe(0);
    expect(countPendingDeliveries(db)).toBe(0);
  });

  it('enqueues for all-event targets when enabled', () => {
    registerWebhookTarget(db, { url: 'https://a.example.com/x' });
    process.env.MCP_WEBHOOKS = '1';
    expect(emitMemoryEvent(db, 'memory.created', PAYLOAD)).toBe(1);
    expect(countPendingDeliveries(db)).toBe(1);
  });

  it('respects event-type subscription filter', () => {
    registerWebhookTarget(db, { url: 'https://a.example.com/x', events: 'memory.deleted' });
    process.env.MCP_WEBHOOKS = '1';
    expect(emitMemoryEvent(db, 'memory.created', PAYLOAD)).toBe(0);
    expect(emitMemoryEvent(db, 'memory.deleted', PAYLOAD)).toBe(1);
  });

  it('respects scope/namespace filter', () => {
    registerWebhookTarget(db, { url: 'https://a.example.com/x', scope: 'other' });
    process.env.MCP_WEBHOOKS = '1';
    expect(emitMemoryEvent(db, 'memory.created', PAYLOAD)).toBe(0); // scope mismatch
    registerWebhookTarget(db, { url: 'https://b.example.com/x', scope: 'project', namespace: 'ns' });
    expect(emitMemoryEvent(db, 'memory.created', PAYLOAD)).toBe(1); // matches b only
  });
});

describe('webhook bus: dispatch', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    process.env.MCP_WEBHOOKS = '1';
  });
  afterEach(() => {
    db.close();
    delete process.env.MCP_WEBHOOKS;
  });

  it('delivers on 2xx, signs the body, resets target failures', async () => {
    registerWebhookTarget(db, { url: 'https://hooks.example.com/x', secret: 'topsecret' });
    emitMemoryEvent(db, 'memory.created', PAYLOAD);
    let seenSig: string | undefined;
    let seenBody: string | undefined;
    const fetchImpl = fakeFetch(200, (_u, init) => {
      seenSig = (init.headers as Record<string, string>)['x-memory-signature'];
      seenBody = init.body as string;
    });
    const res = await dispatchPendingWebhooks(db, { fetchImpl, lookup: publicLookup });
    expect(res.delivered).toBe(1);
    expect(seenSig).toBe(signWebhookBody('topsecret', seenBody!));
    expect(countPendingDeliveries(db)).toBe(0);
    const ready = getReadyDeliveries(db, new Date().toISOString());
    expect(ready).toHaveLength(0);
  });

  it('retries with backoff on failure and bumps failure_count', async () => {
    const t = registerWebhookTarget(db, { url: 'https://hooks.example.com/x' });
    emitMemoryEvent(db, 'memory.created', PAYLOAD);
    // `now` must be >= the real enqueue time (rows stamp next_attempt_at with the
    // wall clock); use a small margin past now so the delivery is due.
    const now = new Date(Date.now() + 1_000);
    const res = await dispatchPendingWebhooks(db, {
      fetchImpl: fakeFetch(500),
      lookup: publicLookup,
      now,
    });
    expect(res.failed).toBe(1);
    expect(res.delivered).toBe(0);
    const target = getWebhookTarget(db, t.id)!;
    expect(target.failure_count).toBe(1);
    // not ready again immediately (backoff pushed next_attempt into the future)
    expect(getReadyDeliveries(db, now.toISOString())).toHaveLength(0);
    const later = new Date(now.getTime() + 31_000).toISOString();
    expect(getReadyDeliveries(db, later)).toHaveLength(1);
  });

  it('dead-letters after maxAttempts', async () => {
    registerWebhookTarget(db, { url: 'https://hooks.example.com/x' });
    emitMemoryEvent(db, 'memory.created', PAYLOAD);
    let now = new Date(Date.now() + 1_000);
    let dead = 0;
    for (let i = 0; i < 6; i++) {
      const r = await dispatchPendingWebhooks(db, {
        fetchImpl: fakeFetch(500),
        lookup: publicLookup,
        now,
        maxAttempts: 3,
        circuitThreshold: 99, // isolate dead-letter from circuit breaker
      });
      dead += r.dead;
      now = new Date(now.getTime() + 3_600_000); // jump past any backoff
    }
    expect(dead).toBe(1);
    expect(countPendingDeliveries(db)).toBe(0); // dead is terminal, not pending
  });

  it('opens the circuit breaker after the threshold and parks the target', async () => {
    registerWebhookTarget(db, { url: 'https://hooks.example.com/x' });
    // three separate events so three deliveries exist
    emitMemoryEvent(db, 'memory.created', { ...PAYLOAD, id: 'a' });
    emitMemoryEvent(db, 'memory.created', { ...PAYLOAD, id: 'b' });
    emitMemoryEvent(db, 'memory.created', { ...PAYLOAD, id: 'c' });
    const now = new Date(Date.now() + 1_000);
    const res = await dispatchPendingWebhooks(db, {
      fetchImpl: fakeFetch(503),
      lookup: publicLookup,
      now,
      circuitThreshold: 2,
    });
    expect(res.failed).toBe(3);
    const t = listWebhookTargets(db)[0];
    expect(t.circuit_open_until).not.toBeNull();
    // circuit open → nothing ready even far in the future (until cooldown elapses)
    const soon = new Date(now.getTime() + 60_000).toISOString();
    expect(getReadyDeliveries(db, soon)).toHaveLength(0);
  });

  it('does not double-deliver under concurrent dispatch (atomic claim)', async () => {
    registerWebhookTarget(db, { url: 'https://hooks.example.com/x' });
    emitMemoryEvent(db, 'memory.created', PAYLOAD);
    let posts = 0;
    const fetchImpl = fakeFetch(200, () => {
      posts += 1;
    });
    // Two dispatchers racing the same queue. The atomic claim must ensure the
    // single delivery is POSTed exactly once across both.
    const [a, b] = await Promise.all([
      dispatchPendingWebhooks(db, { fetchImpl, lookup: publicLookup }),
      dispatchPendingWebhooks(db, { fetchImpl, lookup: publicLookup }),
    ]);
    expect(posts).toBe(1);
    expect(a.delivered + b.delivered).toBe(1);
  });

  it('blocks a target whose host resolves to a private IP at dispatch (DNS rebinding)', async () => {
    registerWebhookTarget(db, { url: 'https://rebind.example.com/x' });
    emitMemoryEvent(db, 'memory.created', PAYLOAD);
    let fetched = false;
    const fetchImpl = fakeFetch(200, () => {
      fetched = true;
    });
    const privateLookup = async () => [{ address: '10.0.0.5' }];
    const res = await dispatchPendingWebhooks(db, { fetchImpl, lookup: privateLookup });
    expect(fetched).toBe(false); // never POSTed
    expect(res.delivered).toBe(0);
    expect(res.failed).toBe(1);
  });
});
