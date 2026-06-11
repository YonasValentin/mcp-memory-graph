/**
 * RB-8 (14th instance): vault_sync's sync_meta-ANCHORED mutation paths.
 *
 * RB-7 closed the reconcile-by-frontmatter-id breach (a `.md` whose frontmatter id
 * collides with an existing row). But vault_sync has TWO other mutation paths that
 * reconcile by the file→memory anchor stored in vault_sync_meta, NOT by frontmatter
 * id, so the RB-7 guard misses them:
 *   • a tracked file whose content CHANGED → deleteOldMemory(meta.memory_id) (hard
 *     delete the old row, then re-insert the new content);
 *   • a tracked file that was REMOVED → softDeleteOldMemory(meta.memory_id)
 *     (invalidate the row).
 * On a shared/team vault both anchor a memory that may belong to a higher clearance
 * or another namespace. A sub-ceiling principal editing or deleting the file would
 * then destroy / declassify that protected row — the same primitive as the RB-7
 * reconcile breach, on a different code path.
 *
 * These assert the FIXED invariant: a sub-ceiling sync leaves an over-ceiling
 * anchored memory intact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleVaultSync } from '../../tools/vault-sync.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';

const SUBCEILING: PrincipalContext = {
  principal: 'sub',
  keyId: 'k1',
  namespaces: ['sales'],
  maxAccessLevel: 'internal',
};

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
let dir: string;
beforeEach(() => {
  delete process.env.MCP_API_NAMESPACE;
  db = createTestDb();
});
afterEach(() => {
  db.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function makeVault(name: string, files: Record<string, string>): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-anchor-'));
  const vault = path.join(dir, name);
  fs.mkdirSync(vault, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(vault, file), content);
  }
  return vault;
}

/** Seed a vault file, sync it in at full clearance, then raise the resulting
 *  memory to 'confidential' (above the sub-ceiling principal). Returns id + path. */
async function seedConfidentialAnchor(vault: string, file: string): Promise<string> {
  process.env.MCP_API_NAMESPACE = 'sales';
  await runWithPrincipal(
    { principal: 'admin', keyId: 'k0', namespaces: ['sales'], maxAccessLevel: 'restricted' },
    () => handleVaultSync(db, embedder, { vault_path: vault }),
  );
  const row = db.prepare("SELECT id FROM memories WHERE title = 'Secret'").get() as { id: string };
  db.prepare("UPDATE memories SET access_level = 'confidential' WHERE id = ?").run(row.id);
  return row.id;
}

describe('RB-8: vault_sync anchored mutations honour the principal ceiling', () => {
  it('a CHANGED tracked file cannot hard-delete an over-ceiling anchored memory', async () => {
    const vault = makeVault('sales', {
      'secret.md': '---\ntitle: Secret\n---\nOriginal confidential body.',
    });
    const id = await seedConfidentialAnchor(vault, 'secret.md');

    // Sub-ceiling principal edits the file and re-syncs.
    fs.writeFileSync(path.join(vault, 'secret.md'), '---\ntitle: Secret\n---\nRewritten by sales.');
    await runWithPrincipal(SUBCEILING, () => handleVaultSync(db, embedder, { vault_path: vault }));

    const after = db
      .prepare<[string], { content: string; valid_to: string | null }>(
        'SELECT content, valid_to FROM memories WHERE id = ?',
      )
      .get(id);
    expect(after, 'confidential row must still exist').toBeTruthy();
    expect(after!.valid_to, 'must stay live').toBeNull();
    expect(after!.content, 'content must not be overwritten by a sub-ceiling editor').toContain(
      'Original confidential body',
    );
  });

  it('a REMOVED tracked file cannot invalidate an over-ceiling anchored memory', async () => {
    const vault = makeVault('sales', {
      'secret.md': '---\ntitle: Secret\n---\nOriginal confidential body.',
    });
    const id = await seedConfidentialAnchor(vault, 'secret.md');

    // Sub-ceiling principal removes the file and re-syncs.
    fs.rmSync(path.join(vault, 'secret.md'));
    await runWithPrincipal(SUBCEILING, () => handleVaultSync(db, embedder, { vault_path: vault }));

    const after = db
      .prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?')
      .get(id);
    expect(after, 'confidential row must still exist').toBeTruthy();
    expect(after!.valid_to, 'must not be invalidated by a sub-ceiling deleter').toBeNull();
  });
});
