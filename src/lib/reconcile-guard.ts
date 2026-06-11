/**
 * Shared RBAC decision for every "reconcile by caller-supplied id" write path —
 * import-overwrite, vault_sync's frontmatter-id reconcile (both the small-file
 * and large-file paths), and consolidate's dedup-merge target. Re-battles 3 and 7
 * each surfaced the same hole, one consumer at a time: a row located by an id the
 * CALLER controls (an import payload id, a `.md` frontmatter id, a vec0 neighbour)
 * is then deleted or overwritten WITHOUT checking that it belongs to the caller's
 * namespace and sits at or below their access-level ceiling. Unguarded, each is a
 * cross-tenant delete / declassify / relocate primitive.
 *
 * `reconcileBlocked` returns true when the reconcile MUST be refused. Each caller
 * keeps its own divergent refusal response — import drops the id and inserts a
 * fresh, non-confirming row; vault_sync skips the file; consolidate skips the
 * candidate — but the DECISION lives here so a future by-id write path reuses it
 * instead of re-deriving (and re-missing) the check. `write-path-coverage-tripwire`
 * pins every known reconcile site to this function, the way the read tripwire pins
 * every content/title egress to `scopedRead`/`withCeiling`.
 */
export function reconcileBlocked(
  existing: { namespace: string | null; access_level: string },
  targetNamespace: string | null | undefined,
  ceiling: readonly string[] | undefined,
): boolean {
  // Foreign-namespace target. The undefined / null distinction is load-bearing:
  //   • `undefined` → NO namespace constraint; skip the check. import passes
  //     `forcedNamespace` here, which is undefined in unforced single-user mode
  //     (any id may overwrite), and consolidate passes undefined because
  //     findNearDuplicates already partitioned the scan to the row's namespace.
  //   • a string OR `null` → a literal target namespace to compare with `!==`.
  //     vault_sync passes `row.namespace` (string | null); the global/unscoped
  //     namespace is `null`, and `null !== null` correctly allows a true
  //     round-trip while `'team-a' !== null` correctly blocks a foreign row.
  if (targetNamespace !== undefined && existing.namespace !== targetNamespace) {
    return true;
  }
  // Over-ceiling row. `undefined` ceiling means no clearance limit (legacy /
  // single-user). Mirrors `idWithinCeiling` for the single-id MCP tools.
  if (ceiling !== undefined && !ceiling.includes(existing.access_level)) {
    return true;
  }
  return false;
}
