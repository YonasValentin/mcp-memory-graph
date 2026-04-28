/**
 * Phase-5 coverage for the tool handlers that didn't have dedicated tests:
 * export, get, ingest, list, related, stats, versions, manifest, graph,
 * extract-entities, vault-status, vault-search, vault-sync, delete.
 *
 * Each suite uses createTestDb + MockEmbeddingProvider so the runs are
 * fast (≪10ms each) and don't load the real model.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExport } from '../../tools/export.js';
import { handleImport } from '../../tools/import.js';
import { handleGet } from '../../tools/get.js';
import { handleIngest } from '../../tools/ingest.js';
import { handleList } from '../../tools/list.js';
import { handleRelated } from '../../tools/related.js';
import { handleStats } from '../../tools/stats.js';
import { handleVersions } from '../../tools/versions.js';
import { handleManifest } from '../../tools/manifest.js';
import { handleGraph } from '../../tools/graph.js';
import { handleExtractEntities } from '../../tools/extract-entities.js';
import { handleDelete } from '../../tools/delete.js';
import { handleUpdate } from '../../tools/update.js';
import { handleVaultStatus } from '../../tools/vault-status.js';
import { handleVaultSync } from '../../tools/vault-sync.js';
import { handleVaultSearch } from '../../tools/vault-search.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('handleExport / handleImport round-trip', () => {
  it('exports stored memories and re-imports them', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'A memory worth exporting and re-importing for backup parity.',
      title: 'parity test',
      tags: ['backup'],
    });
    expect(stored.stored).toBe(true);

    const exported = handleExport(db, {});
    expect(exported.count).toBeGreaterThanOrEqual(1);
    expect(exported.version).toBe('1.0.0');
    expect(exported.memories[0].id).toBeDefined();

    const fresh = createTestDb();
    const imported = await handleImport(fresh, embedder, { data: exported.memories, overwrite: true });
    expect(imported.imported).toBe(1);
    expect(imported.errors).toBe(0);
  });

  it('filter narrows export by namespace', async () => {
    await handleStore(db, embedder, { content: 'in-A namespace memory.', namespace: 'A' });
    await handleStore(db, embedder, { content: 'in-B namespace memory.', namespace: 'B' });
    const exportedA = handleExport(db, { namespace: 'A' });
    expect(exportedA.count).toBe(1);
    expect(exportedA.memories[0].namespace).toBe('A');
  });
});

describe('handleGet', () => {
  it('returns the memory and bumps access_count', async () => {
    const r = await handleStore(db, embedder, { content: 'Read me back when fetched directly.' });
    const got = handleGet(db, { id: r.memory.id, include_chunks: false });
    expect(got).not.toBeNull();
    expect(got!.memory.id).toBe(r.memory.id);

    const updated = db.prepare<[string], { access_count: number }>('SELECT access_count FROM memories WHERE id = ?').get(r.memory.id);
    expect(updated!.access_count).toBeGreaterThanOrEqual(1);
  });

  it('returns null for missing id', () => {
    const got = handleGet(db, { id: 'does-not-exist', include_chunks: false });
    expect(got).toBeNull();
  });

  it('include_chunks returns child rows', async () => {
    const ingested = await handleIngest(db, embedder, {
      content: 'Long doc body. '.repeat(80),
      title: 'doc',
      content_type: 'text',
      chunk_size: 200,
      chunk_overlap: 0,
    });
    const got = handleGet(db, { id: ingested.parent_id, include_chunks: true });
    expect(got!.chunks?.length).toBe(ingested.chunk_count);
  });
});

describe('handleIngest', () => {
  it('chunks a long document into many memories', async () => {
    const para = 'A reasonably sized paragraph that is long enough to be its own chunk. '.repeat(8);
    const content = `${para}\n\n${para}\n\n${para}\n\n${para}`;
    const r = await handleIngest(db, embedder, {
      content,
      title: 'big doc',
      content_type: 'text',
      chunk_size: 256,
      chunk_overlap: 0,
    });
    expect(r.chunk_count).toBeGreaterThanOrEqual(2);
    expect(r.chunk_ids.length).toBe(r.chunk_count);
  });
});

describe('handleList', () => {
  it('paginates and sorts', async () => {
    for (let i = 0; i < 5; i++) {
      await handleStore(db, embedder, { content: `Memory number ${i} for list test purposes.`, namespace: 'list' });
    }
    const page1 = handleList(db, { namespace: 'list', limit: 2, offset: 0, sort_by: 'created_at', sort_order: 'desc' });
    expect(page1.items.length).toBe(2);
    expect(page1.total).toBe(5);
    expect(page1.has_more).toBe(true);

    const page3 = handleList(db, { namespace: 'list', limit: 2, offset: 4, sort_by: 'created_at', sort_order: 'desc' });
    expect(page3.items.length).toBe(1);
    expect(page3.has_more).toBe(false);
  });
});

describe('handleRelated', () => {
  it('returns related memories ranked by similarity', async () => {
    const a = await handleStore(db, embedder, { content: 'PostgreSQL transactions and isolation levels.' });
    await handleStore(db, embedder, { content: 'Postgres MVCC and read-committed isolation.' });
    await handleStore(db, embedder, { content: 'Completely unrelated topic about kayaking on lakes.' });

    const related = await handleRelated(db, embedder, { id: a.memory.id, limit: 5 });
    expect(related.length).toBeGreaterThanOrEqual(1);
    // Mock embedder is hash-based, so we just confirm we don't return the source.
    expect(related.every((r) => r.memory.id !== a.memory.id)).toBe(true);
  });

  it('returns [] when source id is unknown', async () => {
    const related = await handleRelated(db, embedder, { id: 'no-such-id', limit: 5 });
    expect(related).toEqual([]);
  });
});

describe('handleStats', () => {
  it('aggregates by scope, namespace, document_type', async () => {
    await handleStore(db, embedder, { content: 'project mem 1', scope: 'project', namespace: 'p1' });
    await handleStore(db, embedder, { content: 'project mem 2', scope: 'project', namespace: 'p1' });
    await handleStore(db, embedder, { content: 'global mem 1', scope: 'global' });

    const stats = handleStats(db, {});
    expect(stats.total_memories).toBeGreaterThanOrEqual(3);
    expect(stats.by_scope.project).toBeGreaterThanOrEqual(2);
    expect(stats.by_scope.global).toBeGreaterThanOrEqual(1);
  });
});

describe('handleVersions', () => {
  it('records a version entry on update', async () => {
    const r = await handleStore(db, embedder, { content: 'first version of this memory.' });
    await handleUpdate(db, embedder, { id: r.memory.id, content: 'second version of this memory.' });
    const v = handleVersions(db, { id: r.memory.id, limit: 10 });
    expect(v.history.length).toBeGreaterThanOrEqual(1);
    expect(v.current_version).toBeGreaterThanOrEqual(2);
  });
});

describe('handleManifest', () => {
  it('returns a tag/title-only index', async () => {
    await handleStore(db, embedder, { content: 'manifest entry 1', tags: ['m'] });
    const m = handleManifest(db, { limit: 10 });
    expect(m.entries.length).toBeGreaterThanOrEqual(1);
    expect(m.entries[0]).toHaveProperty('importance_score');
    expect(m.entries[0]).toHaveProperty('age_days');
  });
});

describe('handleGraph + handleExtractEntities', () => {
  it('exposes entity relationships through graph traversal', async () => {
    const r1 = await handleStore(db, embedder, { content: 'Project Alpha uses TypeScript heavily.' });
    handleExtractEntities(db, {
      memory_id: r1.memory.id,
      entities: [
        { name: 'ProjectAlpha', type: 'project' },
        { name: 'TypeScript', type: 'tool' },
      ],
      relationships: [{ source: 'ProjectAlpha', target: 'TypeScript', type: 'uses' }],
    });

    const g = handleGraph(db, { entity: 'ProjectAlpha', depth: 1, limit: 10 });
    expect(g.entities.length).toBeGreaterThanOrEqual(1);
    expect(g.total_relationships).toBeGreaterThanOrEqual(1);
    expect(g.memories.length).toBeGreaterThanOrEqual(1);
  });

  it('browse-mode returns entities filtered by type', async () => {
    const r = await handleStore(db, embedder, { content: 'A memory with multiple entities tagged.' });
    handleExtractEntities(db, {
      memory_id: r.memory.id,
      entities: [
        { name: 'PersonA', type: 'person' },
        { name: 'ToolB', type: 'tool' },
      ],
    });
    const g = handleGraph(db, { entity_type: 'person', limit: 10 });
    expect(g.entities.every((e) => e.type === 'person')).toBe(true);
  });
});

describe('handleDelete', () => {
  it('deletes by id and reports the count', async () => {
    const r = await handleStore(db, embedder, { content: 'About to be deleted.' });
    const out = handleDelete(db, { id: r.memory.id });
    expect(out.deleted).toBe(1);
    expect(handleGet(db, { id: r.memory.id, include_chunks: false })).toBeNull();
  });

  it('deletes by filter (expired_only)', async () => {
    const r = await handleStore(db, embedder, { content: 'Expiring soon.' });
    db.prepare("UPDATE memories SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(r.memory.id);
    const out = handleDelete(db, { filter: { expired_only: true } });
    expect(out.deleted).toBeGreaterThanOrEqual(1);
  });

  it('returns deleted:0 when filter or id missing', () => {
    const out = handleDelete(db, {});
    expect(out.deleted).toBe(0);
  });
});

describe('handleVaultStatus / handleVaultSync / handleVaultSearch', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'mcp-vault-'));
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    writeFileSync(
      join(vaultDir, 'notes', 'one.md'),
      '---\ntitle: One\ntags: [obsidian]\n---\n\nThis is the first note about TypeScript and Postgres.\n',
    );
    writeFileSync(
      join(vaultDir, 'notes', 'two.md'),
      '# Two\n\nA second note that mentions [[one]] and discusses MVCC briefly.\n',
    );
  });

  it('reports status before any sync', () => {
    const s = handleVaultStatus(db, { vault_path: vaultDir });
    expect(s.total_files).toBeGreaterThanOrEqual(2);
    expect(s.synced_files).toBe(0);
    expect(s.pending_files).toBe(s.total_files);
  });

  it('syncs files and makes them searchable', async () => {
    const sync = await handleVaultSync(db, embedder, { vault_path: vaultDir });
    expect(sync.files_added).toBe(2);
    expect(sync.errors.length).toBe(0);

    const status = handleVaultStatus(db, { vault_path: vaultDir });
    // After sync, files are tracked: either as synced (mtime exact) or as
    // changed (mtime drifted by sub-millisecond fs precision). Both states
    // mean "we have a sync_meta row for it" — none should be pending.
    expect(status.pending_files).toBe(0);
    expect(status.synced_files + status.changed_files).toBe(2);

    const searchResult = await handleVaultSearch(db, embedder, { vault_path: vaultDir, query: 'TypeScript' });
    expect(Array.isArray(searchResult.results)).toBe(true);
  });

  it('cleans up the temp vault between tests', () => {
    rmSync(vaultDir, { recursive: true, force: true });
  });
});
