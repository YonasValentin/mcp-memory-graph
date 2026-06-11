/**
 * RBAC v1 — `memory keys` CLI (create / list / revoke).
 *
 * The raw token prints EXACTLY ONCE at create, with a "store it now — it will
 * not be shown again" warning; nothing else (list/revoke) ever emits token or
 * hash material. `keys` with no/unknown subcommand prints usage (the
 * COMMAND_USAGE['keys'] block); `--help` is gated upstream by maybePrintHelp so
 * it never reaches this module.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { listApiKeys } from '../../db/api-keys.js';
import {
  createKeyCmd,
  listKeysCmd,
  revokeKeyCmd,
  dispatchKeys,
  formatKeysTable,
} from '../../cli/keys.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
  process.exitCode = undefined;
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Captures everything printed to console.log/error during fn() as one string. */
function capture(fn: () => void): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fn();
  } finally {
    /* leave spies in place for the caller's assertions; afterEach restores */
  }
  return [...log.mock.calls, ...err.mock.calls].map((c) => c.join(' ')).join('\n');
}

describe('createKeyCmd', () => {
  it('creates a key and prints id, principal, namespaces, level, expiry, and the RAW token ONCE with a store-now warning', () => {
    const out = capture(() =>
      createKeyCmd(db, {
        principal: 'sales-bot',
        namespaces: 'sales, marketing',
        'max-access-level': 'confidential',
      }),
    );
    const keys = listApiKeys(db);
    expect(keys).toHaveLength(1);
    const k = keys[0];
    // The exact token is in the output exactly once.
    const tokenMatch = out.match(/mcpm_[A-Za-z0-9_-]{43}/g);
    expect(tokenMatch).not.toBeNull();
    expect(tokenMatch!).toHaveLength(1);
    // Identity fields surfaced.
    expect(out).toContain(k.id);
    expect(out).toContain('sales-bot');
    expect(out).toContain('sales');
    expect(out).toContain('marketing');
    expect(out).toContain('confidential');
    // A clear, unmistakable warning that the token is shown only now.
    expect(out).toMatch(/will not be shown again/i);
    expect(out).toMatch(/store this token now/i);
  });

  it('trims and drops empty namespaces from the comma list', () => {
    capture(() => createKeyCmd(db, { principal: 'p', namespaces: ' a , , b ,' }));
    expect(listApiKeys(db)[0].namespaces).toEqual(['a', 'b']);
  });

  it('defaults max-access-level to internal (matching the DDL default)', () => {
    capture(() => createKeyCmd(db, { principal: 'p', namespaces: 'x' }));
    expect(listApiKeys(db)[0].maxAccessLevel).toBe('internal');
  });

  it('normalizes --expires to ISO-Z and prints the expiry', () => {
    const out = capture(() =>
      createKeyCmd(db, { principal: 'p', namespaces: 'x', expires: '2030-01-01T02:00:00+02:00' }),
    );
    expect(listApiKeys(db)[0].expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(out).toContain('2030-01-01T00:00:00.000Z');
  });

  it('errors (nonzero exit, no key created) when --principal is missing', () => {
    const out = capture(() => createKeyCmd(db, { namespaces: 'x' }));
    expect(process.exitCode).toBe(1);
    expect(listApiKeys(db)).toHaveLength(0);
    expect(out).toMatch(/principal/i);
  });

  it('errors clearly when --namespaces is empty / all-blank', () => {
    let out = capture(() => createKeyCmd(db, { principal: 'p', namespaces: '' }));
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/namespace/i);
    expect(listApiKeys(db)).toHaveLength(0);

    process.exitCode = undefined;
    out = capture(() => createKeyCmd(db, { principal: 'p', namespaces: ' , , ' }));
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/namespace/i);
    expect(listApiKeys(db)).toHaveLength(0);
  });

  it('errors when --namespaces flag is omitted entirely', () => {
    const out = capture(() => createKeyCmd(db, { principal: 'p' }));
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/namespace/i);
    expect(listApiKeys(db)).toHaveLength(0);
  });

  it('errors on an unknown --max-access-level (lists the valid set)', () => {
    const out = capture(() =>
      createKeyCmd(db, { principal: 'p', namespaces: 'x', 'max-access-level': 'root' }),
    );
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/public/);
    expect(out).toMatch(/restricted/);
    expect(listApiKeys(db)).toHaveLength(0);
  });

  it('errors on an unparseable --expires', () => {
    const out = capture(() =>
      createKeyCmd(db, { principal: 'p', namespaces: 'x', expires: 'next tuesday' }),
    );
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/expires|date|timestamp/i);
    expect(listApiKeys(db)).toHaveLength(0);
  });

  it('never prints any sha256 hash material', () => {
    const out = capture(() => createKeyCmd(db, { principal: 'p', namespaces: 'x' }));
    const stored = db.prepare('SELECT token_hash FROM api_keys').get() as { token_hash: string };
    expect(out).not.toContain(stored.token_hash);
    expect(out).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('listKeysCmd', () => {
  it('renders an aligned table with all public columns and NO token/hash', () => {
    capture(() => createKeyCmd(db, { principal: 'alpha', namespaces: 'a,b', 'max-access-level': 'public' }));
    const tokenA = (db.prepare('SELECT token_hash FROM api_keys').get() as { token_hash: string }).token_hash;
    const out = capture(() => listKeysCmd(db));
    expect(out).toMatch(/\bid\b/i);
    expect(out).toMatch(/principal/i);
    expect(out).toMatch(/namespaces/i);
    expect(out).toMatch(/max_access_level|access/i);
    expect(out).toMatch(/created_at|created/i);
    expect(out).toMatch(/expires_at|expires/i);
    expect(out).toMatch(/revoked_at|revoked/i);
    expect(out).toMatch(/last_used_at|last.used/i);
    expect(out).toContain('alpha');
    expect(out).toContain('a,b');
    expect(out).not.toContain(tokenA);
    expect(out).not.toMatch(/[0-9a-f]{64}/);
  });

  it('handles zero keys gracefully (No API keys.) and does not crash on a fresh DB', () => {
    const out = capture(() => listKeysCmd(db));
    expect(out).toMatch(/no api keys/i);
  });

  it('shows revoked / empty timestamps without crashing (renders a placeholder for NULLs)', () => {
    let id = '';
    capture(() => {
      id = (db.prepare('SELECT id FROM api_keys').get() as { id?: string })?.id ?? '';
    });
    capture(() => createKeyCmd(db, { principal: 'p', namespaces: 'x' }));
    id = listApiKeys(db)[0].id;
    capture(() => revokeKeyCmd(db, id));
    const out = capture(() => listKeysCmd(db));
    expect(out).toContain('p');
    // revoked_at now populated; never-used last_used_at renders some placeholder.
    expect(out).toMatch(/-|—|null|never/i);
  });
});

describe('formatKeysTable', () => {
  it('left-pads columns so rows align (header + at least one data row, same column count)', () => {
    capture(() => createKeyCmd(db, { principal: 'short', namespaces: 'x' }));
    capture(() =>
      createKeyCmd(db, { principal: 'a-much-longer-principal-name', namespaces: 'one,two,three' }),
    );
    const lines = formatKeysTable(listApiKeys(db)).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + 2 rows
    // Every line is the same visual width (aligned columns).
    const widths = new Set(lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length));
    expect(widths.size).toBe(1);
  });
});

describe('revokeKeyCmd', () => {
  it('revokes a live key and prints a confirmation including the id', () => {
    capture(() => createKeyCmd(db, { principal: 'p', namespaces: 'x' }));
    const id = listApiKeys(db)[0].id;
    const out = capture(() => revokeKeyCmd(db, id));
    expect(out).toMatch(/revoked/i);
    expect(out).toContain(id);
    expect(process.exitCode).not.toBe(1);
    expect(listApiKeys(db)[0].revokedAt).not.toBeNull();
  });

  it('errors (nonzero exit) for an unknown id', () => {
    const out = capture(() => revokeKeyCmd(db, 'no-such-id'));
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/no api key found/i);
  });

  it('errors (nonzero exit) for an already-revoked id and never restamps', () => {
    capture(() => createKeyCmd(db, { principal: 'p', namespaces: 'x' }));
    const id = listApiKeys(db)[0].id;
    capture(() => revokeKeyCmd(db, id));
    const firstStamp = listApiKeys(db)[0].revokedAt;
    process.exitCode = undefined;
    const out = capture(() => revokeKeyCmd(db, id));
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/already|not found|no such/i);
    expect(listApiKeys(db)[0].revokedAt).toBe(firstStamp);
  });

  it('errors when no id argument is given', () => {
    const out = capture(() => revokeKeyCmd(db, undefined));
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/id/i);
  });
});

describe('dispatchKeys (subcommand routing)', () => {
  it('routes create/list/revoke to their commands', () => {
    capture(() => dispatchKeys(db, 'create', ['--principal', 'p', '--namespaces', 'x']));
    expect(listApiKeys(db)).toHaveLength(1);
    const id = listApiKeys(db)[0].id;

    const listOut = capture(() => dispatchKeys(db, 'list', []));
    expect(listOut).toContain('p');

    capture(() => dispatchKeys(db, 'revoke', [id]));
    expect(listApiKeys(db)[0].revokedAt).not.toBeNull();
  });

  it('parses create flags from the raw argv slice', () => {
    capture(() =>
      dispatchKeys(db, 'create', [
        '--principal',
        'finance',
        '--namespaces',
        'fin,ops',
        '--max-access-level',
        'restricted',
      ]),
    );
    const k = listApiKeys(db)[0];
    expect(k.principal).toBe('finance');
    expect(k.namespaces).toEqual(['fin', 'ops']);
    expect(k.maxAccessLevel).toBe('restricted');
  });

  it('prints the keys usage for no subcommand and sets a nonzero exit', () => {
    const out = capture(() => dispatchKeys(db, undefined, []));
    expect(out).toMatch(/keys create/);
    expect(out).toMatch(/keys list/);
    expect(out).toMatch(/keys revoke/);
    expect(process.exitCode).toBe(1);
  });

  it('prints the keys usage for an unknown subcommand and sets a nonzero exit', () => {
    const out = capture(() => dispatchKeys(db, 'frobnicate', []));
    expect(out).toMatch(/keys create/);
    expect(process.exitCode).toBe(1);
  });
});
