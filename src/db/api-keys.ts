import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ACCESS_LEVELS } from '../constants/enums.js';
import type { AccessLevel } from '../types.js';

/**
 * RBAC v1 — API-key store (schema v16). One running server, N keys, each key
 * pinned to a set of namespaces + an access-level ceiling.
 *
 * Invariants:
 *   - The RAW token string exists ONLY in {@link createApiKey}'s return value.
 *     Everywhere else (storage, lookup) it is sha256 hex. {@link listApiKeys}
 *     output carries NO hash material at all.
 *   - {@link findApiKeyByToken} is the single authority for key validity: it
 *     rejects revoked/expired keys here, so callers never re-check.
 *   - Every timestamp is ISO-Z (`new Date().toISOString()`); expiry is a
 *     LEXICAL `expires_at <= now` compare, which is only correct because both
 *     sides are ISO-Z (the collation invariant — never `datetime('now')`).
 */

/** A stored API key, with the namespaces JSON parsed. Never carries the hash. */
export interface ApiKey {
  id: string;
  /** Human-readable key name, for logs/audit ("unique-ish", not enforced). */
  principal: string;
  /** Permitted namespaces; non-empty, [0] is the per-request default. */
  namespaces: string[];
  /** Egress ceiling, ACCESS_LEVELS ordering. */
  maxAccessLevel: AccessLevel;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

interface ApiKeyDbRow {
  id: string;
  principal: string;
  namespaces: string;
  max_access_level: string;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** `mcpm_` makes leaked tokens greppable by secret scanners. */
const TOKEN_PREFIX = 'mcpm_';

/** last_used_at writes are throttled to at most one per key per this window. */
export const LAST_USED_THROTTLE_MS = 60_000;

/** Every column EXCEPT token_hash — the only shape reads are allowed to return. */
const PUBLIC_COLUMNS =
  'id, principal, namespaces, max_access_level, expires_at, created_at, revoked_at, last_used_at';

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function rowToApiKey(row: ApiKeyDbRow): ApiKey {
  return {
    id: row.id,
    principal: row.principal,
    namespaces: JSON.parse(row.namespaces) as string[],
    maxAccessLevel: row.max_access_level as AccessLevel,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export interface CreateApiKeyInput {
  principal: string;
  namespaces: string[];
  maxAccessLevel?: AccessLevel;
  /** Any Date.parse-able timestamp; normalized to ISO-Z on write. */
  expiresAt?: string;
}

/**
 * Mint a new key. The ONLY place the raw token ever exists — show it to the
 * operator once and store the sha256 only. Namespaces are validated on write:
 * a non-empty array of non-empty strings (an empty-string namespace would read
 * as "unforced" to the tenancy helpers — a fail-open, so it is refused here).
 */
export function createApiKey(
  db: Database.Database,
  input: CreateApiKeyInput,
): { id: string; token: string } {
  if (typeof input.principal !== 'string' || input.principal.trim().length === 0) {
    throw new Error('principal must be a non-empty string');
  }
  if (
    !Array.isArray(input.namespaces) ||
    input.namespaces.length === 0 ||
    input.namespaces.some((n) => typeof n !== 'string' || n.length === 0)
  ) {
    throw new Error('namespaces must be a non-empty array of non-empty namespace strings');
  }
  const level = input.maxAccessLevel ?? 'internal';
  if (!(ACCESS_LEVELS as readonly string[]).includes(level)) {
    throw new Error(
      `max_access_level must be one of [${ACCESS_LEVELS.join(', ')}], got '${String(level)}'`,
    );
  }
  let expiresAt: string | null = null;
  if (input.expiresAt !== undefined) {
    const parsed = Date.parse(input.expiresAt);
    if (!Number.isFinite(parsed)) {
      throw new Error(`expiresAt must be a parseable ISO-8601 timestamp, got '${input.expiresAt}'`);
    }
    // Normalize to ISO-Z so the lexical expiry compare collates correctly.
    expiresAt = new Date(parsed).toISOString();
  }

  const id = randomUUID();
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO api_keys (id, principal, token_hash, namespaces, max_access_level, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.principal,
    hashToken(token),
    JSON.stringify(input.namespaces),
    level,
    expiresAt,
    new Date().toISOString(),
  );
  return { id, token };
}

/**
 * Resolve a presented bearer token to its key, or undefined. Revoked and
 * expired keys are rejected HERE (single authority) — callers never re-check.
 * Expiry is a lexical ISO-Z compare (`expires_at <= now` ⇒ expired).
 */
export function findApiKeyByToken(db: Database.Database, token: string): ApiKey | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  const row = db
    .prepare<[string], ApiKeyDbRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return undefined;
  if (row.revoked_at !== null) return undefined;
  if (row.expires_at !== null && row.expires_at <= new Date().toISOString()) return undefined;
  return rowToApiKey(row);
}

/** Every key (live + revoked) for the operator table. NO hashes in the output. */
export function listApiKeys(db: Database.Database): ApiKey[] {
  return db
    .prepare<[], ApiKeyDbRow>(`SELECT ${PUBLIC_COLUMNS} FROM api_keys ORDER BY created_at, id`)
    .all()
    .map(rowToApiKey);
}

/**
 * Stamp revoked_at (ISO-Z). Returns true when a live key was newly revoked;
 * false for unknown ids AND for already-revoked keys (the original revocation
 * instant is audit data — never restamped).
 */
export function revokeApiKey(db: Database.Database, id: string): boolean {
  const res = db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), id);
  return res.changes > 0;
}

/**
 * Record key usage, throttled: a no-op while last_used_at is within
 * {@link LAST_USED_THROTTLE_MS} (lexical ISO-Z compare against the cutoff), so
 * the per-request auth path costs at most one UPDATE per key per minute.
 * Returns true when the stamp was written.
 */
export function touchLastUsed(db: Database.Database, id: string): boolean {
  const now = Date.now();
  const cutoff = new Date(now - LAST_USED_THROTTLE_MS).toISOString();
  const res = db
    .prepare(
      `UPDATE api_keys SET last_used_at = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
    )
    .run(new Date(now).toISOString(), id, cutoff);
  return res.changes > 0;
}
