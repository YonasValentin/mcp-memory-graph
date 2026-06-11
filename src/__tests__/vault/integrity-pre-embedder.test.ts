/**
 * B2 — `verifyVaultIntegrity`: the cheap STANDALONE manifest check the rebuild
 * CLI runs BEFORE `getEmbedder()`. It is the same guard rebuildFromVault
 * applies internally (assertVaultIntegrity over the scanned live .md files),
 * exported so the refusal can fire while NO ONNX runtime is loaded — a
 * VaultIntegrityError escaping past a loaded model exits through onnxruntime's
 * static destructors (libc++abi 'mutex lock failed' → SIGABRT 134).
 *
 * U3 — the error message must carry the README-documented recovery (the
 * manifest is derived state; delete it when the change was expected), not just
 * the bare "tampered vault" refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { buildIntegrityManifest, type IntegrityManifest } from '../../tools/manifest.js';
import { verifyVaultIntegrity, VaultIntegrityError } from '../../vault/rebuild.js';

let vault: string;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-pre-'));
  process.env.MCP_VAULT_PATH = vault;
});
afterEach(() => {
  delete process.env.MCP_VAULT_PATH;
  fs.rmSync(vault, { recursive: true, force: true });
});

async function seedVault(): Promise<IntegrityManifest> {
  const seedDb = createTestDb();
  await handleStore(seedDb, embedder, {
    content: 'Vector search uses sqlite-vec for ANN under the hood.',
    title: 'Vectors',
    scope: 'global',
  });
  const manifest = buildIntegrityManifest(seedDb, '2026-06-11T00:00:00.000Z');
  seedDb.close();
  return manifest;
}

function writeSidecar(m: IntegrityManifest): void {
  const abs = path.join(vault, '.memory', 'manifest.json');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(m, null, 2), 'utf-8');
}

describe('verifyVaultIntegrity — standalone pre-embedder check (B2)', () => {
  it('no-ops on an unsigned vault (no manifest sidecar)', async () => {
    await seedVault(); // files only — sidecar never written
    expect(() => verifyVaultIntegrity(vault)).not.toThrow();
  });

  it('passes when the sidecar merkle root matches the on-disk vault', async () => {
    writeSidecar(await seedVault());
    expect(() => verifyVaultIntegrity(vault)).not.toThrow();
  });

  it('throws VaultIntegrityError on a tampered vault — no embedder, no DB involved', async () => {
    writeSidecar(await seedVault());
    // Recursive scan (mirrors the rebuild scanner) so a namespace subdir can
    // never hide the seeded file from the tamper step.
    const live = (function walk(dir: string): string | undefined {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isDirectory()) {
          const hit = walk(abs);
          if (hit) return hit;
        } else if (name.endsWith('.md')) return abs;
      }
      return undefined;
    })(vault);
    if (!live) throw new Error('seed produced no vault .md file');
    fs.appendFileSync(live, '\nTAMPERED\n', 'utf-8');
    expect(() => verifyVaultIntegrity(vault)).toThrow(VaultIntegrityError);
  });
});

describe('VaultIntegrityError refusal message (U3)', () => {
  it('carries the documented recovery: delete .memory/manifest.json — derived state', () => {
    const err = new VaultIntegrityError('aaaa', 'bbbb', {
      added: 0,
      removed: 0,
      changed: 1,
      corrupt: 0,
    });
    expect(err.message).toContain('Refusing to rebuild from a tampered vault');
    expect(err.message).toContain(
      'If this change was expected (e.g. you resolved a merge by hand), delete .memory/manifest.json and re-run rebuild — the manifest is derived state.',
    );
  });
});
