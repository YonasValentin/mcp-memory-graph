/**
 * Battle-v5 round-2 (CONFIRMED, user decisions): vault_sync delete + duplicate-id
 * semantics.
 *
 *  1. SOFT-TOMBSTONE ON DELETE — removing a .md from the vault and re-syncing
 *     previously HARD-deleted the memory + all its memory_versions via FK cascade
 *     (unrecoverable; a bad git merge silently nuked history). It must instead
 *     soft-tombstone (stamp valid_to): excluded from default recall but
 *     recoverable via memory_restore, row + version history retained.
 *
 *  2. REJECT DUPLICATE-ID FILES — two vault files carrying the SAME frontmatter
 *     id silently forked (reconcile-by-id deleteMemory cascade-wiped the sibling's
 *     sync anchor, which then re-imported under a fresh UUID). The second file
 *     must be recorded in errors[] and skipped — one id, one memory, no fork.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleVaultSync } from '../../tools/vault-sync.js';
import { handleRestore } from '../../tools/condense.js';
import { handleSearch } from '../../tools/search.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
let vault: string;

const topLevelCount = () =>
  db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NULL').get()!.n;
const liveCount = () =>
  db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM memories WHERE parent_id IS NULL AND valid_to IS NULL').get()!.n;
const writeNote = (file: string, fm: Record<string, string>, body: string) => {
  const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(vault, file), `---\n${front}\n---\n\n${body}\n`);
};

beforeEach(() => {
  db = createTestDb();
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vault-deldup-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('vault_sync — deleting a .md soft-tombstones (recoverable), not hard-delete', () => {
  it('a removed vault file leaves a recoverable tombstone, not a hard delete', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    writeNote('keep.md', { id }, 'Redis caches entitlements with a 60 second TTL.');
    const s1 = await handleVaultSync(db, embedder, { vault_path: vault });
    expect(s1.files_added).toBe(1);
    expect(liveCount()).toBe(1);

    // Remove the file and re-sync.
    fs.rmSync(path.join(vault, 'keep.md'));
    const s2 = await handleVaultSync(db, embedder, { vault_path: vault });

    const row = db.prepare<[string], { valid_to: string | null } | undefined>('SELECT valid_to FROM memories WHERE id = ?').get(id);
    expect(row, 'memory row must still exist (soft tombstone, not hard delete)').toBeTruthy();
    expect(row!.valid_to, 'must be tombstoned').not.toBeNull();
    expect(liveCount()).toBe(0); // excluded from the live set

    // Excluded from default recall…
    const hit = (await handleSearch(db, embedder, { query: 'redis ttl entitlements', detail_level: 'full' })).results;
    expect(hit.length).toBe(0);

    // …but recoverable.
    const restored = await handleRestore(db, embedder, { id });
    expect(restored.restored).toBe(true);
    const after = db.prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?').get(id)!;
    expect(after.valid_to).toBeNull();
    expect(liveCount()).toBe(1);
  });
});

describe('vault_sync — two files with the same frontmatter id are rejected (no fork)', () => {
  it('the second file sharing an id is recorded in errors[] and not imported', async () => {
    const id = '22222222-2222-2222-2222-222222222222';
    writeNote('a.md', { id }, 'Original note content about Postgres.');
    writeNote('b.md', { id }, 'A divergent COPY carrying the same id.');

    const s1 = await handleVaultSync(db, embedder, { vault_path: vault });
    // Exactly one memory for the shared id — no fork to a random UUID.
    expect(topLevelCount()).toBe(1);
    expect(s1.files_errored, 'the duplicate-id file must be reported as an error').toBeGreaterThanOrEqual(1);
    expect(s1.errors.some((e) => e.toLowerCase().includes('duplicate') || e.toLowerCase().includes(id))).toBe(true);

    // Re-sync is stable: still one memory, no ping-pong fork.
    await handleVaultSync(db, embedder, { vault_path: vault });
    expect(topLevelCount()).toBe(1);
    const ids = db.prepare<[], { id: string }>('SELECT id FROM memories WHERE parent_id IS NULL').all().map((r) => r.id);
    expect(ids).toEqual([id]);
  });

  it('distinct files with distinct (or absent) ids still all import', async () => {
    writeNote('x.md', { id: '33333333-3333-3333-3333-333333333333' }, 'Note X about Redis.');
    writeNote('y.md', { id: '44444444-4444-4444-4444-444444444444' }, 'Note Y about Docker.');
    const s = await handleVaultSync(db, embedder, { vault_path: vault });
    expect(s.files_added).toBe(2);
    expect(s.files_errored).toBe(0);
    expect(topLevelCount()).toBe(2);
  });
});
