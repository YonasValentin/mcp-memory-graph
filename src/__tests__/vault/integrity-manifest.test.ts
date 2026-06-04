/**
 * M2.6 — signed integrity manifest. `buildIntegrityManifest` emits a stable
 * fingerprint of the corpus { schema_version, total, memories_merkle_root,
 * generated_at } where the merkle root is sha256 over the SORTED per-memory
 * content hashes (order-independent, deterministic). generated_at is a
 * PARAMETER — the builder never reads the system clock.
 *
 * `rebuildFromVault` gains an integrity guard: if a `.memory/manifest.json`
 * sidecar exists and its merkle_root mismatches the freshly-computed one, the
 * rebuild REFUSES (a tampered git vault is not silently trusted) and reports
 * added / changed / removed / corrupt counts.
 *
 * Coverage:
 *   - merkle root is stable across builds and independent of insertion order
 *   - generated_at is echoed verbatim (no clock read)
 *   - a matching sidecar lets the rebuild proceed
 *   - a tampered file (content changed) makes the rebuild throw a guard error
 *     that carries the changed/corrupt diff counts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import {
  buildIntegrityManifest,
  memoryContentHash,
  merkleRootFromHashes,
  type IntegrityManifest,
} from '../../tools/manifest.js';
import { rebuildFromVault, VaultIntegrityError } from '../../vault/rebuild.js';

let vault: string;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
  process.env.MCP_VAULT_PATH = vault;
});
afterEach(() => {
  delete process.env.MCP_VAULT_PATH;
  fs.rmSync(vault, { recursive: true, force: true });
});

const CORPUS = [
  { content: 'PostgreSQL pooling reduces handshake overhead.', title: 'Pooling' },
  { content: 'Vector search uses sqlite-vec for ANN.', title: 'Vectors' },
  { content: 'Files are the source of truth in the Bruno model.', title: 'Bruno' },
];

async function seed(db: ReturnType<typeof createTestDb>): Promise<void> {
  for (const c of CORPUS) {
    await handleStore(db, embedder, { ...c, scope: 'global' });
  }
}

const SIDECAR = path.join('.memory', 'manifest.json');
function writeSidecar(m: IntegrityManifest): void {
  const abs = path.join(vault, SIDECAR);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(m, null, 2), 'utf-8');
}

describe('integrity manifest (M2.6)', () => {
  it('content hash is sha256 hex of the content', () => {
    const h = memoryContentHash('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Known sha256("hello").
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('merkle root is stable across builds and echoes generated_at verbatim', async () => {
    const db = createTestDb();
    await seed(db);
    const at = '2026-06-04T12:00:00.000Z';
    const m1 = buildIntegrityManifest(db, at);
    const m2 = buildIntegrityManifest(db, at);
    expect(m1.total).toBe(CORPUS.length);
    expect(m1.memories_merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(m1.memories_merkle_root).toBe(m2.memories_merkle_root);
    expect(m1.generated_at).toBe(at);
    expect(m1.schema_version).toBe(m2.schema_version);
    db.close();
  });

  it('merkle root is independent of leaf order (sorted fold)', () => {
    // The root folds the SAME set of per-memory leaf hashes in sorted order, so
    // it is order-independent for a fixed corpus. (NB: leaves now bind the memory
    // id — two separate stores of the same content get different random ids and
    // therefore different roots, which is intended: the merkle is identity-aware.)
    const leaves = ['aa11', 'bb22', 'cc33', 'dd44'];
    const rootA = merkleRootFromHashes(leaves);
    const rootB = merkleRootFromHashes([...leaves].reverse());
    expect(rootA).toBe(rootB);
  });

  it('rebuild proceeds when the sidecar merkle root matches the vault', async () => {
    const seedDb = createTestDb();
    await seed(seedDb);
    const manifest = buildIntegrityManifest(seedDb, '2026-06-04T00:00:00.000Z');
    seedDb.close();
    writeSidecar(manifest);

    const fresh = createTestDb();
    const result = await rebuildFromVault(fresh, embedder, vault);
    expect(result.memories).toBe(CORPUS.length);
    fresh.close();
  });

  it('rebuild REFUSES when a vault file has been tampered (merkle mismatch)', async () => {
    const seedDb = createTestDb();
    await seed(seedDb);
    const manifest = buildIntegrityManifest(seedDb, '2026-06-04T00:00:00.000Z');
    seedDb.close();
    writeSidecar(manifest);

    // Tamper: append to one live .md file body so its content hash changes.
    const liveFile = fs
      .readdirSync(vault)
      .find((n) => n.endsWith('.md'));
    expect(liveFile).toBeTruthy();
    fs.appendFileSync(path.join(vault, liveFile as string), '\nTAMPERED LINE\n', 'utf-8');

    const fresh = createTestDb();
    await expect(rebuildFromVault(fresh, embedder, vault)).rejects.toBeInstanceOf(
      VaultIntegrityError,
    );
    fresh.close();
  });

  it('the integrity error carries added/changed/removed/corrupt diff counts', async () => {
    const seedDb = createTestDb();
    await seed(seedDb);
    const manifest = buildIntegrityManifest(seedDb, '2026-06-04T00:00:00.000Z');
    seedDb.close();
    writeSidecar(manifest);

    const liveFile = fs.readdirSync(vault).find((n) => n.endsWith('.md')) as string;
    fs.appendFileSync(path.join(vault, liveFile), '\nTAMPERED\n', 'utf-8');

    const fresh = createTestDb();
    let caught: VaultIntegrityError | null = null;
    try {
      await rebuildFromVault(fresh, embedder, vault);
    } catch (err) {
      caught = err as VaultIntegrityError;
    }
    fresh.close();
    expect(caught).toBeInstanceOf(VaultIntegrityError);
    // A modified file shows up as one changed entry; counts are present.
    expect(caught?.diff.changed).toBeGreaterThanOrEqual(1);
    expect(typeof caught?.diff.added).toBe('number');
    expect(typeof caught?.diff.removed).toBe('number');
    expect(typeof caught?.diff.corrupt).toBe('number');
    expect(caught?.expectedRoot).not.toBe(caught?.actualRoot);
  });
});
