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

/** Copy of `meta` without the reserved bookkeeping keys (user metadata only). */
export function stripVaultBookkeeping(meta: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(meta)) {
    if (VAULT_BOOKKEEPING_KEYS.has(key)) continue;
    clean[key] = meta[key];
  }
  return clean;
}

/**
 * Copy of a memory with the reserved vault bookkeeping stripped from its
 * metadata — the EMIT-boundary guard for read/egress tools. `_vault.vault_path`
 * is an ABSOLUTE per-developer local path and must never appear in shared JSON
 * output (F-EXPORT-VAULTPATH). The DB row is left untouched —
 * sync/resolveVaultWikilinks reads `_vault` from raw rows — and it is DERIVED
 * state vault_sync re-stamps, so stripping at emit loses nothing durable.
 * Metadata that was ONLY bookkeeping emits as `null`, indistinguishable from a
 * row that never had metadata.
 */
export function stripVaultBookkeepingFromMemory<
  T extends { metadata: Record<string, unknown> | null },
>(memory: T): T {
  if (!memory.metadata) return memory;
  const clean = stripVaultBookkeeping(memory.metadata);
  if (Object.keys(clean).length === Object.keys(memory.metadata).length) return memory;
  return { ...memory, metadata: Object.keys(clean).length > 0 ? clean : null };
}
