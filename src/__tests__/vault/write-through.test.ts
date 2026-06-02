/**
 * P1.2 — write-through: when a vault is configured, every top-level memory write
 * is mirrored to a per-memory .md file (Bruno: files are the live source of
 * truth). Gated by MCP_VAULT_PATH; a no-op otherwise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';
import { handleDelete } from '../../tools/delete.js';
import { handleForget } from '../../tools/forget.js';
import { parseMemoryFile } from '../../vault/memory-file.js';

let vault: string;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  process.env.MCP_VAULT_PATH = vault;
});
afterEach(() => {
  delete process.env.MCP_VAULT_PATH;
  fs.rmSync(vault, { recursive: true, force: true });
});

function liveFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.memory') continue;
      const abs = path.join(dir, name);
      const r = rel ? path.join(rel, name) : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else if (name.endsWith('.md')) out.push(r);
    }
  };
  walk(vault, '');
  return out;
}
function read(rel: string): string {
  return fs.readFileSync(path.join(vault, rel), 'utf-8');
}

describe('write-through vault mirror (P1.2)', () => {
  it('memory_store writes a parseable per-memory .md file', async () => {
    const { memory } = await handleStore(db(), embedder, {
      content: 'Files are the source of truth.',
      title: 'Bruno model',
      tags: ['bruno', 'git'],
      scope: 'global',
    });
    const files = liveFiles();
    expect(files).toHaveLength(1);
    const parsed = parseMemoryFile(read(files[0]));
    expect(parsed.id).toBe(memory.id);
    expect(parsed.title).toBe('Bruno model');
    expect(parsed.tags).toEqual(['bruno', 'git']);
    expect(parsed.content.trim()).toBe('Files are the source of truth.');
  });

  it('memory_update rewrites the file in place', async () => {
    const d = db();
    const { memory } = await handleStore(d, embedder, { content: 'v1 content', title: 'Doc', scope: 'global' });
    await handleUpdate(d, embedder, { id: memory.id, content: 'v2 content', changed_by: 'test' });
    const files = liveFiles();
    expect(files).toHaveLength(1);
    expect(parseMemoryFile(read(files[0])).content.trim()).toBe('v2 content');
  });

  it('memory_delete removes the live file', async () => {
    const d = db();
    const { memory } = await handleStore(d, embedder, { content: 'to be deleted', title: 'Gone', scope: 'global' });
    expect(liveFiles()).toHaveLength(1);
    handleDelete(d, { id: memory.id });
    expect(liveFiles()).toHaveLength(0);
  });

  it('soft forget moves the file to .memory/deleted/ with a valid_to tombstone', async () => {
    const d = db();
    const { memory } = await handleStore(d, embedder, { content: 'sensitive', title: 'PII', scope: 'global' });
    expect(liveFiles()).toHaveLength(1);
    handleForget(d, { id: memory.id });
    expect(liveFiles()).toHaveLength(0);
    const idSlice = memory.id.replace(/[^a-zA-Z0-9]/g, '');
    const tomb = path.join(vault, '.memory', 'deleted', `${idSlice}.md`);
    expect(fs.existsSync(tomb)).toBe(true);
    expect(parseMemoryFile(fs.readFileSync(tomb, 'utf-8')).valid_to).not.toBeNull();
  });

  it('hard forget removes both the live file and any tombstone', async () => {
    const d = db();
    const { memory } = await handleStore(d, embedder, { content: 'erase me', title: 'Erase', scope: 'global' });
    handleForget(d, { id: memory.id, hard: true });
    expect(liveFiles()).toHaveLength(0);
    const idSlice = memory.id.replace(/[^a-zA-Z0-9]/g, '');
    expect(fs.existsSync(path.join(vault, '.memory', 'deleted', `${idSlice}.md`))).toBe(false);
  });

  it('is fail-soft: an unwritable vault path never breaks the DB write', async () => {
    const filePath = path.join(vault, 'not-a-dir');
    fs.writeFileSync(filePath, 'x'); // a file where a dir is expected
    process.env.MCP_VAULT_PATH = filePath;
    const res = await handleStore(db(), embedder, { content: 'still works', title: 'X', scope: 'global' });
    expect(res.stored).toBe(true);
    process.env.MCP_VAULT_PATH = vault; // restore for cleanup
  });

  it('namespaced memories land under <namespace>/', async () => {
    const { memory } = await handleStore(db(), embedder, {
      content: 'scoped note', title: 'Scoped', scope: 'project', namespace: 'edc',
    });
    const files = liveFiles();
    expect(files).toHaveLength(1);
    expect(files[0].startsWith('edc' + path.sep)).toBe(true);
    expect(parseMemoryFile(read(files[0])).id).toBe(memory.id);
  });
});

// Fresh DB per test.
let _db: ReturnType<typeof createTestDb> | null = null;
function db() {
  _db = createTestDb();
  return _db;
}
afterEach(() => { _db?.close(); _db = null; });
