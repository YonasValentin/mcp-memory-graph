/**
 * B2 (MED) — `memory rebuild` loaded the ONNX embedding model BEFORE the vault
 * integrity check: a VaultIntegrityError refusal then escaped runRebuild to
 * main()'s catch → `process.exit(1)` → onnxruntime static destructors →
 * libc++abi 'mutex lock failed' SIGABRT (exit 134) ON TOP of the legitimate
 * error (the v17 exitBySignal class — see db/connection.ts and the P14 script
 * tripwire). Required behaviour:
 *   1. the manifest check runs BEFORE `getEmbedder()` (and before the old
 *      index is unlinked, so a refused rebuild keeps the existing DB), and
 *   2. the refusal path sets `process.exitCode` and RETURNS — it never throws
 *      uncaught past a loaded model.
 *
 * U3 (LOW) — the refusal output must name the README-documented recovery
 * (delete .memory/manifest.json — it is derived state), not just "tampered".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { buildIntegrityManifest } from '../../tools/manifest.js';
import { closeDatabase } from '../../db/connection.js';
import { runRebuild } from '../../cli/rebuild.js';

// cli/rebuild.ts must NOT reach getEmbedder() when the manifest check refuses —
// mock the single construction point (lib/direct-access) so the call is
// observable and no real ONNX model can ever load in this test.
const getEmbedderMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/direct-access.js', () => ({
  getEmbedder: getEmbedderMock,
}));

let tmp: string;
let vault: string;
let dbPath: string;
let savedExitCode: typeof process.exitCode;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-refusal-'));
  vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
  dbPath = path.join(tmp, 'memory.db');
  process.env.MCP_MEMORY_DB_PATH = dbPath;
  process.env.MCP_VAULT_PATH = vault; // write-through target for seeding
  savedExitCode = process.exitCode;
  getEmbedderMock.mockReset();
  getEmbedderMock.mockResolvedValue(embedder);
});

afterEach(() => {
  closeDatabase(); // the red path can leave the CLI singleton open
  process.exitCode = savedExitCode;
  delete process.env.MCP_MEMORY_DB_PATH;
  delete process.env.MCP_VAULT_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seed one memory into the vault (via write-through) + a signed manifest. */
async function seedVault(opts: { tamper: boolean }): Promise<void> {
  const seedDb = createTestDb();
  await handleStore(seedDb, embedder, {
    content: 'PostgreSQL pooling reduces handshake overhead for bursty traffic.',
    title: 'Pooling',
    scope: 'global',
  });
  const manifest = buildIntegrityManifest(seedDb, '2026-06-11T00:00:00.000Z');
  seedDb.close();

  const sidecar = path.join(vault, '.memory', 'manifest.json');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, JSON.stringify(manifest, null, 2), 'utf-8');

  if (opts.tamper) tamperLiveFile();
}

/** Recursively list live .md files (skips dotdirs — mirrors the rebuild scanner). */
function liveMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) out.push(...liveMarkdownFiles(abs));
    else if (name.endsWith('.md')) out.push(abs);
  }
  return out;
}

/** Append to one live .md so the on-disk merkle root mismatches the manifest. */
function tamperLiveFile(): void {
  const live = liveMarkdownFiles(vault)[0];
  if (!live) throw new Error('seed produced no vault .md file');
  fs.appendFileSync(live, '\nTAMPERED LINE\n', 'utf-8');
}

/** Capture console.error + console.log for the duration of `fn`. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await fn();
    return [...err.mock.calls, ...log.mock.calls].map((c) => c.join(' ')).join('\n');
  } finally {
    err.mockRestore();
    log.mockRestore();
  }
}

describe('memory rebuild — integrity refusal ordering (B2)', () => {
  it('refuses a tampered vault BEFORE loading the embedder, via exitCode — and keeps the existing index', async () => {
    await seedVault({ tamper: true });
    // Pre-existing index: a refused rebuild must not have destroyed it.
    fs.writeFileSync(dbPath, 'SENTINEL-INDEX — must survive a refused rebuild', 'utf-8');

    const out = await captureOutput(async () => {
      // Refusal must RESOLVE (exitCode + return), never reject: an uncaught
      // throw reaches main()'s catch → process.exit(1) → ONNX SIGABRT.
      await expect(runRebuild(['--vault', vault])).resolves.toBeUndefined();
    });

    expect(getEmbedderMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/Refusing to rebuild/);
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe(
      'SENTINEL-INDEX — must survive a refused rebuild',
    );
  });

  it('U3: the refusal output names the documented recovery (delete .memory/manifest.json)', async () => {
    await seedVault({ tamper: true });

    const out = await captureOutput(async () => {
      await expect(runRebuild(['--vault', vault])).resolves.toBeUndefined();
    });

    expect(out).toContain('delete .memory/manifest.json');
    expect(out).toContain('the manifest is derived state');
  });

  it('an integrity failure surfacing AFTER the model loaded still refuses via exitCode, not a throw (TOCTOU window)', async () => {
    await seedVault({ tamper: false });
    // The vault is clean at the pre-embedder check; tamper it from INSIDE the
    // embedder load — exactly the check→rebuild race window.
    getEmbedderMock.mockImplementation(async () => {
      tamperLiveFile();
      return embedder;
    });

    const out = await captureOutput(async () => {
      await expect(runRebuild(['--vault', vault])).resolves.toBeUndefined();
    });

    expect(getEmbedderMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/Refusing to rebuild/);
  });

  it('happy path unchanged: a matching manifest loads the embedder and rebuilds', async () => {
    await seedVault({ tamper: false });

    const out = await captureOutput(async () => {
      await runRebuild(['--vault', vault]);
    });

    expect(getEmbedderMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(1);
    expect(out).toMatch(/Rebuilt: 1 memories/);
  });
});
