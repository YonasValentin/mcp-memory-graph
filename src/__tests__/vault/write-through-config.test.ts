/**
 * P1.2 — write-through resolves the vault from the config file (vault.path +
 * vault.write_through) when the MCP_VAULT_PATH env override is absent. Isolated
 * in its own file so getConfig's singleton cache is fresh.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';

let dir: string;
let vaultDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-'));
  vaultDir = path.join(dir, 'vault');
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ vault: { path: vaultDir, write_through: true } }),
  );
  process.env.MCP_MEMORY_CONFIG_PATH = path.join(dir, 'config.json');
  delete process.env.MCP_VAULT_PATH;
});
afterEach(() => {
  delete process.env.MCP_MEMORY_CONFIG_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('write-through config resolution (P1.2)', () => {
  it('writes the .md to the vault path declared in config.json', async () => {
    const db = createTestDb();
    await handleStore(db, new MockEmbeddingProvider(), {
      content: 'resolved from config',
      title: 'Config vault',
      scope: 'global',
    });
    const files = fs.existsSync(vaultDir)
      ? fs.readdirSync(vaultDir).filter((f) => f.endsWith('.md'))
      : [];
    expect(files).toHaveLength(1);
    db.close();
  });
});
