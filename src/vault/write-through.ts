import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Memory, MemoryRow } from '../types.js';
import { getConfig, getVaultEgress } from '../config/loader.js';
import { rowToMemory } from '../db/repository.js';
import { memoryToMarkdown, safeVaultFilename, safeSubdir, confineToVault, isEgressBlocked } from './writer.js';
import { logger } from '../lib/logger.js';

/**
 * Write-through vault mirror (P1.2). When a vault is configured, every top-level
 * memory write is reflected to a per-memory `.md` file so the git file tree is
 * the live source of truth (Bruno model) and `memory rebuild` can reconstruct
 * the DB from it. Soft-deleted memories move under `.memory/deleted/` so a
 * deletion travels through git instead of resurrecting on merge.
 *
 * All mirroring is FAIL-SOFT: the DB write is the commit of record; a file IO
 * failure is logged and swallowed so a read-only vault or transient FS error
 * never breaks a memory write. Run `memory rebuild` / a full export to reconcile.
 *
 * Gated entirely by config: when no vault path is set (the default, and every
 * test that doesn't opt in), every function here is a no-op.
 */

const DELETED_DIR = '.memory/deleted';

// One-shot latch for the config-unreadable warn. resolveVaultRoot runs on
// EVERY mirror op, and getConfig re-throws on every call while the config stays
// broken — so an unguarded warn floods stderr 1:1 with write volume
// (fix-breaker WAVE 3). Warn once per broken-config EPISODE: set on the first
// warn, cleared whenever the config reads cleanly again so a later breakage
// re-warns.
let configUnreadableWarned = false;

/** Test-only: reset the warn latch between cases. */
export function __resetVaultMirrorWarnState(): void {
  configUnreadableWarned = false;
}

/** Resolve the active vault root, or null when write-through is off. */
function resolveVaultRoot(): string | null {
  if (process.env.MCP_VAULT_WRITE_THROUGH === '0') return null;
  const envPath = process.env.MCP_VAULT_PATH;
  if (envPath) return envPath;
  // Fail-soft on a malformed/unreadable config: write-through is a best-effort
  // mirror (the whole function is fail-soft), so a broken project config must
  // disable mirroring, never throw out of a successful store (fix-breaker S18).
  // But it must not be SILENT (fix-breaker WAVE 2): emit a signal so a team
  // relying on git-shared write-through can see WHY memories stopped reaching
  // the vault — once per episode, and WITHOUT echoing the raw error body
  // (a ZodError/SyntaxError string can carry a rejected config VALUE verbatim,
  // which the key-name-only log redactor would not catch — fix-breaker WAVE 3).
  let cfg;
  try {
    cfg = getConfig();
  } catch (err) {
    if (!configUnreadableWarned) {
      configUnreadableWarned = true;
      logger.warn({
        event: 'vault_mirror_skipped',
        reason: 'config_unreadable',
        msg: 'write-through disabled: the config could not be read (run `memory rebuild` to resync the vault once the config is fixed)',
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }
    return null;
  }
  configUnreadableWarned = false;
  if (!cfg.vault.path || cfg.vault.write_through === false) return null;
  return cfg.vault.path;
}

/**
 * Run a mirror operation against the resolved, realpath'd vault root. No-op when
 * no vault is configured; fail-soft on any IO error (logged, never thrown).
 */
function safeMirror(op: string, id: string, fn: (vaultRoot: string) => void): void {
  const root = resolveVaultRoot();
  if (!root) return;
  try {
    fs.mkdirSync(root, { recursive: true });
    fn(fs.realpathSync(root));
  } catch (err) /* c8 ignore next */ {
    logger.warn({ event: 'vault_mirror_failed', op, id, err: err instanceof Error ? err.message : String(err) });
  }
}

/** Vault-relative live path for a memory: `<namespace>/<title>-<id>.md`. */
function livePath(memory: Memory): string {
  const filename = safeVaultFilename(memory);
  const subdir = memory.namespace ? safeSubdir(memory.namespace) : '';
  return subdir ? path.join(subdir, filename) : filename;
}

/** Vault-relative tombstone path: `.memory/deleted/<id>.md`. */
function deletedPath(memory: Memory): string {
  const idSlice = memory.id.replace(/[^a-zA-Z0-9]/g, '') || 'memory';
  return path.join(DELETED_DIR, `${idSlice}.md`);
}

function writeConfined(vaultRoot: string, relPath: string, contents: string): void {
  const abs = confineToVault(vaultRoot, relPath);
  /* c8 ignore next */
  if (!abs) return;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf-8');
}

function removeConfined(vaultRoot: string, relPath: string): void {
  const abs = confineToVault(vaultRoot, relPath);
  /* c8 ignore next */
  if (!abs) return;
  try {
    fs.unlinkSync(abs);
  } catch {
    /* c8 ignore next — already gone */
  }
}

/**
 * Mirror a created/updated top-level memory to its live `.md` file. Reads the
 * current row by id so the file always reflects committed DB state. If the row
 * has been invalidated (valid_to set), it is written as a tombstone under
 * `.memory/deleted/` and the live file is removed. No-op for chunk rows.
 */
export function mirrorMemoryWrite(db: Database.Database, memoryId: string): void {
  safeMirror('write', memoryId, (vaultRoot) => {
    const row = db
      .prepare<[string], MemoryRow & { valid_to: string | null }>(
        'SELECT * FROM memories WHERE id = ?',
      )
      .get(memoryId);
    if (!row || row.parent_id !== null) return;
    const memory = rowToMemory(row);
    const validTo = row.valid_to ?? null;

    // M2.5: egress filter. A memory above the configured sensitivity cap (or
    // matching a deny_glob) must NEVER be mirrored into the git-shared vault —
    // not as a live file, not as a tombstone (both carry the content/title).
    // Purge any stale copies so a memory that BECOMES restricted is removed.
    if (isEgressBlocked(memory, livePath(memory), getVaultEgress())) {
      removeConfined(vaultRoot, livePath(memory));
      removeConfined(vaultRoot, deletedPath(memory));
      return;
    }

    if (validTo !== null) {
      writeConfined(
        vaultRoot,
        deletedPath(memory),
        memoryToMarkdown({ ...memory, valid_to: validTo } as Memory & { valid_to: string }),
      );
      removeConfined(vaultRoot, livePath(memory));
      return;
    }
    writeConfined(vaultRoot, livePath(memory), memoryToMarkdown(memory));
    // Clear any stale tombstone (e.g. a re-created memory).
    removeConfined(vaultRoot, deletedPath(memory));
  });
}

/**
 * Mirror a hard delete: remove both the live file and any tombstone for this
 * memory. Takes a snapshot because the row is already gone by call time.
 */
export function mirrorMemoryRemove(memory: Memory): void {
  safeMirror('remove', memory.id, (vaultRoot) => {
    removeConfined(vaultRoot, livePath(memory));
    removeConfined(vaultRoot, deletedPath(memory));
  });
}
