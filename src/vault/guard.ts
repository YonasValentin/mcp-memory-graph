import fs from 'node:fs';

/**
 * Assert that `vaultPath` exists and is a directory, throwing a uniform error
 * otherwise. Shared by the `vault_sync` and `vault_status` tool entry points so
 * both reject a missing/non-directory vault identically.
 *
 * NOTE: this uses `statSync` (follows symlinks) and is intentionally distinct
 * from `scanVault`'s `lstatSync` symlink-rejecting guard (battle-v15 GT-2), which
 * must NOT be folded in here.
 *
 * @param vaultPath Absolute or relative path to the candidate vault directory.
 * @throws Error when the path does not exist or is not a directory.
 */
export function assertVaultDir(vaultPath: string): void {
  const stat = fs.statSync(vaultPath, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${vaultPath}`);
  }
}
