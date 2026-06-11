/**
 * RBAC v1 — api_keys module (schema v16). The raw token string exists ONLY in
 * createApiKey's return value; the DB stores sha256 hex. findApiKeyByToken is
 * the single authority that rejects revoked/expired keys (callers never re-check).
 * All timestamps are ISO-Z (lexical range-compare invariant — never datetime('now')).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import {
  createApiKey,
  findApiKeyByToken,
  listApiKeys,
  revokeApiKey,
  touchLastUsed,
} from '../../db/api-keys.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db.close();
});

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('createApiKey', () => {
  it('returns id + a mcpm_-prefixed base64url token (32 random bytes = 43 chars)', () => {
    const { id, token } = createApiKey(db, { principal: 'sales-bot', namespaces: ['sales'] });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(token).toMatch(/^mcpm_[A-Za-z0-9_-]{43}$/);
  });

  it('stores ONLY the sha256 hex of the token — never the raw token', () => {
    const { id, token } = createApiKey(db, { principal: 'sales-bot', namespaces: ['sales'] });
    const row = db
      .prepare('SELECT token_hash, created_at FROM api_keys WHERE id = ?')
      .get(id) as { token_hash: string; created_at: string };
    expect(row.token_hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(token);
    expect(row.created_at).toMatch(ISO_Z);
  });

  it('two keys never share a token', () => {
    const a = createApiKey(db, { principal: 'a', namespaces: ['x'] });
    const b = createApiKey(db, { principal: 'b', namespaces: ['x'] });
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });

  it('defaults max_access_level to internal and keeps an explicit one', () => {
    const a = createApiKey(db, { principal: 'a', namespaces: ['x'] });
    const b = createApiKey(db, {
      principal: 'b',
      namespaces: ['x'],
      maxAccessLevel: 'restricted',
    });
    const levels = listApiKeys(db).map((k) => [k.id, k.maxAccessLevel]);
    expect(levels).toContainEqual([a.id, 'internal']);
    expect(levels).toContainEqual([b.id, 'restricted']);
  });

  it('normalizes expiresAt to ISO-Z (lexical-compare invariant)', () => {
    const { id } = createApiKey(db, {
      principal: 'a',
      namespaces: ['x'],
      expiresAt: '2030-01-01T02:00:00+02:00',
    });
    const row = db.prepare('SELECT expires_at FROM api_keys WHERE id = ?').get(id) as {
      expires_at: string;
    };
    expect(row.expires_at).toBe('2030-01-01T00:00:00.000Z');
  });

  it('rejects an empty principal', () => {
    expect(() => createApiKey(db, { principal: '', namespaces: ['x'] })).toThrow(/principal/);
    expect(() => createApiKey(db, { principal: '   ', namespaces: ['x'] })).toThrow(/principal/);
  });

  it('rejects empty / empty-string / non-string namespaces', () => {
    expect(() => createApiKey(db, { principal: 'a', namespaces: [] })).toThrow(/namespaces/);
    expect(() => createApiKey(db, { principal: 'a', namespaces: [''] })).toThrow(/namespaces/);
    expect(() =>
      createApiKey(db, { principal: 'a', namespaces: ['ok', ''] }),
    ).toThrow(/namespaces/);
    expect(() =>
      createApiKey(db, { principal: 'a', namespaces: [42] as unknown as string[] }),
    ).toThrow(/namespaces/);
    expect(() =>
      createApiKey(db, { principal: 'a', namespaces: 'sales' as unknown as string[] }),
    ).toThrow(/namespaces/);
  });

  it('rejects an unknown maxAccessLevel', () => {
    expect(() =>
      createApiKey(db, {
        principal: 'a',
        namespaces: ['x'],
        maxAccessLevel: 'root' as never,
      }),
    ).toThrow(/max_access_level/);
  });

  it('rejects an unparseable expiresAt', () => {
    expect(() =>
      createApiKey(db, { principal: 'a', namespaces: ['x'], expiresAt: 'next tuesday' }),
    ).toThrow(/expiresAt/);
  });
});

describe('findApiKeyByToken', () => {
  it('returns the parsed key for a valid token (namespaces as array, no hash)', () => {
    const { id, token } = createApiKey(db, {
      principal: 'sales-bot',
      namespaces: ['sales', 'marketing'],
      maxAccessLevel: 'confidential',
    });
    const found = findApiKeyByToken(db, token);
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
    expect(found!.principal).toBe('sales-bot');
    expect(found!.namespaces).toEqual(['sales', 'marketing']);
    expect(found!.maxAccessLevel).toBe('confidential');
    expect(found!.expiresAt).toBeNull();
    expect(found!.revokedAt).toBeNull();
    expect(found!.createdAt).toMatch(ISO_Z);
    expect('token_hash' in found!).toBe(false);
    expect(Object.values(found!)).not.toContain(token);
  });

  it('returns undefined for an unknown or empty token', () => {
    createApiKey(db, { principal: 'a', namespaces: ['x'] });
    expect(findApiKeyByToken(db, 'mcpm_definitely-not-a-real-token-aaaaaaaaaaaaaa')).toBeUndefined();
    expect(findApiKeyByToken(db, '')).toBeUndefined();
  });

  it('rejects an expired key here — not in callers (lexical ISO-Z compare)', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const expired = createApiKey(db, { principal: 'old', namespaces: ['x'], expiresAt: past });
    const live = createApiKey(db, { principal: 'new', namespaces: ['x'], expiresAt: future });
    expect(findApiKeyByToken(db, expired.token)).toBeUndefined();
    expect(findApiKeyByToken(db, live.token)?.id).toBe(live.id);
  });

  it('rejects a revoked key', () => {
    const { id, token } = createApiKey(db, { principal: 'a', namespaces: ['x'] });
    expect(findApiKeyByToken(db, token)?.id).toBe(id);
    expect(revokeApiKey(db, id)).toBe(true);
    expect(findApiKeyByToken(db, token)).toBeUndefined();
  });
});

describe('listApiKeys', () => {
  it('lists every key (live + revoked) with NO hash material', () => {
    const a = createApiKey(db, { principal: 'a', namespaces: ['x'] });
    const b = createApiKey(db, { principal: 'b', namespaces: ['y', 'z'] });
    revokeApiKey(db, b.id);
    const keys = listApiKeys(db);
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect('token_hash' in k).toBe(false);
      expect('token' in k).toBe(false);
      expect(JSON.stringify(k)).not.toMatch(/[0-9a-f]{64}/);
    }
    const revoked = keys.find((k) => k.id === b.id)!;
    expect(revoked.revokedAt).toMatch(ISO_Z);
    expect(revoked.namespaces).toEqual(['y', 'z']);
    expect(keys.find((k) => k.id === a.id)!.revokedAt).toBeNull();
  });

  it('returns [] on a fresh DB', () => {
    expect(listApiKeys(db)).toEqual([]);
  });
});

describe('revokeApiKey', () => {
  it('stamps revoked_at once and keeps the original stamp on a re-revoke', () => {
    const { id } = createApiKey(db, { principal: 'a', namespaces: ['x'] });
    expect(revokeApiKey(db, id)).toBe(true);
    const first = (
      db.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(id) as {
        revoked_at: string;
      }
    ).revoked_at;
    expect(first).toMatch(ISO_Z);
    expect(revokeApiKey(db, id)).toBe(false); // already revoked — no restamp
    const second = (
      db.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(id) as {
        revoked_at: string;
      }
    ).revoked_at;
    expect(second).toBe(first);
  });

  it('returns false for an unknown id', () => {
    expect(revokeApiKey(db, 'no-such-key')).toBe(false);
  });
});

describe('touchLastUsed (≥60s throttle)', () => {
  it('stamps last_used_at on first use', () => {
    const { id } = createApiKey(db, { principal: 'a', namespaces: ['x'] });
    expect(touchLastUsed(db, id)).toBe(true);
    const row = db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(id) as {
      last_used_at: string;
    };
    expect(row.last_used_at).toMatch(ISO_Z);
  });

  it('is a no-op when last_used_at is within 60s', () => {
    const { id } = createApiKey(db, { principal: 'a', namespaces: ['x'] });
    expect(touchLastUsed(db, id)).toBe(true);
    const first = (
      db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(id) as {
        last_used_at: string;
      }
    ).last_used_at;
    expect(touchLastUsed(db, id)).toBe(false);
    const second = (
      db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(id) as {
        last_used_at: string;
      }
    ).last_used_at;
    expect(second).toBe(first);
  });

  it('updates again once the stamp is older than 60s', () => {
    const { id } = createApiKey(db, { principal: 'a', namespaces: ['x'] });
    const old = new Date(Date.now() - 61_000).toISOString();
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(old, id);
    expect(touchLastUsed(db, id)).toBe(true);
    const row = db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(id) as {
      last_used_at: string;
    };
    expect(row.last_used_at > old).toBe(true);
  });

  it('is a no-op for an unknown id', () => {
    expect(touchLastUsed(db, 'no-such-key')).toBe(false);
  });
});
