/**
 * M6.1 — content-hash change gate. A git checkout/clone rewrites every file's
 * mtime without changing its bytes; the old mtime-only test then marked every
 * file "changed" and re-embedded the whole vault. Sync must confirm a real
 * content change by sha256 before re-embedding.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleVaultSync } from '../../tools/vault-sync.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
let vault: string;

beforeEach(() => {
  db = createTestDb();
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vault-hash-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('vault_sync content-hash gate (M6.1)', () => {
  it('a mtime bump with identical content is NOT re-embedded (git-checkout case)', async () => {
    const file = path.join(vault, 'note.md');
    fs.writeFileSync(file, 'Postgres pooling reuses connections under load.\n');
    const s1 = await handleVaultSync(db, embedder, { vault_path: vault });
    expect(s1.files_added).toBe(1);

    // Simulate `git checkout`: bump mtime far into the future, SAME bytes.
    const future = new Date(Date.now() + 86_400_000);
    fs.utimesSync(file, future, future);

    const s2 = await handleVaultSync(db, embedder, { vault_path: vault });
    expect(s2.files_updated).toBe(0); // no re-embed
    expect(s2.files_unchanged).toBe(1); // recognized as unchanged by content
    expect(s2.files_added).toBe(0);
  });

  it('a real content edit IS detected as changed', async () => {
    const file = path.join(vault, 'note.md');
    fs.writeFileSync(file, 'Original body.\n');
    await handleVaultSync(db, embedder, { vault_path: vault });

    fs.writeFileSync(file, 'Edited body with new facts.\n');
    const s2 = await handleVaultSync(db, embedder, { vault_path: vault });
    expect(s2.files_updated).toBe(1);
    expect(s2.files_unchanged).toBe(0);
  });

  it('persists content_hash so the unchanged fast path survives across syncs', async () => {
    const file = path.join(vault, 'note.md');
    fs.writeFileSync(file, 'Stable content.\n');
    await handleVaultSync(db, embedder, { vault_path: vault });
    const row = db
      .prepare<[], { content_hash: string | null }>('SELECT content_hash FROM vault_sync_meta LIMIT 1')
      .get();
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
