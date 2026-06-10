/**
 * F-EXPORT-VAULTPATH — `metadata._vault` is server-internal DERIVED bookkeeping
 * vault_sync stamps into the DB row (`{ vault_path: <ABSOLUTE local path>,
 * links }`, see RESERVED_VAULT_META_KEY). It leaked verbatim through the read /
 * egress surfaces: memory_get and memory_export returned the raw stored
 * metadata, so an absolute per-dev local path landed in shared JSON exports.
 *
 * Fix: strip the `_vault` container (and the legacy flat `vault_path` /
 * `frontmatter` residue) at the EMIT boundary of these read tools. The DB row
 * stays untouched (sync/resolveVaultWikilinks still needs `_vault` in the DB),
 * and user metadata — including the user-plausible `links` key, the battle-v17
 * 3b31d73 contract — survives intact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleGet } from '../../tools/get.js';
import { handleExport } from '../../tools/export.js';

const embedder = new MockEmbeddingProvider();
const ABS_VAULT = '/Users/dev-a/Obsidian/team-vault';
// A DIFFERENT path for the legacy flat residue so assertions can tell the two
// apart: the reserved container must never emit; the legacy flat key is
// AMBIGUOUS with user data in plain usage, so the chokepoint deliberately
// passes it through (the vault boundary — writer/sync — still strips/heals it).
const ABS_LEGACY = '/Users/dev-a/legacy-vault';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db.close();
});

/**
 * Store a memory with USER metadata, then stamp the vault bookkeeping exactly
 * the way vault_sync does (a direct metadata UPDATE on the stored row):
 * `_vault` container + legacy flat `vault_path` residue an older row carries.
 */
async function seedStampedRow(): Promise<string> {
  const res = await handleStore(db, embedder, {
    content: 'The dunning flow retries 3 times before escalation.',
    title: 'Dunning runbook',
    scope: 'global',
    metadata: { links: ['[[Billing]]'], custom: 'keep-me' },
  });
  const id = res.memory.id;
  db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(
    JSON.stringify({
      links: ['[[Billing]]'],
      custom: 'keep-me',
      _vault: { vault_path: ABS_VAULT, links: ['Billing'] },
      vault_path: ABS_LEGACY, // legacy flat residue (pre-container rows)
    }),
    id,
  );
  return id;
}

describe('read tools strip vault bookkeeping at the emit boundary (F-EXPORT-VAULTPATH)', () => {
  it('memory_get returns user metadata intact, with NO _vault and NO absolute path', async () => {
    const id = await seedStampedRow();

    const result = handleGet(db, { id, include_chunks: false });
    expect(result).not.toBeNull();

    // User keys survive — `links` is USER metadata here (3b31d73 contract) —
    // and the legacy flat `vault_path` passes through: in plain usage it is an
    // indistinguishable user key, and hiding it on reads would be the same
    // silent-loss class 3b31d73 fixed (vault flows still strip/heal it).
    expect(result!.memory.metadata).toMatchObject({
      links: ['[[Billing]]'],
      custom: 'keep-me',
      vault_path: ABS_LEGACY,
    });

    // The reserved container never emits.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('_vault');
    expect(serialized).not.toContain(ABS_VAULT);

    // The DB row itself keeps the bookkeeping (sync still needs it).
    const raw = db
      .prepare<[string], { metadata: string }>('SELECT metadata FROM memories WHERE id = ?')
      .get(id);
    expect(raw!.metadata).toContain('_vault');
  });

  it('memory_export emits user metadata intact, with NO _vault and NO absolute path', async () => {
    await seedStampedRow();

    const exported = handleExport(db, {});
    expect(exported.count).toBe(1);
    expect(exported.memories[0].metadata).toMatchObject({
      links: ['[[Billing]]'],
      custom: 'keep-me',
      vault_path: ABS_LEGACY, // ambiguous-with-user-data: passes through
    });

    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain('_vault');
    expect(serialized).not.toContain(ABS_VAULT);
  });

  it('a row whose metadata was ONLY bookkeeping emits null metadata, not {}', async () => {
    const res = await handleStore(db, embedder, {
      content: 'Bookkeeping-only metadata row.',
      title: 'Bare',
      scope: 'global',
    });
    db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(
      JSON.stringify({ _vault: { vault_path: ABS_VAULT, links: [] } }),
      res.memory.id,
    );

    const result = handleGet(db, { id: res.memory.id, include_chunks: false });
    expect(result!.memory.metadata).toBeNull();
    expect(JSON.stringify(result)).not.toContain(ABS_VAULT);
  });

  it('memory_get strips bookkeeping from chunk children too', async () => {
    const parent = await handleStore(db, embedder, {
      content: 'Parent document for chunk test.',
      title: 'Parent',
      scope: 'global',
    });
    const child = await handleStore(db, embedder, {
      content: 'Child chunk content.',
      title: 'Child',
      scope: 'global',
    });
    db.prepare('UPDATE memories SET parent_id = ?, chunk_index = 0, metadata = ? WHERE id = ?').run(
      parent.memory.id,
      JSON.stringify({ _vault: { vault_path: ABS_VAULT, links: [] }, custom: 'keep-me' }),
      child.memory.id,
    );

    const result = handleGet(db, { id: parent.memory.id, include_chunks: true });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('_vault');
    expect(serialized).not.toContain(ABS_VAULT);
    expect(result!.chunks?.[0]?.metadata).toMatchObject({ custom: 'keep-me' });
  });
});

describe('rowToMemory chokepoint covers the OTHER read surfaces too', () => {
  it('memory_list and memory_search emit no bookkeeping (chokepoint, not per-tool)', async () => {
    const id = await seedStampedRow();

    const { handleList } = await import('../../tools/list.js');
    const listed = handleList(db, { limit: 10, offset: 0 });
    const listSerialized = JSON.stringify(listed);
    expect(listSerialized).toContain(id);
    expect(listSerialized).not.toContain('_vault');
    expect(listSerialized).not.toContain(ABS_VAULT);

    const { handleSearch } = await import('../../tools/search.js');
    const found = await handleSearch(db, embedder, {
      query: 'dunning flow retries escalation',
      limit: 5,
      detail_level: 'full',
    });
    const searchSerialized = JSON.stringify(found);
    expect(searchSerialized).not.toContain('_vault');
    expect(searchSerialized).not.toContain(ABS_VAULT);
    // User metadata still flows through the same surfaces.
    expect(searchSerialized).toContain('keep-me');
  });
});

describe('snapshot + raw-metadata surfaces (fix-breaker wave 2)', () => {
  it('memory_versions / memory_history emit no _vault after updating a stamped row', async () => {
    const id = await seedStampedRow();
    const { handleUpdate } = await import('../../tools/update.js');
    await handleUpdate(db, embedder, { id, content: 'Dunning flow now retries 5 times.' });

    const { handleVersions } = await import('../../tools/versions.js');
    const versions = handleVersions(db, { id, limit: 10 });
    const vSerialized = JSON.stringify(versions);
    expect(vSerialized).not.toContain('_vault');
    expect(vSerialized).not.toContain(ABS_VAULT);

    const { handleHistory } = await import('../../tools/history.js');
    const history = handleHistory(db, { id });
    const hSerialized = JSON.stringify(history);
    expect(hSerialized).not.toContain('_vault');
    expect(hSerialized).not.toContain(ABS_VAULT);
  });

  it('a LEGACY snapshot row already carrying _vault is stripped at read time', async () => {
    const id = await seedStampedRow();
    db.prepare(
      `INSERT INTO memory_versions (id, memory_id, content, title, metadata, version, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(`${id}_v0`, id, 'old content', 'old title',
      JSON.stringify({ custom: 'keep-me', _vault: { vault_path: ABS_VAULT, links: [] } }), 0, null);

    const { handleVersions } = await import('../../tools/versions.js');
    const versions = handleVersions(db, { id, limit: 10 });
    const serialized = JSON.stringify(versions);
    expect(serialized).toContain('keep-me');
    expect(serialized).not.toContain('_vault');
    expect(serialized).not.toContain(ABS_VAULT);
  });

  it('memory_session_state resume state carries no _vault from a stamped row', async () => {
    const { handleSessionState } = await import('../../tools/session-state.js');
    await handleSessionState(db, embedder, {
      action: 'save', session_key: 'sess-1', scope: 'global',
      content: 'working on dunning', summary: 'dunning work',
    });
    db.prepare(
      `UPDATE memories SET metadata = json_patch(metadata, ?) WHERE json_extract(metadata, '$.session_key') = ?`,
    ).run(JSON.stringify({ _vault: { vault_path: ABS_VAULT, links: [] } }), 'sess-1');

    const resumed = await handleSessionState(db, embedder, { action: 'resume', session_key: 'sess-1', scope: 'global' });
    const serialized = JSON.stringify(resumed);
    expect(serialized).not.toContain('_vault');
    expect(serialized).not.toContain(ABS_VAULT);
  });
});
