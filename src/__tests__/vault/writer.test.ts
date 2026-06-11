/**
 * Pillar 6 (T16): bidirectional vault write-back — export memories OUT to a real
 * Obsidian vault as `.md` files with YAML frontmatter. The reverse of the
 * existing vault sync (which imports `.md` → memories). Lossless round-trip: a
 * written file must parse back via the existing `parseVaultFile` to equivalent
 * title / tags / content / metadata.
 *
 * Uses createTestDb + MockEmbeddingProvider + handleStore, and mkdtempSync for a
 * throwaway vault dir (cleaned up after each test).
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
import { invalidateMemory } from '../../db/repository.js';
import { parseVaultFile } from '../../vault/parser.js';
import {
  memoryToMarkdown,
  safeVaultFilename,
  exportMemoriesToVault,
  confineToVault,
} from '../../vault/writer.js';
import { parseMemoryFile } from '../../vault/memory-file.js';
import { rebuildFromVault } from '../../vault/rebuild.js';
import { handleExportVault } from '../../tools/export-vault.js';

let db: Database.Database;
let vaultDir: string;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vault-writer-'));
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

/** Loads the freshly-stored memory as a domain Memory object. */
function memOf(id: string) {
  const row = getMemoryById(db, id);
  if (!row) throw new Error(`memory ${id} not found`);
  return rowToMemory(row);
}

describe('memoryToMarkdown', () => {
  it('emits --- fenced YAML frontmatter + body, and round-trips through parseVaultFile', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'The deploy pipeline runs on the ms-01 self-hosted runner.\n\nUse #deploy for context.',
      title: 'Deploy Pipeline',
      tags: ['deploy', 'infra'],
      scope: 'project',
    });
    const memory = memOf(stored.memory.id);

    const md = memoryToMarkdown(memory);

    // Frontmatter fence present.
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('\n---\n');
    // Frontmatter carries id / title / tags.
    expect(md).toContain(`id: ${memory.id}`);
    expect(md).toContain('title: Deploy Pipeline');
    expect(md).toContain('deploy');
    expect(md).toContain('infra');
    // Body present after the fence.
    expect(md).toContain('The deploy pipeline runs on the ms-01 self-hosted runner.');

    // Lossless round-trip: write → parse → assert equivalence.
    const file = path.join(vaultDir, 'roundtrip.md');
    fs.writeFileSync(file, md, 'utf-8');
    const parsed = parseVaultFile(file, 'roundtrip.md', 0);

    expect(parsed.title).toBe(memory.title);
    for (const tag of memory.tags) {
      expect(parsed.tags).toContain(tag);
    }
    expect(parsed.content).toContain(
      'The deploy pipeline runs on the ms-01 self-hosted runner.',
    );
    expect(parsed.frontmatter.id).toBe(memory.id);
  });

  it('includes optional document_type and namespace when present', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'A decision about the architecture.',
      title: 'ADR 1',
      document_type: 'decision',
      scope: 'project',
      namespace: 'signal',
    });
    const memory = memOf(stored.memory.id);

    const md = memoryToMarkdown(memory);
    expect(md).toContain('document_type: decision');
    expect(md).toContain('namespace: signal');
    expect(md).toContain('provenance: manual');
  });

  it('omits empty tags array and absent optional fields, still round-trips', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'A bare fact with no tags.',
      title: 'Bare Fact',
    });
    const memory = memOf(stored.memory.id);

    const md = memoryToMarkdown(memory);
    expect(md).not.toContain('tags:');

    const file = path.join(vaultDir, 'bare.md');
    fs.writeFileSync(file, md, 'utf-8');
    const parsed = parseVaultFile(file, 'bare.md', 0);
    expect(parsed.title).toBe('Bare Fact');
    expect(parsed.content).toContain('A bare fact with no tags.');
  });
});

describe('safeVaultFilename', () => {
  it('strips path separators and .. from an untrusted title and ends with .md', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'malicious title content',
      title: '../../etc/passwd',
    });
    const memory = memOf(stored.memory.id);

    const name = safeVaultFilename(memory);
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('..');
    expect(name).not.toContain(path.sep);
  });

  it('falls back to id when the title has no safe characters', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'symbol-only title',
      title: '///',
    });
    const memory = memOf(stored.memory.id);

    const name = safeVaultFilename(memory);
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toContain('/');
    expect(name.length).toBeGreaterThan(3);
  });

  it('produces distinct filenames for two memories sharing the same title', async () => {
    const a = await handleStore(db, embedder, { content: 'first', title: 'Shared Title' });
    const b = await handleStore(db, embedder, { content: 'second', title: 'Shared Title' });

    const nameA = safeVaultFilename(memOf(a.memory.id));
    const nameB = safeVaultFilename(memOf(b.memory.id));

    expect(nameA).not.toBe(nameB);
    expect(nameA.endsWith('.md')).toBe(true);
    expect(nameB.endsWith('.md')).toBe(true);
  });

  it('is deterministic for the same memory', async () => {
    const stored = await handleStore(db, embedder, { content: 'x', title: 'Stable Name' });
    const memory = memOf(stored.memory.id);
    expect(safeVaultFilename(memory)).toBe(safeVaultFilename(memory));
  });

  it('falls back to the id when the memory has no title', async () => {
    const stored = await handleStore(db, embedder, { content: 'no title at all' });
    const memory = memOf(stored.memory.id);
    expect(memory.title).toBeNull();

    const name = safeVaultFilename(memory);
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toContain('/');
    expect(name.length).toBeGreaterThan(3);
  });
});

describe('exportMemoriesToVault', () => {
  it('writes every currently-valid top-level memory as a parseable .md file', async () => {
    const a = await handleStore(db, embedder, { content: 'alpha content', title: 'Alpha' });
    const b = await handleStore(db, embedder, { content: 'beta content', title: 'Beta' });
    const c = await handleStore(db, embedder, { content: 'gamma content', title: 'Gamma' });

    const result = exportMemoriesToVault(db, { vaultPath: vaultDir });

    expect(result.files_written).toBe(3);
    expect(result.vault_path).toBe(fs.realpathSync(vaultDir));
    expect(result.files).toHaveLength(3);

    for (const rel of result.files) {
      const abs = path.join(result.vault_path, rel);
      expect(fs.existsSync(abs)).toBe(true);
    }

    // Re-parse one written file and confirm it matches its source memory.
    const memA = memOf(a.memory.id);
    const fileA = result.files.find((f) => f.includes(safeVaultFilename(memA)));
    expect(fileA).toBeDefined();
    const parsedA = parseVaultFile(
      path.join(result.vault_path, fileA!),
      fileA!,
      0,
    );
    expect(parsedA.title).toBe('Alpha');
    expect(parsedA.content).toContain('alpha content');

    // Confirm the other two were also stored on disk.
    void b;
    void c;
  });

  it('writes a namespaced memory under <vault>/<namespace>/', async () => {
    await handleStore(db, embedder, {
      content: 'project note',
      title: 'Project Note',
      scope: 'project',
      namespace: 'crawlux',
    });

    const result = exportMemoriesToVault(db, { vaultPath: vaultDir });

    const nsFile = result.files.find((f) => f.startsWith(`crawlux${path.sep}`) || f.startsWith('crawlux/'));
    expect(nsFile).toBeDefined();
    const abs = path.join(result.vault_path, nsFile!);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.existsSync(path.join(result.vault_path, 'crawlux'))).toBe(true);
  });

  it('creates the vault directory if it does not exist', async () => {
    await handleStore(db, embedder, { content: 'x', title: 'X' });
    const fresh = path.join(vaultDir, 'nested', 'newvault');
    expect(fs.existsSync(fresh)).toBe(false);

    const result = exportMemoriesToVault(db, { vaultPath: fresh });
    expect(fs.existsSync(fresh)).toBe(true);
    expect(result.files_written).toBe(1);
  });
});

describe('path safety', () => {
  it('confines a memory titled "../escape" INSIDE the vault directory', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'escape attempt',
      title: '../escape',
    });
    void stored;

    const result = exportMemoriesToVault(db, { vaultPath: vaultDir });
    const realVault = fs.realpathSync(vaultDir);

    expect(result.files_written).toBe(1);
    for (const rel of result.files) {
      const abs = path.resolve(realVault, rel);
      expect(abs.startsWith(realVault + path.sep)).toBe(true);
    }

    // Nothing escaped: the parent of the vault must NOT contain an "escape" file.
    const parent = path.dirname(realVault);
    expect(fs.existsSync(path.join(parent, 'escape.md'))).toBe(false);
  });

  it('confineToVault returns null for a traversal-bearing relPath', () => {
    // A relPath that resolves outside the vault root must be rejected outright —
    // this is the single source of truth for write confinement.
    const realVault = fs.realpathSync(vaultDir);
    expect(confineToVault(realVault, '../escape.md')).toBeNull();
    expect(confineToVault(realVault, '../../etc/passwd')).toBeNull();
  });

  it('confineToVault accepts a relPath that stays inside the vault', () => {
    const realVault = fs.realpathSync(vaultDir);
    const inside = confineToVault(realVault, 'sub/note.md');
    expect(inside).toBe(path.join(realVault, 'sub', 'note.md'));
    // The vault root itself is allowed.
    expect(confineToVault(realVault, '.')).toBe(realVault);
  });
});

describe('bi-temporal & scope/namespace filters', () => {
  it('does NOT export an invalidated (valid_to set) memory', async () => {
    const live = await handleStore(db, embedder, { content: 'live fact', title: 'Live' });
    const dead = await handleStore(db, embedder, { content: 'retired fact', title: 'Dead' });
    invalidateMemory(db, dead.memory.id);

    const result = exportMemoriesToVault(db, { vaultPath: vaultDir });

    expect(result.files_written).toBe(1);
    const memLive = memOf(live.memory.id);
    expect(result.files.some((f) => f.includes(safeVaultFilename(memLive)))).toBe(true);
  });

  it('respects the namespace filter', async () => {
    await handleStore(db, embedder, {
      content: 'a',
      title: 'Crawlux Doc',
      scope: 'project',
      namespace: 'crawlux',
    });
    await handleStore(db, embedder, {
      content: 'b',
      title: 'Signal Doc',
      scope: 'project',
      namespace: 'signal',
    });

    const result = exportMemoriesToVault(db, {
      vaultPath: vaultDir,
      namespace: 'crawlux',
    });

    expect(result.files_written).toBe(1);
    expect(result.files[0]).toContain('crawlux');
  });

  it('respects the scope filter', async () => {
    await handleStore(db, embedder, { content: 'g', title: 'Global Doc', scope: 'global' });
    await handleStore(db, embedder, {
      content: 'p',
      title: 'Project Doc',
      scope: 'project',
      namespace: 'proj',
    });

    const result = exportMemoriesToVault(db, { vaultPath: vaultDir, scope: 'global' });

    expect(result.files_written).toBe(1);
    const file = result.files[0];
    const parsed = parseVaultFile(path.join(result.vault_path, file), file, 0);
    expect(parsed.title).toBe('Global Doc');
  });
});

describe('handleExportVault tool', () => {
  it('exports via the tool handler with scope/namespace passthrough', async () => {
    await handleStore(db, embedder, {
      content: 'tool-exported note',
      title: 'Tool Note',
      scope: 'project',
      namespace: 'tools',
    });
    await handleStore(db, embedder, { content: 'unrelated', title: 'Other', scope: 'global' });

    const result = handleExportVault(db, {
      vault_path: vaultDir,
      scope: 'project',
      namespace: 'tools',
    });

    expect(result.files_written).toBe(1);
    expect(result.files[0]).toContain('tools');
    const abs = path.join(result.vault_path, result.files[0]);
    expect(fs.existsSync(abs)).toBe(true);
  });

  it('exports everything when no filters are given', async () => {
    await handleStore(db, embedder, { content: 'a', title: 'A' });
    await handleStore(db, embedder, { content: 'b', title: 'B' });

    const result = handleExportVault(db, { vault_path: vaultDir });
    expect(result.files_written).toBe(2);
  });
});

describe('frontmatter float-score rounding (B3)', () => {
  /** Seed one memory whose stored importance carries an IEEE-754 artifact. */
  async function seedArtifactMemory(): Promise<string> {
    const stored = await handleStore(db, embedder, {
      content: 'Importance decay produced a float artifact on this memory.',
      title: 'Artifact',
      scope: 'global',
    });
    // Multiplicative decay/boost noise: 0.8 * 1.05 → 0.8400000000000001 — the
    // exact class of value that leaked verbatim into frontmatter.
    const artifact = 0.8 * 1.05;
    expect(String(artifact)).toBe('0.8400000000000001'); // premise sanity
    db.prepare('UPDATE memories SET importance_score = ? WHERE id = ?').run(
      artifact,
      stored.memory.id,
    );
    return stored.memory.id;
  }

  it('export writes importance_score with ≤4 decimals (no 0.8400000000000001 artifact)', async () => {
    await seedArtifactMemory();

    const res = exportMemoriesToVault(db, { vaultPath: vaultDir });
    expect(res.files_written).toBe(1);
    const md = fs.readFileSync(path.join(res.vault_path, res.files[0]), 'utf-8');

    const line = md.split('\n').find((l) => l.startsWith('importance_score:'));
    expect(line).toBeDefined();
    expect(line).not.toContain('0.8400000000000001');
    expect(line).toMatch(/^importance_score: -?\d+(\.\d{1,4})?$/);

    // Round-trip at the parse layer: the rebuild importer reads the rounded
    // value with no semantic change (4dp is far below any scoring threshold).
    expect(parseMemoryFile(md).importance_score).toBe(0.84);
  });

  it('rebuild indexes the rounded score back without semantic change', async () => {
    const id = await seedArtifactMemory();

    const res = exportMemoriesToVault(db, { vaultPath: vaultDir });
    expect(res.files_written).toBe(1);

    const fresh = createTestDb();
    const result = await rebuildFromVault(fresh, embedder, res.vault_path);
    expect(result.memories).toBe(1);
    const row = fresh
      .prepare('SELECT importance_score AS s FROM memories WHERE id = ?')
      .get(id) as { s: number };
    expect(row.s).toBe(0.84);
    fresh.close();
  });
});
