/**
 * battle-v14 G1 — vault_sync must not let a forced tenant plant memory rows in a
 * foreign namespace via per-file frontmatter. The vault-path guard only checks
 * the directory basename; buildMemoryRow honored `namespace:` from frontmatter
 * with no forcing check, so a tenant pinned to 'acme' could sync a .md declaring
 * `namespace: victim` and write a row into the victim namespace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleVaultSync } from '../../tools/vault-sync.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
let dir: string;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  delete process.env.MCP_API_NAMESPACE;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('battle-v14 G1 — vault_sync pins namespace to the forced tenant', () => {
  it('a forced tenant cannot write a row into a foreign namespace via frontmatter', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v14-g1-'));
    const vault = path.join(dir, 'acme');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(
      path.join(vault, 'a.md'),
      '---\nnamespace: victim\nscope: project\ntitle: Note A\n---\nThis is note A.',
    );
    process.env.MCP_API_NAMESPACE = 'acme';
    await handleVaultSync(db, embedder, { vault_path: vault });
    const foreign = db
      .prepare("SELECT COUNT(*) c FROM memories WHERE namespace <> 'acme'")
      .get() as { c: number };
    expect(foreign.c).toBe(0); // every synced row pinned to the forced tenant
  });

  it('unforced: frontmatter namespace is honored (round-trip reconciliation preserved)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v14-g1u-'));
    const vault = path.join(dir, 'myvault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(
      path.join(vault, 'b.md'),
      '---\nnamespace: projA\nscope: project\ntitle: Note B\n---\nThis is note B.',
    );
    await handleVaultSync(db, embedder, { vault_path: vault });
    const ns = db.prepare("SELECT namespace FROM memories WHERE title = 'Note B'").get() as {
      namespace: string;
    };
    expect(ns.namespace).toBe('projA'); // single-user round-trip keeps frontmatter ns
  });
});
