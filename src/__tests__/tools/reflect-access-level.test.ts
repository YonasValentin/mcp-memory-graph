/**
 * 2.7.2: a stored reflection must inherit the most-restrictive access_level of
 * its sources, floored at 'internal'. handleStore's direct call (bypassing the
 * Zod tool default) falls back to 'public' (store.ts), which would classify an
 * insight derived from internal/confidential material more openly than its
 * sources — a quiet downgrade, now that the Stop-hook review can auto-reflect.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleReflect } from '../../tools/reflect.js';
import { getMemoryById } from '../../db/repository.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

async function reflectionLevelFrom(levels: string[]): Promise<string | undefined> {
  const ids: string[] = [];
  for (const [i, level] of levels.entries()) {
    const s = await handleStore(db, embedder, {
      content: `source ${i} at ${level} sensitivity about the architecture`,
      access_level: level as 'public' | 'internal' | 'confidential' | 'restricted',
    });
    ids.push(s.memory.id);
  }
  const res = await handleReflect(db, embedder, {
    mode: 'store',
    insight: 'synthesized higher-level insight spanning the sources',
    source_ids: ids,
  } as Parameters<typeof handleReflect>[2]);
  const insightId = (res as { insight_id: string }).insight_id;
  return getMemoryById(db, insightId)?.access_level;
}

describe('handleReflect store — access_level inheritance', () => {
  it('keeps internal when all sources are internal (never the public fallback)', async () => {
    expect(await reflectionLevelFrom(['internal', 'internal'])).toBe('internal');
  });

  it('inherits the most-restrictive source level', async () => {
    expect(await reflectionLevelFrom(['internal', 'confidential', 'public'])).toBe('confidential');
  });

  it('floors at internal even when every source is public', async () => {
    expect(await reflectionLevelFrom(['public', 'public'])).toBe('internal');
  });
});
