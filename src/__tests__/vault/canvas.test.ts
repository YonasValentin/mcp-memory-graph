/**
 * Pillar 6 (T17): JSON Canvas 1.0 export — render the memory graph as an
 * Obsidian `.canvas` spatial board. Memories become `text` nodes laid out on a
 * deterministic grid; memory_links become labeled, arrow-tipped edges. Output
 * must validate against the JSON Canvas 1.0 spec: every node has id/type/x/y/
 * width/height; every edge's fromNode/toNode references an existing node id.
 *
 * Uses createTestDb + MockEmbeddingProvider + handleStore + createMemoryLink,
 * and mkdtempSync for a throwaway vault dir (cleaned up after each test).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { invalidateMemory } from '../../db/repository.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { buildCanvas, writeCanvasFile } from '../../vault/canvas.js';
import { handleCanvas } from '../../tools/canvas.js';

let db: Database.Database;
let vaultDir: string;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vault-canvas-'));
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe('buildCanvas — structure', () => {
  it('produces one text node per top-level memory with valid JSON Canvas shape', async () => {
    const a = await handleStore(db, embedder, { content: 'alpha content', title: 'Alpha' });
    const b = await handleStore(db, embedder, { content: 'beta content', title: 'Beta' });
    const c = await handleStore(db, embedder, { content: 'gamma content', title: 'Gamma' });

    const canvas = buildCanvas(db, {});

    expect(canvas.nodes).toHaveLength(3);
    expect(Array.isArray(canvas.edges)).toBe(true);

    const ids = canvas.nodes.map((n) => n.id);
    expect(ids).toContain(a.memory.id);
    expect(ids).toContain(b.memory.id);
    expect(ids).toContain(c.memory.id);

    for (const node of canvas.nodes) {
      expect(typeof node.id).toBe('string');
      expect(node.type).toBe('text');
      expect(typeof node.x).toBe('number');
      expect(typeof node.y).toBe('number');
      expect(typeof node.width).toBe('number');
      expect(typeof node.height).toBe('number');
      expect(Number.isInteger(node.x)).toBe(true);
      expect(Number.isInteger(node.y)).toBe(true);
      // text node carries a markdown `text` field
      expect(typeof node.text).toBe('string');
    }

    // The node text embeds the memory title.
    const alphaNode = canvas.nodes.find((n) => n.id === a.memory.id)!;
    expect(alphaNode.text).toContain('Alpha');
  });

  it('renders an untitled memory with a fallback heading', async () => {
    const stored = await handleStore(db, embedder, { content: 'a bare fact with no title' });
    const canvas = buildCanvas(db, {});
    const node = canvas.nodes.find((n) => n.id === stored.memory.id)!;
    expect(node.text).toContain('Untitled');
  });
});

describe('buildCanvas — deterministic grid layout', () => {
  it('is byte-for-byte deterministic across two runs', async () => {
    for (let i = 0; i < 5; i++) {
      await handleStore(db, embedder, { content: `content ${i}`, title: `Note ${i}` });
    }

    const first = buildCanvas(db, {});
    const second = buildCanvas(db, {});

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('places nodes on a cols=ceil(sqrt(n)) grid', async () => {
    // 5 memories → cols = ceil(sqrt(5)) = 3.
    for (let i = 0; i < 5; i++) {
      await handleStore(db, embedder, { content: `c${i}`, title: `N${i}` });
    }
    const canvas = buildCanvas(db, {});
    const n = canvas.nodes.length;
    expect(n).toBe(5);

    const cols = Math.ceil(Math.sqrt(n));
    expect(cols).toBe(3);

    // Distinct columns per row: first three nodes share row 0 with distinct x;
    // node index 3 wraps to row 1, col 0 (x matches node 0's x, y > node 0's y).
    const xs = canvas.nodes.map((node) => node.x);
    const ys = canvas.nodes.map((node) => node.y);

    expect(xs[0]).toBe(xs[3]); // col 0 of row 0 and row 1 align
    expect(ys[3]).toBeGreaterThan(ys[0]); // row 1 is below row 0
    expect(xs[1]).toBeGreaterThan(xs[0]); // col 1 is right of col 0
    expect(ys[0]).toBe(ys[1]); // same row → same y
    expect(ys[0]).toBe(ys[2]);
  });
});

describe('buildCanvas — edges & referential integrity', () => {
  it('emits a labeled edge for a memory_link between two included nodes', async () => {
    const a = await handleStore(db, embedder, { content: 'source memory', title: 'Source' });
    const b = await handleStore(db, embedder, { content: 'target memory', title: 'Target' });
    await handleStore(db, embedder, { content: 'unrelated', title: 'Other' });

    createMemoryLink(db, {
      sourceId: a.memory.id,
      targetId: b.memory.id,
      relation: 'depends_on',
      sourceKind: 'typed',
    });

    const canvas = buildCanvas(db, {});

    const edge = canvas.edges.find(
      (e) => e.fromNode === a.memory.id && e.toNode === b.memory.id,
    );
    expect(edge).toBeDefined();
    expect(edge!.label).toBe('depends_on');
    expect(edge!.toEnd).toBe('arrow');
    expect(typeof edge!.id).toBe('string');
  });

  it('every edge endpoint references a real node id (referential integrity)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await handleStore(db, embedder, { content: `c${i}`, title: `N${i}` });
      ids.push(s.memory.id);
    }
    createMemoryLink(db, { sourceId: ids[0], targetId: ids[1], relation: 'links_to' });
    createMemoryLink(db, { sourceId: ids[1], targetId: ids[2], relation: 'links_to' });
    createMemoryLink(db, { sourceId: ids[2], targetId: ids[3], relation: 'links_to' });

    const canvas = buildCanvas(db, {});
    const nodeIds = new Set(canvas.nodes.map((n) => n.id));

    expect(canvas.edges.length).toBeGreaterThanOrEqual(3);
    for (const edge of canvas.edges) {
      expect(nodeIds.has(edge.fromNode)).toBe(true);
      expect(nodeIds.has(edge.toNode)).toBe(true);
    }
  });
});

describe('buildCanvas — bi-temporal, scope/namespace, limit', () => {
  it('excludes an invalidated memory from the nodes', async () => {
    const live = await handleStore(db, embedder, { content: 'live', title: 'Live' });
    const dead = await handleStore(db, embedder, { content: 'dead', title: 'Dead' });
    invalidateMemory(db, dead.memory.id);

    const canvas = buildCanvas(db, {});
    const ids = canvas.nodes.map((n) => n.id);
    expect(ids).toContain(live.memory.id);
    expect(ids).not.toContain(dead.memory.id);
  });

  it('respects the scope filter', async () => {
    const g = await handleStore(db, embedder, { content: 'g', title: 'Global', scope: 'global' });
    await handleStore(db, embedder, {
      content: 'p',
      title: 'Project',
      scope: 'project',
      namespace: 'proj',
    });

    const canvas = buildCanvas(db, { scope: 'global' });
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0].id).toBe(g.memory.id);
  });

  it('respects the namespace filter', async () => {
    const cx = await handleStore(db, embedder, {
      content: 'a',
      title: 'Crawlux',
      scope: 'project',
      namespace: 'crawlux',
    });
    await handleStore(db, embedder, {
      content: 'b',
      title: 'Signal',
      scope: 'project',
      namespace: 'signal',
    });

    const canvas = buildCanvas(db, { namespace: 'crawlux' });
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0].id).toBe(cx.memory.id);
  });

  it('caps node count at the given limit', async () => {
    for (let i = 0; i < 6; i++) {
      await handleStore(db, embedder, { content: `c${i}`, title: `N${i}` });
    }
    const canvas = buildCanvas(db, { limit: 3 });
    expect(canvas.nodes).toHaveLength(3);
  });
});

describe('writeCanvasFile', () => {
  it('writes a .canvas file that JSON.parses back to the canvas', async () => {
    await handleStore(db, embedder, { content: 'alpha', title: 'Alpha' });
    await handleStore(db, embedder, { content: 'beta', title: 'Beta' });
    const canvas = buildCanvas(db, {});

    const written = writeCanvasFile(canvas, vaultDir, 'memory-graph');

    expect(written.endsWith('.canvas')).toBe(true);
    expect(fs.existsSync(written)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(written, 'utf-8'));
    expect(parsed).toEqual(canvas);
  });

  it('confines a malicious name like "../x" inside the vault directory', async () => {
    await handleStore(db, embedder, { content: 'x', title: 'X' });
    const canvas = buildCanvas(db, {});

    const written = writeCanvasFile(canvas, vaultDir, '../x');
    const realVault = fs.realpathSync(vaultDir);

    expect(written.startsWith(realVault + path.sep)).toBe(true);
    expect(written).not.toContain('..');
    expect(written.endsWith('.canvas')).toBe(true);

    // Nothing escaped to the parent dir.
    const parent = path.dirname(realVault);
    expect(fs.existsSync(path.join(parent, 'x.canvas'))).toBe(false);
  });
});

describe('handleCanvas tool', () => {
  it('returns only the canvas when no vault_path is given', async () => {
    await handleStore(db, embedder, { content: 'a', title: 'A' });
    const result = handleCanvas(db, {});
    expect(result.canvas.nodes).toHaveLength(1);
    expect(result.file).toBeUndefined();
  });

  it('writes a file and returns its path when vault_path is given', async () => {
    await handleStore(db, embedder, { content: 'a', title: 'A' });
    const result = handleCanvas(db, { vault_path: vaultDir, name: 'board' });

    expect(result.file).toBeDefined();
    expect(result.file!.endsWith('.canvas')).toBe(true);
    expect(fs.existsSync(result.file!)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(result.file!, 'utf-8'));
    expect(parsed).toEqual(result.canvas);
  });
});
