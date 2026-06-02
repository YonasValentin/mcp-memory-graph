import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { syncVault } from '../../vault/sync.js';

const embedder = new MockEmbeddingProvider();

/**
 * vault_sync must reconcile back to the ORIGINATING memory: a note exported with
 * frontmatter id/scope/namespace must re-import under that identity, not a fresh
 * randomUUID under namespace=<vault>. Otherwise export+sync makes duplicates and
 * the project-scoped record becomes invisible (the no-lock-in round-trip lie).
 */
describe('vault_sync — frontmatter identity round-trip', () => {
  it('honors id/scope/namespace/document_type from frontmatter', async () => {
    const db = createTestDb();
    const vault = mkdtempSync(join(tmpdir(), 'vid-'));
    writeFileSync(
      join(vault, 'note.md'),
      `---\nid: fixed-id-123\ntitle: Pooling decision\nscope: project\nnamespace: acme-billing\ndocument_type: decision\ntags: [db]\n---\n\nChose pgBouncer transaction pooling.\n`,
    );

    const r = await syncVault(db, embedder, { vaultPath: vault });
    expect(r.files_errored).toBe(0);

    const row = db
      .prepare("SELECT id, scope, namespace, document_type FROM memories WHERE parent_id IS NULL")
      .get() as { id: string; scope: string; namespace: string; document_type: string };

    expect(row.id).toBe('fixed-id-123');
    expect(row.scope).toBe('project');
    expect(row.namespace).toBe('acme-billing');
    expect(row.document_type).toBe('decision');
    rmSync(vault, { recursive: true, force: true });
  });

  it('falls back to vault defaults for a hand-authored note with no such frontmatter', async () => {
    const db = createTestDb();
    const vault = mkdtempSync(join(tmpdir(), 'vid2-'));
    writeFileSync(join(vault, 'plain.md'), `---\ntitle: Plain\n---\n\nJust a note.\n`);

    await syncVault(db, embedder, { vaultPath: vault });
    const row = db
      .prepare("SELECT scope, namespace, document_type FROM memories WHERE parent_id IS NULL")
      .get() as { scope: string; namespace: string; document_type: string };

    expect(row.scope).toBe('project');
    expect(row.namespace).toBe(basename(vault));
    expect(row.document_type).toBe('note');
    rmSync(vault, { recursive: true, force: true });
  });
});
