import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExportVault } from '../../tools/export-vault.js';
import { handleVaultSync } from '../../tools/vault-sync.js';
import { getMemoryById } from '../../db/repository.js';
import { parseVaultFile } from '../../vault/parser.js';
import { parseMemoryFile } from '../../vault/memory-file.js';

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

  it('recovers agent_id and access_level from frontmatter on re-sync (attribution survives)', async () => {
    // The writer emits agent_id + access_level to frontmatter, and the rebuild
    // path recovers them — but vault_sync hardcoded access_level='internal' and
    // dropped agent_id, so a team export_vault → vault_sync round-trip lost
    // attribution (memory_attribution.by_agent went unattributed) and silently
    // downgraded access_level. The two round-trip paths must not diverge.
    const dir = mkdtempSync(join(tmpdir(), 'vault-attr-'));
    try {
      const dbA = createTestDb();
      const m = await handleStore(dbA, embedder, {
        content: 'a decision made by a specific teammate',
        scope: 'project',
        namespace: basename(dir),
      });
      dbA
        .prepare('UPDATE memories SET agent_id = ?, access_level = ? WHERE id = ?')
        .run('agent-bruno', 'confidential', m.memory.id);

      await handleExportVault(dbA, { vault_path: dir });

      const dbB = createTestDb();
      await handleVaultSync(dbB, embedder, { vault_path: dir });

      const recovered = getMemoryById(dbB, m.memory.id);
      expect(recovered).not.toBeNull();
      expect(recovered?.agent_id).toBe('agent-bruno');
      expect(recovered?.access_level).toBe('confidential');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * E2E-found (2-dev vault sim): the SAME .md imported to 178 bytes via vault_sync
 * but 177 via rebuild — parseVaultFile kept the body's trailing newline while
 * parseMemoryFile strips it. The writer emits `${body}\n`, so the STRIPPED form
 * is the canonical content; the two import paths must not diverge (a one-byte
 * drift breaks exact-content equality on a team's git round-trip and silently
 * re-embeds).
 */
describe('the two import paths parse identical content (VAULT-PARSE-PARITY)', () => {
  it('parseVaultFile (sync path) and parseMemoryFile (rebuild path) agree byte-for-byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-parity-'));
    try {
      const raw = '---\nid: parity-1\ntitle: Parity\nscope: project\n---\n\nSame bytes through either path.\n';
      const abs = join(dir, 'parity.md');
      writeFileSync(abs, raw, 'utf-8');

      const syncSide = parseVaultFile(abs, 'parity.md', 0).content;
      const rebuildSide = parseMemoryFile(raw).content;

      expect(syncSide).toBe(rebuildSide);
      expect(syncSide).toBe('Same bytes through either path.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
