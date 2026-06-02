/**
 * Pillar 8 (T24): point-in-time history surface — the current bi-temporal
 * timeline (created_at/updated_at/valid_from/valid_to/tx_expired/superseded_at/
 * version) plus the memory_versions edit history. Purely additive READ tool.
 *
 * Uses createTestDb + MockEmbeddingProvider + handleStore + handleUpdate so each
 * update produces a memory_versions row to surface.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';
import { handleHistory } from '../../tools/history.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('handleHistory', () => {
  it('returns the bi-temporal timeline and the version history for an edited memory', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'v1 content',
      title: 'Doc',
    });
    const id = stored.memory.id;

    await handleUpdate(db, embedder, { id, content: 'v2 content' });
    await handleUpdate(db, embedder, { id, content: 'v3 content' });

    const result = handleHistory(db, { id });

    expect(result.exists).toBe(true);
    expect(result.memory_id).toBe(id);
    if (!result.exists) throw new Error('unreachable');

    expect(result.timeline.created_at).toBeTruthy();
    expect(result.timeline.valid_from).toBeTruthy();
    expect(result.timeline.version).toBeGreaterThanOrEqual(3);

    // Two updates → at least two prior versions captured in memory_versions.
    expect(result.versions.length).toBeGreaterThanOrEqual(2);
  });

  it('non-existent id: reports exists:false', () => {
    const result = handleHistory(db, { id: 'nope' });
    expect(result).toEqual({ memory_id: 'nope', exists: false });
  });
});
