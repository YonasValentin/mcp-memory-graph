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

  it('tolerates malformed metadata when resolving wikilinks (corrupt JSON + non-array links)', async () => {
    const vault = makeVault();
    try {
      const db = createTestDb();
      const embedder = new MockEmbeddingProvider();
      await handleVaultSync(db, embedder, { vault_path: vault });

      const auth = db.prepare("SELECT id, metadata FROM memories WHERE title = 'Auth'").get() as {
        id: string;
        metadata: string;
      };
      const jwt = db.prepare("SELECT id, metadata FROM memories WHERE title = 'JWT'").get() as {
        id: string;
        metadata: string;
      };

      // Auth: invalid JSON metadata → JSON.parse throws → row is skipped (not fatal).
      db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run('{not valid json', auth.id);

      // JWT: valid JSON, correct vault_path, but `links` is NOT an array → falls
      // back to an empty link set rather than crashing.
      const jwtMeta = JSON.parse(jwt.metadata) as Record<string, unknown>;
      jwtMeta.links = 'definitely-not-an-array';
      db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(
        JSON.stringify(jwtMeta),
        jwt.id,
      );

      // Re-sync: resolveVaultWikilinks runs over the corrupted rows and must not
      // throw — the corrupt-JSON row is skipped and the non-array `links` row is
      // coerced to an empty link set. The Middleware row still resolves cleanly.
      const result = await handleVaultSync(db, embedder, { vault_path: vault });
      expect(result).toBeDefined();
      const middleware = db
        .prepare("SELECT id FROM memories WHERE title = 'Middleware'")
        .get() as { id: string };
      expect(getOutgoingLinks(db, middleware.id).length).toBeGreaterThan(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
