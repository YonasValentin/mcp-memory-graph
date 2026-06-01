/**
 * P1.4 — the .memory/graph.json sidecar carries resolved memory↔memory links
 * (agent-extracted / typed / co-occurrence) that aren't regenerable from a
 * single file's content. It is written alongside the .md tree and reloaded by
 * `memory rebuild` so those edges survive a DB discard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink, getLinksAmong } from '../../graph/memory-links.js';
import { writeGraphSidecar, loadGraphSidecar, restoreLinksFromSidecar, SIDECAR_REL } from '../../vault/sidecar.js';
import { rebuildFromVault } from '../../vault/rebuild.js';

let vault: string;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  process.env.MCP_VAULT_PATH = vault;
});
afterEach(() => {
  delete process.env.MCP_VAULT_PATH;
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('graph sidecar (P1.4)', () => {
  it('a typed wikilink edge survives a DB discard via the sidecar', async () => {
    const db1 = createTestDb();
    const a = (await handleStore(db1, embedder, { content: 'Note A about auth', title: 'A', scope: 'global' })).memory;
    const b = (await handleStore(db1, embedder, { content: 'Note B about jwt', title: 'B', scope: 'global' })).memory;
    // A typed link that is NOT derivable from content (no [[wikilink]] in body).
    createMemoryLink(db1, { sourceId: a.id, targetId: b.id, relation: 'links_to', confidence: 'EXTRACTED', confidenceScore: 1, sourceKind: 'wikilink' });
    const written = writeGraphSidecar(db1, vault);
    expect(written && fs.existsSync(written)).toBe(true);
    db1.close();

    const db2 = createTestDb();
    const res = await rebuildFromVault(db2, embedder, vault);
    expect(res.linksRestored).toBeGreaterThanOrEqual(1);

    const links = getLinksAmong(db2, [a.id, b.id]);
    expect(
      links.some((l) => l.source_memory_id === a.id && l.target_memory_id === b.id && l.relation === 'links_to'),
    ).toBe(true);
    db2.close();
  });

  it('writeGraphSidecar writes .memory/graph.json and loadGraphSidecar reads it back', () => {
    const db = createTestDb();
    writeGraphSidecar(db, vault);
    expect(fs.existsSync(path.join(vault, SIDECAR_REL))).toBe(true);
    const art = loadGraphSidecar(vault);
    expect(art).not.toBeNull();
    expect(Array.isArray(art!.memories)).toBe(true);
    db.close();
  });

  it('loadGraphSidecar returns null when there is no sidecar', () => {
    expect(loadGraphSidecar(vault)).toBeNull();
  });

  it('restoreLinksFromSidecar skips links whose endpoints are not in the DB', () => {
    const db = createTestDb();
    const restored = restoreLinksFromSidecar(db, {
      version: 1,
      memories: [],
      entities: [],
      links: [
        { source: 'ghost-x', target: 'ghost-y', relation: 'links_to', confidence: 'EXTRACTED', confidence_score: 1, source_kind: 'wikilink', evidence_count: 1, last_seen_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    expect(restored).toBe(0);
    db.close();
  });
});
