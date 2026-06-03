import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleVaultSync } from '../../tools/vault-sync.js';
import { handleVaultStatus } from '../../tools/vault-status.js';

const embedder = new MockEmbeddingProvider();

/**
 * vault_status must agree with vault_sync on what counts as "changed" (persona P4).
 *
 * vault_sync stores AND compares the RAW fs `mtimeMs`; vault_status floored it
 * (`Math.floor(file.mtimeMs)`). On any filesystem with sub-millisecond mtime
 * precision (APFS/ext4) the floored value diverges from the stored raw value, so
 * every just-synced file was perpetually reported as "changed" (synced_files=0),
 * directly contradicting vault_sync's own files_unchanged.
 */
describe('vault_status agrees with vault_sync on unchanged files (VAULT-STATUS-1)', () => {
  it('reports a just-synced file as synced, not changed, even with a sub-ms mtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-status-'));
    try {
      const note = join(dir, 'note.md');
      writeFileSync(note, '# Note\n\nbody about caching strategy\n');
      // Force a sub-millisecond mtime so flooring would diverge from the raw value.
      const frac = 1_700_000_000.123456; // seconds
      utimesSync(note, frac, frac);

      const db = createTestDb();
      await handleVaultSync(db, embedder, { vault_path: dir });

      const status = handleVaultStatus(db, { vault_path: dir });
      expect(status.total_files).toBe(1);
      expect(status.changed_files).toBe(0);
      expect(status.synced_files).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
