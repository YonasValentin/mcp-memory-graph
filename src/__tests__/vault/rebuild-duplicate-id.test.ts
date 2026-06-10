/**
 * F-REBUILD-DUPID — two vault .md files sharing one frontmatter id (e.g. a
 * hand-placed/orphaned legacy copy next to the canonical note) crashed the WHOLE
 * rebuild with `SqliteError: UNIQUE constraint failed: memories.id` — exactly
 * the disaster-recovery scenario rebuild exists for. syncVault already guards
 * this (first-claim-wins, collision skipped + reported); rebuildFromVault now
 * ports the same guard: duplicate id → skip + warn + counted, never a crash.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { rebuildFromVault } from '../../vault/rebuild.js';
import { logger } from '../../lib/logger.js';

const embedder = new MockEmbeddingProvider();

let vault: string;
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-dup-'));
  process.env.MCP_VAULT_PATH = vault;
});
afterEach(() => {
  delete process.env.MCP_VAULT_PATH;
  fs.rmSync(vault, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** All live .md files under the vault (skipping .memory/.git), like rebuild does. */
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.md') ? [p] : [];
  });

describe('rebuildFromVault duplicate-frontmatter-id guard (F-REBUILD-DUPID)', () => {
  it('skips the duplicate file instead of crashing, counts + warns it', async () => {
    const db1 = createTestDb();
    await handleStore(db1, embedder, {
      content: 'The retry budget is 3 attempts.',
      title: 'Retry',
      scope: 'global',
    });
    await handleStore(db1, embedder, {
      content: 'Vector search uses sqlite-vec.',
      title: 'Vectors',
      scope: 'global',
    });
    db1.close();

    // Plant an orphaned legacy copy of the Retry note: same frontmatter id,
    // different filename — the classic hand-restored-backup-next-to-canonical.
    const retryFile = walk(vault).find((p) =>
      fs.readFileSync(p, 'utf-8').includes('The retry budget is 3 attempts.'),
    );
    expect(retryFile).toBeDefined();
    const legacyCopy = path.join(path.dirname(retryFile!), 'Retry (legacy copy).md');
    fs.copyFileSync(retryFile!, legacyCopy);

    const warnSpy = vi.spyOn(logger, 'warn');

    const db2 = createTestDb();
    // RED: previously threw `UNIQUE constraint failed: memories.id` here.
    const result = await rebuildFromVault(db2, embedder, vault);

    // First claim wins: 2 unique memories indexed from 3 files, 1 skipped.
    expect(result.memories).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.duplicateFiles).toHaveLength(1);
    expect(result.duplicateFiles[0]).toMatch(/\.md$/);

    // Exactly one row per id — no fork, no crash.
    const rows = db2
      .prepare<[], { id: string; cnt: number }>(
        'SELECT id, COUNT(*) as cnt FROM memories GROUP BY id',
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.cnt === 1)).toBe(true);

    // The skip is observable: a structured warn naming the event + both paths.
    const dupWarn = warnSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((o) => o.event === 'rebuild_duplicate_id_skipped');
    expect(dupWarn).toBeDefined();
    expect(String(dupWarn!.file)).toContain('.md');
    expect(String(dupWarn!.owner)).toContain('.md');
    expect(String(dupWarn!.file)).not.toBe(String(dupWarn!.owner));
    db2.close();
  });

  it('reports zero duplicates on a clean vault', async () => {
    const db1 = createTestDb();
    await handleStore(db1, embedder, { content: 'Clean vault note.', title: 'Clean', scope: 'global' });
    db1.close();

    const db2 = createTestDb();
    const result = await rebuildFromVault(db2, embedder, vault);
    expect(result.memories).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.duplicateFiles).toEqual([]);
    db2.close();
  });
});
