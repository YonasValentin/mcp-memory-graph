/**
 * Tests for structured-logger secret redaction (F4 / P8).
 *
 * Defense-in-depth: log lines must never leak secrets, even by accident. The
 * old redact() only matched a SMALL set of TOP-LEVEL keys, so (a) common secret
 * keys (access_token, refresh_token, client_secret, private_key, session_token,
 * bearer) leaked in cleartext, and (b) a secret nested inside an object or an
 * array-of-objects was logged verbatim. Redaction is now recursive over objects
 * AND arrays, with circular-reference and depth guards so the logger can never
 * throw or hang. Output shape is otherwise identical: primitives unchanged, key
 * names preserved, inherited/proto keys not walked (Object.entries skips them).
 *
 * Output is captured by stubbing process.stderr.write — the same chokepoint
 * emit() writes to (see api/observability.test.ts 'logger redaction').
 */
import { describe, it, expect } from 'vitest';
import { logger } from '../../lib/logger.js';

/** Run `fn`, capturing everything emit() writes to stderr at info level. */
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

describe('logger redaction (F4 / P8)', () => {
  it('redacts the previously-missing top-level secret keys', () => {
    const out = captureLog(() => {
      logger.info({
        event: 'oauth',
        access_token: 'at-123',
        refresh_token: 'rt-456',
        client_secret: 'cs-789',
        private_key: '-----BEGIN-----',
        session_token: 'st-000',
        bearer: 'bear-111',
        ok: 'visible',
      });
    });
    expect(out).toContain('"access_token":"[REDACTED]"');
    expect(out).toContain('"refresh_token":"[REDACTED]"');
    expect(out).toContain('"client_secret":"[REDACTED]"');
    expect(out).toContain('"private_key":"[REDACTED]"');
    expect(out).toContain('"session_token":"[REDACTED]"');
    expect(out).toContain('"bearer":"[REDACTED]"');
    // Cleartext secret values must not survive anywhere in the line.
    expect(out).not.toContain('at-123');
    expect(out).not.toContain('cs-789');
    expect(out).not.toContain('BEGIN');
    expect(out).toContain('"ok":"visible"');
  });

  it('redacts a secret nested 2-3 levels deep inside non-secret containers', () => {
    // The container keys (ctx, session) are NOT secret keys, so recursion must
    // descend into them and redact the secret-keyed leaf while non-secret
    // siblings survive. (A secret-named container like `auth` is redacted whole.)
    const out = captureLog(() => {
      logger.info({
        event: 'http_request',
        ctx: { session: { token: 'deep-secret', user: 'alice' } },
      });
    });
    expect(out).toContain('"token":"[REDACTED]"');
    expect(out).not.toContain('deep-secret');
    // Non-secret sibling at depth survives unchanged.
    expect(out).toContain('"user":"alice"');
  });

  it('redacts a secret inside an array of objects', () => {
    const out = captureLog(() => {
      logger.info({
        event: 'batch',
        creds: [
          { id: 1, password: 'pw-1' },
          { id: 2, api_key: 'ak-2' },
        ],
      });
    });
    expect(out).toContain('"password":"[REDACTED]"');
    expect(out).toContain('"api_key":"[REDACTED]"');
    expect(out).not.toContain('pw-1');
    expect(out).not.toContain('ak-2');
    // Non-secret array fields pass through.
    expect(out).toContain('"id":1');
    expect(out).toContain('"id":2');
  });

  it('does not throw or hang on a circular object, and still emits a line', () => {
    const out = captureLog(() => {
      const node: Record<string, unknown> = { event: 'cycle', password: 'pw', name: 'x' };
      node.self = node; // cycle
      // Must complete without throwing or infinite-looping.
      logger.info(node as { event: string; [k: string]: unknown });
    });
    // A line was emitted (logger never silently dies on bad input).
    expect(out).toContain('"event":"cycle"');
    // The secret was still redacted on the way through.
    expect(out).toContain('"password":"[REDACTED]"');
    expect(out).not.toContain('"password":"pw"');
  });

  it('leaves non-secret fields (incl. nested primitives) unchanged', () => {
    const out = captureLog(() => {
      logger.info({
        event: 'plain',
        count: 42,
        ok: true,
        nothing: null,
        nested: { route: '/api/stats', status: 200, tags: ['a', 'b'] },
      });
    });
    expect(out).toContain('"count":42');
    expect(out).toContain('"ok":true');
    expect(out).toContain('"nothing":null');
    expect(out).toContain('"route":"/api/stats"');
    expect(out).toContain('"status":200');
    expect(out).toContain('"tags":["a","b"]');
    expect(out).not.toContain('[REDACTED]');
  });
});
