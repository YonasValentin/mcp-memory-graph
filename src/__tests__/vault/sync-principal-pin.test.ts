/**
 * RBAC v1 §5 — vault_sync row pinning under a principal context. In legacy
 * forced mode the pin (forcedNamespace()) ALWAYS equals the vault basename —
 * the path guard enforces equality before sync runs. Under a principal the
 * guard admits ANY member basename, so pinning to namespaces[0] would corrupt
 * a multi-namespace key's second vault (vault "marketing" rows planted into
 * "sales"). The pin is therefore the VAULT's basename when it is a permitted
 * namespace; a non-member basename (only reachable if a future caller skips
 * the guard) falls back to the key default — writes can never leave the key's
 * own namespace set. Frontmatter `namespace:` stays ignored (battle-v14 G1).
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

const KEY: PrincipalContext = {
  principal: 'multi-bot',
  keyId: 'key-1',
  namespaces: ['sales', 'marketing'],
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-sync-'));
  const vault = path.join(dir, name);
  fs.mkdirSync(vault, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(vault, file), content);
  }
  return vault;
}

describe('vault_sync row pinning under a principal', () => {
  it('pins rows to the member VAULT basename — not namespaces[0]', async () => {
    const vault = makeVault('marketing', {
      'a.md': '---\ntitle: Campaign\n---\nBig campaign notes.',
    });
    await runWithPrincipal(KEY, () => handleVaultSync(db, embedder, { vault_path: vault }));
    const rows = db.prepare('SELECT DISTINCT namespace FROM memories').all() as Array<{
      namespace: string;
    }>;
    expect(rows.map((r) => r.namespace)).toEqual(['marketing']);
  });

  it('frontmatter namespace cannot plant rows outside the key set (G1 parity)', async () => {
    const vault = makeVault('sales', {
      'evil.md': '---\nnamespace: victim\nscope: project\ntitle: Evil\n---\nPayload.',
    });
    await runWithPrincipal(KEY, () => handleVaultSync(db, embedder, { vault_path: vault }));
    const foreign = db
      .prepare("SELECT COUNT(*) c FROM memories WHERE namespace NOT IN ('sales', 'marketing')")
      .get() as { c: number };
    expect(foreign.c).toBe(0);
    const ns = db.prepare("SELECT namespace FROM memories WHERE title = 'Evil'").get() as {
      namespace: string;
    };
    expect(ns.namespace).toBe('sales');
  });

  it('a NON-member basename falls back to the key default (fail-closed)', async () => {
    // Only reachable when a caller skips the vaultPathInForcedNamespace guard —
    // rows must still never leave the key's own namespaces.
    const vault = makeVault('rogue', {
      'b.md': '---\ntitle: Rogue\n---\nUnguarded path.',
    });
    await runWithPrincipal(KEY, () => handleVaultSync(db, embedder, { vault_path: vault }));
    const ns = db.prepare("SELECT namespace FROM memories WHERE title = 'Rogue'").get() as {
      namespace: string;
    };
    expect(ns.namespace).toBe('sales');
  });

  it('unscoped behaviour unchanged: frontmatter honored, else vault name', async () => {
    const vault = makeVault('myvault', {
      'fm.md': '---\nnamespace: projA\nscope: project\ntitle: WithFm\n---\nBody.',
      'plain.md': '---\ntitle: Plain\n---\nBody.',
    });
    await handleVaultSync(db, embedder, { vault_path: vault });
    const withFm = db.prepare("SELECT namespace FROM memories WHERE title = 'WithFm'").get() as {
      namespace: string;
    };
    const plain = db.prepare("SELECT namespace FROM memories WHERE title = 'Plain'").get() as {
      namespace: string;
    };
    expect(withFm.namespace).toBe('projA');
    expect(plain.namespace).toBe('myvault');
  });
});
