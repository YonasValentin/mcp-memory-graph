import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Memory, MemoryRow } from '../types.js';
import { rowToMemory } from '../db/repository.js';

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

  return absTarget;
}

/**
 * Serialize a memory to Obsidian markdown: `---` fenced YAML frontmatter
 * followed by the raw memory content as the body. Frontmatter keys are emitted
 * in a deterministic order; optional fields are omitted when absent/empty so the
 * file stays clean and the round-trip is stable.
 */
export function memoryToMarkdown(memory: Memory): string {
  // Deterministic field order. Only include optional keys when present.
  const front: Record<string, unknown> = { id: memory.id };
  if (memory.title) front.title = memory.title;
  front.scope = memory.scope;
  if (memory.namespace) front.namespace = memory.namespace;
  if (memory.document_type) front.document_type = memory.document_type;
  // Emit tags lowercased so the round-trip is lossless: parseVaultFile ->
  // normalizeFrontmatterTags lowercases every tag, so emitting mixed-case here
  // (e.g. 'Infra') would parse back as 'infra' and break equivalence.
  if (memory.tags.length > 0) front.tags = memory.tags.map((t) => t.toLowerCase());
  front.access_level = memory.access_level;
  front.language = memory.language;
  front.created_at = memory.created_at;
  front.updated_at = memory.updated_at;
  front.provenance = memory.provenance;

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
  opts: { vaultPath: string; scope?: string; namespace?: string },
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
    const absTarget = confineToVault(vaultRoot, relPath);
    if (absTarget === null) continue;

    fs.mkdirSync(path.dirname(absTarget), { recursive: true });
    fs.writeFileSync(absTarget, memoryToMarkdown(memory), 'utf-8');
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
function safeSubdir(namespace: string): string {
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
