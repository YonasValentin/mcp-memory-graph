import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleWebhook } from '../../tools/webhooks.js';
import { registerWebhookTarget } from '../../events/store.js';
import { emitMemoryEvent } from '../../events/emitter.js';

/**
 * Covers the `memory_webhook` tool handler (src/tools/webhooks.ts): the gate,
 * every action branch, and the secret-redacting safeView projection. The
 * underlying bus is exercised separately by events/webhook-bus.test.ts.
 */
describe('handleWebhook (memory_webhook tool)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
    delete process.env.MCP_WEBHOOKS;
  });

  describe('when the bus is disabled', () => {
    it('returns a disabled notice and defaults the action to list', async () => {
      delete process.env.MCP_WEBHOOKS;
      const res = await handleWebhook(db, {});
      expect(res).toMatchObject({ action: 'list', enabled: false });
      expect(String(res.message)).toMatch(/MCP_WEBHOOKS=1/);
    });
  });

  describe('when the bus is enabled', () => {
    beforeEach(() => {
      process.env.MCP_WEBHOOKS = '1';
    });

    it('register: persists a target and returns a secret-redacted view', async () => {
      const res = await handleWebhook(db, {
        action: 'register',
        url: 'https://hooks.example.com/x',
        secret: 'shhh',
        events: 'memory.created',
        scope: 'project',
        namespace: 'ns',
      });
      expect(res.enabled).toBe(true);
      const target = res.target as Record<string, unknown>;
      expect(target.url).toBe('https://hooks.example.com/x');
      expect(target.has_secret).toBe(true); // secret present → boolean, never the value
      expect(target).not.toHaveProperty('secret');
      expect(target.active).toBe(true);
      expect(target.scope).toBe('project');
    });

    it('register: throws when url is missing', async () => {
      await expect(handleWebhook(db, { action: 'register' })).rejects.toThrow(/requires a url/);
    });

    it('list: returns every target, has_secret false when none was set', async () => {
      registerWebhookTarget(db, { url: 'https://hooks.example.com/a' }); // no secret
      const res = await handleWebhook(db, { action: 'list' });
      expect(res.enabled).toBe(true);
      const targets = res.targets as Array<Record<string, unknown>>;
      expect(targets).toHaveLength(1);
      expect(targets[0].has_secret).toBe(false);
    });

    it('delete: removes a target and reports the outcome', async () => {
      const t = registerWebhookTarget(db, { url: 'https://hooks.example.com/b' });
      const res = await handleWebhook(db, { action: 'delete', id: t.id });
      expect(res).toMatchObject({ action: 'delete', enabled: true, deleted: true });
    });

    it('delete: throws when id is missing', async () => {
      await expect(handleWebhook(db, { action: 'delete' })).rejects.toThrow(/requires an id/);
    });

    it('dispatch: drains the queue and returns the dispatch result', async () => {
      // Stub fetch so the dispatcher does no real egress (a 200 → delivered).
      vi.stubGlobal('fetch', (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch);
      try {
        registerWebhookTarget(db, { url: 'https://hooks.example.com/c' });
        emitMemoryEvent(db, 'memory.created', { id: 'm1', scope: 'project', namespace: 'ns', title: 'T' });
        const res = await handleWebhook(db, { action: 'dispatch' });
        expect(res.enabled).toBe(true);
        expect(res.dispatch).toBeTypeOf('object');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
