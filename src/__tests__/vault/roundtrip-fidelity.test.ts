import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExportVault } from '../../tools/export-vault.js';
import { handleVaultSync } from '../../tools/vault-sync.js';
import { getMemoryById } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();

/**
 * Vault round-trip fidelity (persona P3).
 *
 * memory_export_vault writes importance_score + created_at + updated_at into the
 * frontmatter, but vault_sync's buildMemoryRow hardcoded importance_score=0.5 and
 * created_at/updated_at=now, silently discarding the frontmatter values it could
 * have recovered. (confidence/access/stability are genuinely unrecoverable — the
 * writer does not emit them — but importance + timestamps are present and must
 * survive a round-trip.)
 */
describe('vault round-trip preserves importance + timestamps it persists (VAULT-FIDELITY-1)', () => {
  it('recovers importance_score and created_at from frontmatter on re-sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-fidelity-'));
    try {
      const dbA = createTestDb();
      const m = await handleStore(dbA, embedder, {
        content: 'high-criticality runbook step',
        importance_score: 0.9,
        scope: 'project',
        namespace: basename(dir),
      });
      // Pin a clearly-old created_at so recovery is unambiguous.
      dbA.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', m.memory.id);

      await handleExportVault(dbA, { vault_path: dir });

      const dbB = createTestDb();
      await handleVaultSync(dbB, embedder, { vault_path: dir });

      const recovered = getMemoryById(dbB, m.memory.id);
      expect(recovered).not.toBeNull();
      expect(recovered?.importance_score).toBe(0.9);
      expect(recovered?.created_at).toBe('2020-01-01T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
