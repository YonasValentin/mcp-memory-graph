/**
 * Vault bookkeeping keys + strip helpers. A LEAF module (no imports) so both
 * sides of the boundary can share it without a cycle: vault/writer + vault/sync
 * strip before emitting `.md` frontmatter / stamping rows, and db/repository
 * strips at the `rowToMemory` chokepoint so NO tool-facing read surface ever
 * emits the bookkeeping (writer imports repository, so repository cannot
 * import writer).
 */

/**
 * The single reserved container key vault_sync stamps its per-machine DERIVED
 * bookkeeping into: `memories.metadata._vault = { vault_path, links }`.
 * `vault_path` is an absolute local path (differs per developer — emitting it
 * flipped the file on every export and caused YAML merge conflicts in files
 * nobody edited); `links` feeds resolveVaultWikilinks. Nesting under one
 * reserved key keeps bookkeeping out of the OPEN user-metadata namespace, so a
 * user can store their own `links` / `file_path` (natural keys for a memory
 * tool) without it being mistaken for bookkeeping and silently dropped
 * (battle-v17 HIGH regression). The writer strips `_vault` before emitting
 * `metadata:` frontmatter; both sides also strip the legacy FLAT `vault_path` /
 * `frontmatter` keys older rows still carry (re-importing an emitted
 * `frontmatter` nested it one level deeper per cycle — geometric growth), so an
 * already-poisoned vault self-heals on its next sync/export. ONE shared list —
 * the two sides must never diverge.
 */
export const RESERVED_VAULT_META_KEY = '_vault';
export const VAULT_BOOKKEEPING_KEYS = new Set([RESERVED_VAULT_META_KEY, 'vault_path', 'frontmatter']);

/**
 * Copy of `meta` without ONLY the reserved `_vault` container — the
 * rowToMemory emit-chokepoint strip. Unlike the vault-boundary strip below,
 * this must NOT touch the legacy flat `vault_path`/`frontmatter` names: in
 * plain (non-vault) usage those are perfectly legitimate user keys, and hiding
 * them on every read would silently lose user data (the battle-v17 HIGH class).
 * `_vault` alone is unambiguous — underscore-prefixed, documented reserved,
 * and the writer strips/re-stamps it in vault flows.
 */
export function stripReservedVaultContainer(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  if (!(RESERVED_VAULT_META_KEY in meta)) return meta;
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(meta)) {
    if (key === RESERVED_VAULT_META_KEY) continue;
    clean[key] = meta[key];
  }
  return clean;
}

/**
 * `stripReservedVaultContainer` for a RAW metadata JSON string (as stored in
 * `memories.metadata` / `memory_versions.metadata`). Fast path: no `"_vault"`
 * substring → returned as-is, no parse. Used at the version-snapshot WRITE
 * (so new snapshots never carry the container) and at the snapshot READ
 * surfaces (so legacy snapshots written before the strip existed are covered
 * too — the fix-breaker lesson: the rowToMemory chokepoint covers `memories`
 * reads, not snapshot/raw-metadata surfaces).
 */
export function stripReservedVaultContainerFromJson(json: string | null): string | null {
  if (!json || !json.includes(`"${RESERVED_VAULT_META_KEY}"`)) return json;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return json;
    const clean = stripReservedVaultContainer(parsed as Record<string, unknown>);
    return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
  } catch {
    return json;
  }
}

/** Copy of `meta` without the reserved bookkeeping keys (user metadata only). */
export function stripVaultBookkeeping(meta: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(meta)) {
    if (VAULT_BOOKKEEPING_KEYS.has(key)) continue;
    clean[key] = meta[key];
  }
  return clean;
}

