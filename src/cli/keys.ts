import type Database from 'better-sqlite3';
import { ACCESS_LEVELS } from '../constants/enums.js';
import type { AccessLevel } from '../types.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKey,
} from '../db/api-keys.js';
import { getReadWriteDb } from '../lib/direct-access.js';
import { parseFlags } from './argv.js';
import { success, warn, info, dim, CYAN, RESET, DIM } from './cli-output.js';

/**
 * RBAC v1 — `memory keys` CLI (create / list / revoke), schema v16.
 *
 * Design split for testability + coverage: every command takes an injected
 * `db` and pre-parsed flags so unit tests drive them against an in-memory DB.
 * The ONLY untested shell is {@link runKeys}, which acquires the real DB via
 * `getReadWriteDb()` (so migrations — incl. v16 — run first) and routes argv —
 * the same thin-IO-wiring precedent as backup/sync/vault-init (c8-ignored).
 *
 * Token discipline: the raw token exists only in {@link createApiKey}'s return
 * and is printed EXACTLY ONCE by {@link createKeyCmd} with a store-now warning.
 * No command ever prints token_hash material — {@link listApiKeys} already
 * omits it; we just render what it returns.
 */

/** Renders a NULL timestamp/field as a single em-dash placeholder in the table. */
const DASH = '—';

/** Splits `--namespaces a, b ,,c` → ['a','b','c'] (trim, drop empties). */
function parseNamespaces(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Prints `msg` to stderr and flags a nonzero process exit. Returns nothing. */
function fail(msg: string): void {
  console.error(`Error: ${msg}`);
  process.exitCode = 1;
}

/**
 * `memory keys create --principal <name> --namespaces a,b[,c]
 *   [--max-access-level public|internal|confidential|restricted] [--expires <ISO>]`
 *
 * Validates flags, mints the key, and prints its id + identity + the RAW TOKEN
 * exactly once with an unmissable "store this now" warning. Bad input sets a
 * nonzero exit and creates nothing.
 */
export function createKeyCmd(db: Database.Database, flags: Record<string, string>): void {
  const principal = flags.principal?.trim();
  if (!principal) {
    fail('--principal <name> is required.');
    return;
  }

  const namespaces = parseNamespaces(flags.namespaces);
  if (namespaces.length === 0) {
    fail('--namespaces <a,b,c> is required and must list at least one namespace.');
    return;
  }

  const level = (flags['max-access-level'] ?? 'internal') as AccessLevel;
  if (!(ACCESS_LEVELS as readonly string[]).includes(level)) {
    fail(`--max-access-level must be one of [${ACCESS_LEVELS.join(', ')}], got '${level}'.`);
    return;
  }

  const expiresRaw = flags.expires;
  if (expiresRaw !== undefined && !Number.isFinite(Date.parse(expiresRaw))) {
    fail(`--expires must be a parseable ISO-8601 timestamp, got '${expiresRaw}'.`);
    return;
  }

  let result: { id: string; token: string };
  try {
    result = createApiKey(db, {
      principal,
      namespaces,
      maxAccessLevel: level,
      expiresAt: expiresRaw,
    });
  } catch (err) {
    // Defence-in-depth: the api-keys module validates too; surface its message.
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  // Read back the stored row's normalized expiry (ISO-Z) for the summary.
  const stored = listApiKeys(db).find((k) => k.id === result.id);

  success(`API key created for principal '${principal}'.`);
  dim(`id                ${result.id}`);
  dim(`principal         ${principal}`);
  dim(`namespaces        ${namespaces.join(', ')}`);
  dim(`max-access-level  ${level}`);
  dim(`expires           ${stored?.expiresAt ?? '(never)'}`);
  console.log('');
  warn('Store this token now — it will NOT be shown again:');
  console.log(`\n  ${CYAN}${result.token}${RESET}\n`);
  info('Use it as a bearer token: Authorization: Bearer <token>');
}

/** Right-pads a (possibly ANSI-free) cell to `width` for column alignment. */
function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - value.length));
}

/**
 * Renders the keys as a fixed-width, aligned table (header + one row per key).
 * Carries NO token/hash material — only the public columns. Every line is the
 * same visual width. NULL timestamps render as an em-dash.
 */
export function formatKeysTable(keys: ApiKey[]): string {
  const header = [
    'id',
    'principal',
    'namespaces',
    'max_access_level',
    'created_at',
    'expires_at',
    'revoked_at',
    'last_used_at',
  ];
  const rows = keys.map((k) => [
    k.id,
    k.principal,
    k.namespaces.join(','),
    k.maxAccessLevel,
    k.createdAt,
    k.expiresAt ?? DASH,
    k.revokedAt ?? DASH,
    k.lastUsedAt ?? DASH,
  ]);

  // Column width = widest cell (header or any row) in that column.
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => r[col].length)),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((c, col) => pad(c, widths[col])).join('  ').replace(/\s+$/, '');
  // Re-pad after trimming trailing space so all lines share one width.
  const lineWidth = Math.max(
    renderRow(header).length,
    ...rows.map((r) => renderRow(r).length),
  );
  const line = (cells: string[]): string => pad(renderRow(cells), lineWidth);

  return [line(header), ...rows.map(line)].join('\n');
}

/** `memory keys list` — prints the aligned table, or "No API keys." if empty. */
export function listKeysCmd(db: Database.Database): void {
  const keys = listApiKeys(db);
  if (keys.length === 0) {
    console.log('No API keys.');
    return;
  }
  console.log(`${DIM}${keys.length} API key${keys.length === 1 ? '' : 's'}:${RESET}`);
  console.log(formatKeysTable(keys));
}

/**
 * `memory keys revoke <id>` — stamps revoked_at. Prints a confirmation on
 * success; sets a nonzero exit + a clear message when the id is unknown OR
 * already revoked (revokeApiKey never restamps an existing revocation).
 */
export function revokeKeyCmd(db: Database.Database, id: string | undefined): void {
  if (!id) {
    fail('usage: memory keys revoke <id>');
    return;
  }
  if (revokeApiKey(db, id)) {
    success(`API key ${id} revoked.`);
    return;
  }
  // Distinguish unknown from already-revoked for a clearer operator message.
  const existing = listApiKeys(db).find((k) => k.id === id);
  if (existing) {
    fail(`API key ${id} was already revoked at ${existing.revokedAt}.`);
  } else {
    fail(`No API key found with id '${id}'.`);
  }
}

const KEYS_USAGE = `Usage: mcp-memory-graph keys <create|list|revoke> [flags]

  keys create --principal <name> --namespaces <a,b,c>
              [--max-access-level public|internal|confidential|restricted]
              [--expires <ISO8601>]
  keys list
  keys revoke <id>`;

/**
 * Routes a `keys` subcommand against the given DB. Unknown/absent subcommand
 * prints the keys usage and sets a nonzero exit. (`--help` is gated upstream by
 * maybePrintHelp in src/index.ts — it never reaches here.)
 */
export function dispatchKeys(
  db: Database.Database,
  subcommand: string | undefined,
  argv: string[],
): void {
  switch (subcommand) {
    case 'create':
      createKeyCmd(db, parseFlags(argv));
      return;
    case 'list':
      listKeysCmd(db);
      return;
    case 'revoke':
      revokeKeyCmd(db, argv[0]);
      return;
    default:
      console.log(KEYS_USAGE);
      process.exitCode = 1;
  }
}

/* c8 ignore start — thin CLI/IO shell: acquires the real DB (runs migrations,
   incl. v16) and routes argv to the unit-tested dispatchKeys above. */

/**
 * `memory keys …` entry point. Opens the database read-write so the schema is
 * initialized and migrations (incl. v16 `api_keys`) run first — a fresh DB's
 * `keys list` therefore renders an empty table rather than crashing. Routing
 * and all command logic are the tested {@link dispatchKeys}.
 */
export function runKeys(argv: string[]): void {
  const [subcommand, ...rest] = argv;
  const db = getReadWriteDb();
  dispatchKeys(db, subcommand, rest);
}
/* c8 ignore stop */
