import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { stringify as stringifyYaml } from 'yaml';
import type { AccessLevel, Memory, MemoryRow } from '../types.js';
import { rowToMemory } from '../db/repository.js';
import { getVaultEgress } from '../config/loader.js';

/**
 * Pillar 6 (T16): bidirectional vault write-back. The reverse of `syncVault`:
 * serialize memories OUT to a real Obsidian vault as `.md` files with YAML
 * frontmatter, so the agent's memories become plain markdown a human can open
 * and edit. Output is lossless — every written file parses back via
 * `parseVaultFile` to an equivalent title / tags / content / metadata.
 *
 * Path safety is the critical concern: memory titles and namespaces are
 * untrusted (a title like `../../etc/passwd` must never escape the vault dir).
 * Filenames/namespaces are sanitized, and every write is confined under the
 * resolved real vault path — confineToVault rejects both lexical `..` traversal
 * AND a target whose existing parent is a symlink escaping the vault (TOCTOU).
 */

/** Characters that are unsafe in a filename across platforms, plus control chars. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\x00-\x1f<>:"/\\|?*]/g;
const MAX_FILENAME_STEM = 80;

// Bookkeeping keys + strip helpers live in the leaf module vault/bookkeeping.ts
// (rowToMemory in db/repository also strips them, and repository cannot import
// this file without a cycle). Re-exported here for the existing import sites.
export {
  RESERVED_VAULT_META_KEY,
  VAULT_BOOKKEEPING_KEYS,
  stripVaultBookkeeping,
} from './bookkeeping.js';
import { stripVaultBookkeeping } from './bookkeeping.js';

/**
 * Resolve `relPath` under the (already real, symlink-free) `vaultRoot` and
 * return the absolute target IFF it stays inside the vault — otherwise `null`.
 * Single source of truth for path confinement: every vault write (markdown
 * export, JSON Canvas) routes through this so an untrusted, traversal-bearing
 * input can never escape the vault dir.
 *
 * Two layers of defence:
 *   1. Lexical: the resolved target must stay under `vaultRoot` (kills `..`).
 *   2. Symlink (TOCTOU): a lexically-safe target can still escape if an
 *      intermediate directory is a symlink pointing outside the vault (e.g. a
 *      pre-planted `<vault>/notes -> /etc`). So we realpath the deepest EXISTING
 *      ancestor of the target and re-verify it stays under `vaultRoot`. This
 *      catches a symlinked namespace subdir before `writeFileSync` follows it.
 */
export function confineToVault(vaultRoot: string, relPath: string): string | null {
  const absTarget = path.resolve(vaultRoot, relPath);
  if (absTarget !== vaultRoot && !absTarget.startsWith(vaultRoot + path.sep)) {
    return null;
  }

  // Walk up to the deepest ancestor that already exists on disk and resolve its
  // real path. If any existing component is a symlink that escapes the vault,
  // the realpath will fall outside `vaultRoot` and we reject.
  let probe = absTarget;
  while (probe !== vaultRoot && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    /* c8 ignore next */
    if (parent === probe) break; // filesystem root reached (defensive)
    probe = parent;
  }
  const realExisting = fs.realpathSync(probe);
  if (realExisting !== vaultRoot && !realExisting.startsWith(vaultRoot + path.sep)) {
    return null;
  }

  // The TARGET LEAF itself must not be a symlink. A DANGLING leaf symlink (link
  // present, target absent) defeats the ancestor walk above — fs.existsSync
  // follows it and returns false, so the loop skips PAST it up to the vault root
  // and the realpath check passes, yet writeFileSync would FOLLOW the link and
  // escape the vault (battle-v5 round-2, confirmed: a pre-planted
  // <vault>/x.canvas -> /outside let memory_canvas / memory_export_vault write
  // outside). lstat does not follow the link, so it flags the symlink itself —
  // dangling or live — and we reject. A real new file (ENOENT) passes through.
  try {
    if (fs.lstatSync(absTarget).isSymbolicLink()) {
      return null;
    }
  } catch {
    /* ENOENT: nothing at the target path yet — a normal new write. */
  }

  return absTarget;
}

/**
 * B3: clamp IEEE-754 artifacts out of frontmatter scores. Importance is mutated
 * multiplicatively (decay/boost), so noise like `0.8 * 1.05 = 0.8400000000000001`
 * otherwise lands VERBATIM in the YAML and churns git diffs with non-edits.
 * 4 decimals is far below any scoring threshold (maturity tiers move in 0.05+
 * steps), and the rounded value round-trips exactly through parseMemoryFile.
 * importance_score is the only float score the frontmatter carries
 * (confidence_score is derived state and never serialized).
 */
function roundScore(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Serialize a memory to Obsidian markdown: `---` fenced YAML frontmatter
 * followed by the raw memory content as the body. Frontmatter keys are emitted
 * in a deterministic order; optional fields are omitted when absent/empty so the
 * file stays clean and the round-trip is stable.
 */
export function memoryToMarkdown(memory: Memory & { valid_to?: string | null }): string {
  // Deterministic field order. Every AUTHORED field is emitted so the file is a
  // lossless source of truth (parseMemoryFile reproduces all of these). Only
  // optional keys are omitted when absent/empty to keep the file clean. Derived
  // state (embeddings, FTS, access stats, resolved links) is never written — it
  // is recomputed by `memory rebuild`.
  const front: Record<string, unknown> = { id: memory.id };
  if (memory.title) front.title = memory.title;
  front.scope = memory.scope;
  if (memory.namespace) front.namespace = memory.namespace;
  if (memory.document_type) front.document_type = memory.document_type;
  if (memory.source) front.source = memory.source;
  if (memory.author) front.author = memory.author;
  if (memory.department) front.department = memory.department;
  // Emit tags lowercased so the round-trip is lossless: normalizeFrontmatterTags
  // lowercases every tag, so emitting mixed-case (e.g. 'Infra') would parse back
  // as 'infra' and break equivalence.
  if (memory.tags.length > 0) front.tags = memory.tags.map((t) => t.toLowerCase());
  front.access_level = memory.access_level;
  front.language = memory.language;
  front.importance_score = roundScore(memory.importance_score);
  if (memory.expires_at) front.expires_at = memory.expires_at;
  if (memory.agent_id) front.agent_id = memory.agent_id;
  // Emit only USER metadata: the sync bookkeeping keys are per-machine derived
  // state and must never reach the shared repo (see VAULT_BOOKKEEPING_KEYS).
  if (memory.metadata) {
    const userMeta = stripVaultBookkeeping(memory.metadata);
    if (Object.keys(userMeta).length > 0) front.metadata = userMeta;
  }
  front.created_at = memory.created_at;
  front.updated_at = memory.updated_at;
  front.provenance = memory.provenance;
  // Deletion tombstone (set on soft-delete/forget) travels with the file so a
  // git merge can suppress another branch's live copy instead of resurrecting it.
  if (memory.valid_to) front.valid_to = memory.valid_to;

  // yaml.stringify ends with a trailing newline.
  const yaml = stringifyYaml(front);
  const body = memory.content.replace(/\s+$/, '');
  return `---\n${yaml}---\n\n${body}\n`;
}

/**
 * Derive a filesystem-safe `.md` filename from a memory's title (falling back to
 * its id when the title yields nothing safe). Path separators, `..`, and unsafe
 * characters are stripped — a malicious title can never escape the vault dir.
 *
 * The filename is suffixed with the FULL sanitized memory id (UUID with hyphens
 * stripped → 32 hex chars), which makes it both deterministic and collision-safe.
 * A short 8-char slice (~32 bits) risked a silent overwrite for two same-title
 * memories sharing an id prefix; the full id removes that birthday-bound hazard.
 */
export function safeVaultFilename(memory: Memory): string {
  // memory.id is a UUID, so the alnum-only id is always non-empty; the
  // `|| 'memory'` tail is purely defensive.
  /* c8 ignore next */
  const idSlice = memory.id.replace(/[^a-zA-Z0-9]/g, '') || 'memory';

  const raw = memory.title ?? '';
  const stem = raw
    .replace(UNSAFE_FILENAME_CHARS, ' ') // path seps & unsafe chars → space
    .replace(/\.+/g, ' ') // collapse dots (kills `..` traversal)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILENAME_STEM)
    .trim()
    .replace(/ /g, '-');

  // No safe characters survived (empty / symbol-only / no title) → use the id.
  if (!stem) {
    return `${idSlice}.md`;
  }

  // Title-derived stem is non-unique by nature → suffix the full sanitized id so
  // two same-title memories never collide and the result stays deterministic.
  return `${stem}-${idSlice}.md`;
}

export interface ExportVaultResult {
  vault_path: string;
  files_written: number;
  files: string[];
}

/**
 * Export currently-valid, top-level memories (`parent_id IS NULL`) to a vault
 * directory, optionally filtered by scope/namespace. Namespaced memories land
 * under `<vault>/<namespace>/`. The vault directory (and any namespace subdir)
 * is created if missing. ALL writes are confined under the resolved real vault
 * path — a path computed for an untrusted title that escapes the vault is
 * skipped, never written.
 *
 * Returns the resolved vault path, the number of files written, and the
 * vault-relative path of each written file.
 */
export function exportMemoriesToVault(
  db: Database.Database,
  opts: {
    vaultPath: string;
    scope?: string;
    namespace?: string;
    // RBAC §6 (battle F4): a principal's egress ceiling (allow-list of levels).
    // Intersected with the configured vault egress cap so a low-clearance key
    // can never write above-ceiling content to disk. undefined → config-only
    // (byte-identical to the pre-RBAC / legacy / local path).
    accessCeiling?: AccessLevel[];
  },
): ExportVaultResult {
  // Create the vault dir first so we can resolve its real (symlink-free) path.
  fs.mkdirSync(opts.vaultPath, { recursive: true });
  const vaultRoot = fs.realpathSync(opts.vaultPath);

  const conditions = ['parent_id IS NULL', 'valid_to IS NULL', 'tx_expired IS NULL'];
  const params: unknown[] = [];
  if (opts.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(opts.namespace);
  }

  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    )
    .all(...params);

  const files: string[] = [];

  for (const row of rows) {
    const memory = rowToMemory(row);
    const filename = safeVaultFilename(memory);

    // Namespaced memories live in a per-namespace subdir; the namespace is also
    // sanitized so it can't traverse out of the vault.
    const subdir = memory.namespace ? safeSubdir(memory.namespace) : '';
    const relPath = subdir ? path.join(subdir, filename) : filename;

    // Confine the write under the REAL vault root. Lexical sanitization above
    // prevents `..` traversal; confineToVault additionally rejects a target
    // whose existing parent is a symlink escaping the vault (TOCTOU), so a
    // pre-planted `<vault>/<namespace> -> /outside` symlink is skipped, never
    // written through.
    // M2.5: egress filter — a full re-export must NOT reintroduce a memory that
    // exceeds the configured sensitivity cap (or matches a deny_glob). When
    // blocked, applyEgressFilter writes nothing AND purges any stale file.
    // F4: intersect the operator's vault egress cap with the caller principal's
    // access ceiling — the more restrictive of the two wins.
    if (!applyEgressFilter(vaultRoot, relPath, memoryToMarkdown(memory), memory, intersectEgressWithCeiling(getVaultEgress(), opts.accessCeiling))) {
      continue;
    }
    files.push(relPath);
  }

  return {
    vault_path: vaultRoot,
    files_written: files.length,
    files,
  };
}

/**
 * Sanitize a namespace into a single safe path segment. Strips separators and
 * `..` so a hostile namespace can never traverse out of the vault root.
 */
export function safeSubdir(namespace: string): string {
  const seg = namespace
    .replace(UNSAFE_FILENAME_CHARS, ' ')
    .replace(/\.+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return seg;
}

// ── M2.5: Vault egress filter ────────────────────────────────────────────────

/**
 * Sensitivity ordering for access levels. A higher rank is MORE sensitive, so a
 * configured `max_access_level` cap admits everything at or below it and blocks
 * anything strictly above. Mirrors the order of ACCESS_LEVELS in constants/enums
 * (public < internal < confidential < restricted) but is declared here so the
 * egress policy is self-contained and dependency-free at the comparison point.
 */
export const ACCESS_LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/**
 * Egress policy for the git-shared vault. All fields optional; an empty/undefined
 * policy means NO filtering (the historical write-through behaviour). This shape
 * is the runtime mirror of `config.vault.egress` (see config/loader.ts) and is
 * passed in so the predicates below stay pure (no config-singleton coupling).
 */
export interface EgressPolicy {
  /** Inclusive cap — a memory above this sensitivity is never mirrored. */
  max_access_level?: AccessLevel;
  /** Vault-relative globs (picomatch) whose matches are never mirrored. */
  deny_globs?: string[];
}

/**
 * True when `level` is STRICTLY more sensitive than `cap` (equal is allowed).
 * Fail-CLOSED on an unknown/non-canonical access_level: an unrecognized level is
 * treated as maximally sensitive so a typo'd or future label is kept OUT of the
 * git-shared vault rather than silently leaking (the alternative — unknown→0 via
 * `undefined > n` being false — is fail-open).
 */
export function accessLevelExceedsCap(level: AccessLevel, cap: AccessLevel): boolean {
  const levelRank = ACCESS_LEVEL_RANK[level] ?? Number.MAX_SAFE_INTEGER;
  const capRank = ACCESS_LEVEL_RANK[cap] ?? 0;
  return levelRank > capRank;
}

/**
 * RBAC §6 (battle F4): fold a per-request principal access ceiling (the allow-
 * list `principalAccessCeiling()` returns — `public..maxAccessLevel`) into the
 * configured {@link EgressPolicy}, so a disk-writing vault export honours BOTH
 * the operator's vault cap AND the calling key's clearance. The principal cap is
 * the highest-ranked level in its allow-list; the effective `max_access_level`
 * is the MORE restrictive (lower rank) of that and any configured cap. Returns
 * the policy unchanged when no ceiling applies (legacy/local/full-clearance) so
 * existing behaviour is byte-identical. deny_globs pass through untouched.
 */
export function intersectEgressWithCeiling(
  policy: EgressPolicy | undefined,
  ceiling: readonly AccessLevel[] | undefined,
): EgressPolicy | undefined {
  if (!ceiling || ceiling.length === 0) return policy;
  // The ceiling allow-list is contiguous from public up; its cap is the highest
  // rank present. Fail-closed: an unrecognized member is ignored for the max
  // (it can't widen the cap).
  let ceilCap: AccessLevel = 'public';
  for (const lvl of ceiling) {
    if ((ACCESS_LEVEL_RANK[lvl] ?? -1) > ACCESS_LEVEL_RANK[ceilCap]) ceilCap = lvl;
  }
  const configuredCap = policy?.max_access_level;
  const effectiveCap =
    configuredCap && ACCESS_LEVEL_RANK[configuredCap] < ACCESS_LEVEL_RANK[ceilCap]
      ? configuredCap
      : ceilCap;
  return { ...policy, max_access_level: effectiveCap };
}

/**
 * Decide whether a memory must be KEPT OUT of the git-shared vault. A memory is
 * blocked when its access_level exceeds the configured cap OR its vault-relative
 * target path matches any deny_glob. With no policy (or empty fields), nothing is
 * blocked — preserving current behaviour. `relPath` is matched with POSIX
 * separators so globs are portable across platforms.
 */
export function isEgressBlocked(
  memory: Pick<Memory, 'access_level'>,
  relPath: string,
  policy: EgressPolicy | undefined,
): boolean {
  if (!policy) return false;

  if (policy.max_access_level && accessLevelExceedsCap(memory.access_level, policy.max_access_level)) {
    return true;
  }

  if (policy.deny_globs && policy.deny_globs.length > 0) {
    const posixRel = relPath.split(path.sep).join('/');
    // nocase: a case-variant namespace (e.g. `Secrets/`) must not dodge a
    // lowercase `secrets/**` deny on a case-insensitive filesystem where both
    // resolve to the same directory.
    if (picomatch.isMatch(posixRel, policy.deny_globs, { nocase: true })) {
      return true;
    }
  }

  return false;
}

/**
 * Egress-aware write: when the memory passes the policy, write `contents` to the
 * confined target and return true. When it is BLOCKED, write nothing AND purge
 * any stale file already at that path (so a memory that becomes restricted — or
 * a path that a new deny_glob starts matching — is removed from the vault rather
 * than left behind) and return false. The write/purge are confined under the
 * vault root via confineToVault, so an untrusted relPath can never escape.
 */
export function applyEgressFilter(
  vaultRoot: string,
  relPath: string,
  contents: string,
  memory: Pick<Memory, 'access_level'>,
  policy: EgressPolicy | undefined,
): boolean {
  const abs = confineToVault(vaultRoot, relPath);
  if (abs === null) return false;

  if (isEgressBlocked(memory, relPath, policy)) {
    try {
      fs.unlinkSync(abs);
    } catch {
      /* already absent — nothing to purge */
    }
    return false;
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf-8');
  return true;
}
