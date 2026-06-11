/**
 * Startup auth-mode logging (operator-trust bug): with ≥1 live api_key and no
 * MCP_AUTH_TOKEN, auth IS enforced (authConfigured is the authority) but the
 * old listen-callback log claimed `auth: 'none'` + warned 'auth_disabled' — and
 * the field name `auth` is on the logger's secret-key redaction list, so even
 * the correct value would have been swallowed as '[REDACTED]'.
 *
 * resolveAuthMode mirrors authConfigured's definition EXACTLY: env token set →
 * 'bearer'; else ≥1 NON-REVOKED api_key (`revoked_at IS NULL` — expiry is NOT
 * consulted for configured-ness; findApiKeyByToken rejects expired keys
 * per-request, so an expired-only key store still ENFORCES auth, it just 401s)
 * → 'api-keys'; else 'none'. The listen log emits the mode under `auth_mode`,
 * which is NOT a redaction key, so operators get a real signal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { resolveAuthMode } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { createApiKey, revokeApiKey } from '../../db/api-keys.js';
import { logger } from '../../lib/logger.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db?.close();
});

const getDb = (): Database.Database => db;

describe('resolveAuthMode — exact parity with authConfigured', () => {
  it("returns 'bearer' when the env token is set, with or without keys", () => {
    expect(resolveAuthMode(getDb, 'sekrit')).toBe('bearer');
    // The token short-circuits BEFORE the key count (authConfigured's `||` order).
    createApiKey(db, { principal: 'bot', namespaces: ['ns'] });
    expect(resolveAuthMode(getDb, 'sekrit')).toBe('bearer');
  });

  it("returns 'api-keys' when no token is set and ≥1 non-revoked key exists", () => {
    createApiKey(db, { principal: 'bot', namespaces: ['ns'] });
    expect(resolveAuthMode(getDb, undefined)).toBe('api-keys');
  });

  it("returns 'none' when no token is set and no keys exist", () => {
    expect(resolveAuthMode(getDb, undefined)).toBe('none');
  });

  it("returns 'none' when every key is revoked (authConfigured counts revoked_at IS NULL)", () => {
    const { id } = createApiKey(db, { principal: 'bot', namespaces: ['ns'] });
    revokeApiKey(db, id);
    expect(resolveAuthMode(getDb, undefined)).toBe('none');
  });

  it("returns 'api-keys' for an expired-but-unrevoked key — authConfigured ignores expiry", () => {
    // Parity is load-bearing: with only an expired key, authMiddleware still
    // ENFORCES auth (every request 401s via findApiKeyByToken's expiry reject)
    // — the server is NOT unauthenticated, so the mode must not read 'none'.
    createApiKey(db, {
      principal: 'bot',
      namespaces: ['ns'],
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(resolveAuthMode(getDb, undefined)).toBe('api-keys');
  });
});

/** Run `fn`, capturing everything emit() writes to stderr at info level (same
 * chokepoint lib/logger-redaction.test.ts stubs). */
function captureLog(fn: () => void): string {
  const stderr = process.stderr;
  let captured = '';
  const writeOriginal = stderr.write.bind(stderr);
  stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof stderr.write;
  process.env.MCP_LOG_LEVEL = 'info';
  try {
    fn();
  } finally {
    stderr.write = writeOriginal;
    delete process.env.MCP_LOG_LEVEL;
  }
  return captured;
}

describe("server_listening log field — 'auth_mode' survives redaction", () => {
  it("'auth_mode' passes through unredacted on the server_listening line", () => {
    const out = captureLog(() => {
      logger.info({ event: 'server_listening', host: '127.0.0.1', port: 3100, auth_mode: 'api-keys' });
    });
    expect(out).toContain('"auth_mode":"api-keys"');
    expect(out).not.toContain('[REDACTED]');
  });

  it("the pre-fix field name 'auth' IS secret-keyed — this is why the field is auth_mode", () => {
    const out = captureLog(() => {
      logger.info({ event: 'server_listening', auth: 'bearer' });
    });
    expect(out).toContain('"auth":"[REDACTED]"');
    expect(out).not.toContain('"auth":"bearer"');
  });
});
