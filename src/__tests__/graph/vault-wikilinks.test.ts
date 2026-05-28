import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleVaultSync } from '../../tools/vault-sync.js';
import { getOutgoingLinks, getBacklinks } from '../../graph/memory-links.js';

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), 'vault-wl-'));
  writeFileSync(join(vault, 'Auth.md'), '---\ntitle: Auth\n---\nUses [[JWT]] and [[Middleware]].');
  writeFileSync(join(vault, 'JWT.md'), '---\ntitle: JWT\n---\n[[Auth]] depends on JWT tokens.');
  writeFileSync(join(vault, 'Middleware.md'), '---\ntitle: Middleware\n---\nValidates [[JWT]] for requests.');
  return vault;
}

describe('vault wikilink resolution (Pillar 1, slice 3)', () => {
  it('resolves [[wikilinks]] into EXTRACTED memory_links on sync', async () => {
    const vault = makeVault();
    try {
      const db = createTestDb();
      await handleVaultSync(db, new MockEmbeddingProvider(), { vault_path: vault });

      const auth = db.prepare("SELECT id FROM memories WHERE title = 'Auth'").get() as { id: string };
      const jwt = db.prepare("SELECT id FROM memories WHERE title = 'JWT'").get() as { id: string };

      const out = getOutgoingLinks(db, auth.id);
      const authToJwt = out.find((l) => l.target_memory_id === jwt.id);
      expect(authToJwt).toBeDefined();
      expect(authToJwt!.source_kind).toBe('wikilink');
      expect(authToJwt!.confidence).toBe('EXTRACTED');
      expect(authToJwt!.confidence_score).toBe(1);

      // Backlink is free.
      expect(getBacklinks(db, jwt.id).some((l) => l.source_memory_id === auth.id)).toBe(true);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('does not create links for unresolved [[ghost]] targets', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'vault-ghost-'));
    writeFileSync(join(vault, 'Note.md'), '---\ntitle: Note\n---\nPoints at [[DoesNotExist]].');
    try {
      const db = createTestDb();
      await handleVaultSync(db, new MockEmbeddingProvider(), { vault_path: vault });
      const note = db.prepare("SELECT id FROM memories WHERE title = 'Note'").get() as { id: string };
      expect(getOutgoingLinks(db, note.id).length).toBe(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
