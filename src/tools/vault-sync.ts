import type Database from 'better-sqlite3';
import type { EmbeddingProvider, VaultSyncResult } from '../types.js';
import { syncVault } from '../vault/sync.js';
import { assertVaultDir } from '../vault/guard.js';

export async function handleVaultSync(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: {
    vault_path: string;
    chunk_size?: number;
    chunk_overlap?: number;
    force?: boolean;
    include_patterns?: string[];
    exclude_patterns?: string[];
  },
): Promise<VaultSyncResult> {
  assertVaultDir(input.vault_path);

  return syncVault(db, embedder, {
    vaultPath: input.vault_path,
    chunkSize: input.chunk_size,
    chunkOverlap: input.chunk_overlap,
    force: input.force,
    includePatterns: input.include_patterns,
    excludePatterns: input.exclude_patterns,
  });
}
