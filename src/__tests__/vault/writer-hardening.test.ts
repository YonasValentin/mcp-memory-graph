/**
 * Group G5 hardening for src/vault/writer.ts (Finding 10):
 *
 *   1. (SECURITY) Path confinement realpathed only the vault ROOT, not the
 *      write TARGET. A symlink already inside the vault whose name matches a
 *      sanitized namespace segment (e.g. <vault>/notes -> /etc) let an
 *      agent-controlled namespace write THROUGH the symlink, escaping the vault.
 *      The resolved target's parent must be realpathed and re-confined.
 *   2. Mixed-case tags must round-trip losslessly (the parser lowercases tags,
 *      so the writer must emit lowercase to match).
 *   3. The filename id suffix must not collide two distinct memories that share
 *      a title and an 8-hex id prefix (silent overwrite / data loss).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { getMemoryById, rowToMemory } from '../../db/repository.js';
import { parseVaultFile } from '../../vault/parser.js';
import { memoryToMarkdown, safeVaultFilename, exportMemoriesToVault, confineToVault } from '../../vault/writer.js';
import { writeCanvasFile } from '../../vault/canvas.js';
import type { Memory } from '../../types.js';

let db: Database.Database;
let vaultDir: string;
let outsideDir: string;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vault-harden-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vault-OUTSIDE-'));
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

function memOf(id: string): Memory {
  const row = getMemoryById(db, id);
  if (!row) throw new Error(`memory ${id} not found`);
  return rowToMemory(row);
}

describe('symlink target confinement (TOCTOU escape)', () => {
  it('does NOT write through a symlinked namespace subdir that points outside the vault', async () => {
    // Plant a hostile symlink INSIDE the vault: <vault>/notes -> <outsideDir>.
    // An agent-controlled namespace 'notes' sanitizes to the segment 'notes',
    // so the naive write target <vault>/notes/<file>.md would follow the symlink
    // and land in <outsideDir> — escaping the vault.
    const realVault = fs.realpathSync(vaultDir);
    const realOutside = fs.realpathSync(outsideDir);
    fs.symlinkSync(realOutside, path.join(realVault, 'notes'), 'dir');

    await handleStore(db, embedder, {
      content: 'escape via symlinked namespace subdir',
      title: 'Escape Doc',
      scope: 'project',
      namespace: 'notes',
    });

    const result = exportMemoriesToVault(db, { vaultPath: vaultDir });

    // Nothing may have been written into the outside directory through the symlink.
    const outsideEntries = fs.readdirSync(realOutside);
    expect(outsideEntries.length).toBe(0);
    // The escaping memory must have been SKIPPED (not written), so 0 files.
    expect(result.files_written).toBe(0);
  });

  it('still writes a legitimate namespaced memory when no symlink is in the way', async () => {
    await handleStore(db, embedder, {
      content: 'legit namespaced note',
      title: 'Legit',
      scope: 'project',
      namespace: 'notes',
    });
    const result = exportMemoriesToVault(db, { vaultPath: vaultDir });
    expect(result.files_written).toBe(1);
    const abs = path.join(result.vault_path, result.files[0]);
    expect(fs.existsSync(abs)).toBe(true);
    expect(abs.startsWith(result.vault_path + path.sep)).toBe(true);
  });
});

describe('dangling-symlink LEAF target confinement (battle-v5 round-2, CONFIRMED escape)', () => {
  // confineToVault realpath'd only the deepest EXISTING ancestor. A write TARGET
  // that is itself a symlink — especially a DANGLING one (link present, target
  // absent) — was walked PAST (existsSync follows the dangling link → false), so
  // the guard returned an in-vault path and writeFileSync then FOLLOWED the link,
  // creating a file OUTSIDE the chosen vault. Reproduced via memory_canvas (and
  // memory_export_vault shares the guard) with any name incl. the default.
  it('confineToVault rejects a symlinked leaf target (dangling, pointing outside)', () => {
    const realVault = fs.realpathSync(vaultDir);
    const realOutside = fs.realpathSync(outsideDir);
    // Dangling: the symlink exists, its target does NOT.
    fs.symlinkSync(path.join(realOutside, 'pwned.canvas'), path.join(realVault, 'evil.canvas'));
    expect(confineToVault(realVault, 'evil.canvas')).toBeNull();
  });

  it('confineToVault rejects a symlinked leaf even when its target already exists', () => {
    const realVault = fs.realpathSync(vaultDir);
    const realOutside = fs.realpathSync(outsideDir);
    fs.writeFileSync(path.join(realOutside, 'live.canvas'), 'x');
    fs.symlinkSync(path.join(realOutside, 'live.canvas'), path.join(realVault, 'live.canvas'));
    expect(confineToVault(realVault, 'live.canvas')).toBeNull();
  });

  it('writeCanvasFile does NOT follow a dangling symlink leaf out of the vault', () => {
    const realVault = fs.realpathSync(vaultDir);
    const realOutside = fs.realpathSync(outsideDir);
    // name 'evil' sanitizes to stem 'evil' → relPath 'evil.canvas'.
    fs.symlinkSync(path.join(realOutside, 'pwned.canvas'), path.join(realVault, 'evil.canvas'));
    const out = writeCanvasFile({ nodes: [], edges: [] }, realVault, 'evil');
    // Nothing escaped to the outside dir through the symlink.
    expect(fs.existsSync(path.join(realOutside, 'pwned.canvas'))).toBe(false);
    expect(fs.readdirSync(realOutside).length).toBe(0);
    // The write landed strictly inside the vault.
    const rp = fs.realpathSync(out);
    expect(rp === realVault || rp.startsWith(realVault + path.sep)).toBe(true);
  });

  it('a legitimate (non-symlink) canvas filename still writes inside the vault', () => {
    const realVault = fs.realpathSync(vaultDir);
    const out = writeCanvasFile({ nodes: [], edges: [] }, realVault, 'my-graph');
    expect(fs.existsSync(out)).toBe(true);
    expect(out.startsWith(realVault + path.sep)).toBe(true);
  });

  it('battle-v15 GT-2: throws instead of following a symlink planted at the FALLBACK path', () => {
    const realVault = fs.realpathSync(vaultDir);
    const realOutside = fs.realpathSync(outsideDir);
    // Plant a dangling symlink at exactly the hardcoded fallback name. The name
    // 'memory canvas' sanitizes to stem 'memory-canvas' → primary relPath is the
    // SAME 'memory-canvas.canvas' → confineToVault rejects it (symlink leaf) →
    // the old code fell back to that very path and followed the symlink out.
    fs.symlinkSync(path.join(realOutside, 'pwned.canvas'), path.join(realVault, 'memory-canvas.canvas'));
    expect(() => writeCanvasFile({ nodes: [], edges: [] }, realVault, 'memory canvas')).toThrow(
      /escapes the vault/,
    );
    // Nothing was written through the symlink to the outside dir.
    expect(fs.existsSync(path.join(realOutside, 'pwned.canvas'))).toBe(false);
    expect(fs.readdirSync(realOutside).length).toBe(0);
  });
});

describe('mixed-case tags round-trip losslessly', () => {
  it('a memory tagged ["Infra","Deploy"] parses back to the same set', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'mixed case tag content',
      title: 'Mixed Tags',
      tags: ['Infra', 'Deploy'],
      scope: 'project',
    });
    const memory = memOf(stored.memory.id);

    const md = memoryToMarkdown(memory);
    const file = path.join(vaultDir, 'mixed.md');
    fs.writeFileSync(file, md, 'utf-8');
    const parsed = parseVaultFile(file, 'mixed.md', 0);

    // The emitted tags must equal what the parser yields back (lossless).
    const emitted = (md.match(/^\s*-\s+(\S+)/gm) ?? []).map((s) => s.replace(/^\s*-\s+/, ''));
    for (const t of parsed.tags) {
      expect(emitted).toContain(t);
    }
    // Round-trip equivalence: every original tag (case-insensitively) survives.
    for (const orig of ['Infra', 'Deploy']) {
      expect(parsed.tags).toContain(orig.toLowerCase());
    }
    // And the written frontmatter contains no upper-case tag form.
    expect(md).not.toContain('Infra');
    expect(md).not.toContain('Deploy');
  });
});

describe('filename id suffix is collision-safe for the full id', () => {
  it('two memories with the same title produce distinct files driven by the FULL id', async () => {
    const a = await handleStore(db, embedder, { content: 'one', title: 'Same Title' });
    const b = await handleStore(db, embedder, { content: 'two', title: 'Same Title' });

    const nameA = safeVaultFilename(memOf(a.memory.id));
    const nameB = safeVaultFilename(memOf(b.memory.id));
    expect(nameA).not.toBe(nameB);

    // The suffix must derive from the FULL sanitized id, not an 8-char slice, so
    // distinct memories sharing an 8-hex prefix can't collide. Assert the full
    // sanitized id is present in each filename.
    const sanA = a.memory.id.replace(/[^a-zA-Z0-9]/g, '');
    const sanB = b.memory.id.replace(/[^a-zA-Z0-9]/g, '');
    expect(nameA).toContain(sanA);
    expect(nameB).toContain(sanB);
  });

  it('exporting two same-title memories writes TWO files (no silent overwrite)', async () => {
    await handleStore(db, embedder, { content: 'first body', title: 'Dup' });
    await handleStore(db, embedder, { content: 'second body', title: 'Dup' });

    const result = exportMemoriesToVault(db, { vaultPath: vaultDir });
    expect(result.files_written).toBe(2);
    expect(new Set(result.files).size).toBe(2);
  });
});
