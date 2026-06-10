/**
 * E2E-found (2-dev vault sim): vault_sync stuffed its ENTIRE bookkeeping blob —
 * the absolute local vault_path, the WHOLE parsed frontmatter, links, file_path —
 * into memories.metadata, and memory_export_vault re-emitted that blob verbatim
 * as the file's `metadata:` frontmatter. Each export→sync cycle therefore nested
 * the previous frontmatter one level deeper (metadata.frontmatter.metadata… —
 * a 20-line note grew to 81 lines after 3 cycles), and the per-developer
 * absolute vault_path flipped on every export → YAML merge conflicts in files
 * NOBODY edited → quarantine → data omission. The fix is two-sided and
 * self-healing: import keeps only USER metadata (reserved bookkeeping keys
 * stripped) plus the two flat keys resolveVaultWikilinks consumes (vault_path,
 * links); export strips the reserved keys so they never reach the shared repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExportVault } from '../../tools/export-vault.js';
import { handleVaultSync } from '../../tools/vault-sync.js';
import { syncVault } from '../../vault/sync.js';
import { parseMemoryFile } from '../../vault/memory-file.js';
import { getMemoryById } from '../../db/repository.js';
import { getOutgoingLinks } from '../../graph/memory-links.js';

const embedder = new MockEmbeddingProvider();

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** All live .md files under a vault, vault-relative (skips .memory/.git). */
function liveMd(root: string, base = root): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const abs = path.join(root, e.name);
    if (e.isDirectory()) return liveMd(abs, base);
    return e.name.endsWith('.md') ? [path.relative(base, abs)] : [];
  });
}

describe('vault metadata bookkeeping does not accrete across export→sync cycles (E2E BUG 1)', () => {
  it('a second export→sync cycle is byte-stable: no nested frontmatter, no absolute paths, user metadata survives', async () => {
    const v1 = mkTmp('vault-accrete-1-');
    const v2 = mkTmp('vault-accrete-2-');
    const v3 = mkTmp('vault-accrete-3-');

    // Dev A stores a memory with USER metadata and exports it to the shared vault.
    const dbA = createTestDb();
    await handleStore(dbA, embedder, {
      content: 'We deploy with blue-green on the runner.',
      title: 'Deploy Strategy',
      scope: 'project',
      namespace: 'nsx',
      metadata: { jira: 'ABC-1' },
    });
    handleExportVault(dbA, { vault_path: v1 });

    // Dev B: sync → export (cycle 1), then sync → export again (cycle 2).
    const dbB = createTestDb();
    await handleVaultSync(dbB, embedder, { vault_path: v1 });
    handleExportVault(dbB, { vault_path: v2 });

    const dbC = createTestDb();
    await handleVaultSync(dbC, embedder, { vault_path: v2 });
    handleExportVault(dbC, { vault_path: v3 });

    const rels = liveMd(v2);
    expect(rels).toHaveLength(1);
    const second = fs.readFileSync(path.join(v2, rels[0]), 'utf-8');
    const third = fs.readFileSync(path.join(v3, rels[0]), 'utf-8');

    // Byte-identical across cycles — no geometric frontmatter growth.
    expect(third).toBe(second);
    // The nested bookkeeping blob never reaches the shared repo …
    expect(second).not.toContain('frontmatter:');
    expect(second).not.toContain('file_path:');
    // … and neither does any per-developer ABSOLUTE path (the merge-conflict churn).
    expect(second).not.toContain(v1);
    expect(second).not.toContain(os.tmpdir());

    // The USER metadata key survives the full round-trip, alone.
    expect(parseMemoryFile(second).metadata).toEqual({ jira: 'ABC-1' });
  });

  it('self-heals an already-poisoned file on import: reserved keys stripped, user keys kept, flat bookkeeping re-stamped', async () => {
    const vault = mkTmp('vault-poisoned-');
    const id = '99999999-8888-7777-6666-555555555555';
    // A file as a PRE-FIX export wrote it: user metadata buried alongside the
    // bookkeeping blob, with another developer's absolute vault_path and a
    // nested metadata.frontmatter.metadata chain.
    fs.writeFileSync(
      path.join(vault, 'poisoned.md'),
      [
        '---',
        `id: ${id}`,
        'title: Poisoned Note',
        'scope: project',
        'namespace: nsy',
        'metadata:',
        '  jira: ABC-1',
        '  vault_path: /Users/dev-a/vaults/team',
        '  file_path: nsy/poisoned.md',
        '  links: []',
        '  frontmatter:',
        `    id: ${id}`,
        '    metadata:',
        '      vault_path: /Users/dev-a/vaults/old',
        'created_at: 2026-01-01T00:00:00.000Z',
        'updated_at: 2026-01-02T00:00:00.000Z',
        '---',
        '',
        'A note poisoned by pre-fix export cycles.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const db = createTestDb();
    const res = await syncVault(db, embedder, { vaultPath: vault });
    expect(res.files_added).toBe(1);

    const row = getMemoryById(db, id);
    expect(row).not.toBeNull();
    const meta = JSON.parse(row!.metadata!) as Record<string, unknown>;
    // User metadata recovered; the two UNAMBIGUOUS bookkeeping keys that caused
    // the accretion/churn bugs (the nested `frontmatter` blob + the absolute
    // `vault_path`) are stripped; bookkeeping is re-stamped under the reserved
    // `_vault` container scoped to THIS machine.
    expect(meta.jira).toBe('ABC-1');
    expect(meta).not.toHaveProperty('frontmatter');
    expect(meta).not.toHaveProperty('vault_path'); // flat absolute path gone
    const book = meta._vault as { vault_path?: string; links?: unknown };
    expect(book.vault_path).toBe(vault);
    expect(book.links).toEqual([]);
    expect(JSON.stringify(meta)).not.toContain('/Users/dev-a');
    // battle-v17 trade-off: legacy FLAT `links`/`file_path` are now treated as
    // user data (a user can legitimately store them), so a pre-fix file's inert
    // residue is preserved rather than risk eating real user metadata. They do
    // NOT accrete (flat scalars) and do NOT churn (no absolute path).
    expect(meta.file_path).toBe('nsy/poisoned.md');

    // The next export emits the user metadata (incl. the preserved residue),
    // never the `_vault` bookkeeping — the absolute path never reaches the repo.
    const out = mkTmp('vault-healed-');
    handleExportVault(db, { vault_path: out });
    const files = liveMd(out);
    expect(files).toHaveLength(1);
    const healed = parseMemoryFile(fs.readFileSync(path.join(out, files[0]), 'utf-8')).metadata;
    expect(healed).not.toHaveProperty('_vault');
    expect(healed).not.toHaveProperty('vault_path');
    expect(JSON.stringify(healed)).not.toContain('/Users/dev-a');
    expect((healed as Record<string, unknown>).jira).toBe('ABC-1');
  });

  it('wikilinks still resolve from the flat bookkeeping keys (vault_path + links back-compat)', async () => {
    const vault = mkTmp('vault-wikilink-');
    fs.writeFileSync(
      path.join(vault, 'target.md'),
      '---\ntitle: Target Note\n---\n\nThe target body.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(vault, 'source.md'),
      '---\ntitle: Source Note\n---\n\nSee [[Target Note]] for detail.\n',
      'utf-8',
    );

    const db = createTestDb();
    await syncVault(db, embedder, { vaultPath: vault });

    const byTitle = (t: string): string =>
      (db.prepare('SELECT id FROM memories WHERE title = ?').get(t) as { id: string }).id;
    const links = getOutgoingLinks(db, byTitle('Source Note')).filter(
      (l) => l.relation === 'links_to',
    );
    expect(links.map((l) => l.target_memory_id)).toContain(byTitle('Target Note'));
  });
});
