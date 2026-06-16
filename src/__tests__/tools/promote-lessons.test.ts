/**
 * promoteLessons — the consolidate "Promote" phase. Selects the highest-signal
 * lesson/incident memories (importance floor OR corroboration) per
 * (scope, namespace) and writes them into that block's always-in-context
 * core_memory digest. dry_run computes counts without writing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { promoteLessons } from '../../tools/promote-lessons.js';
import { handleCoreMemoryGet } from '../../tools/core-memory.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

async function seed(opts: {
  title: string;
  content: string;
  document_type: string;
  scope?: 'project' | 'global';
  namespace?: string;
  importance?: number;
  corroboration?: number;
}) {
  await handleStore(db, embedder, {
    content: opts.content,
    title: opts.title,
    document_type: opts.document_type,
    scope: opts.scope ?? 'project',
    namespace: opts.namespace,
    importance_score: opts.importance,
    metadata: opts.corroboration !== undefined ? { corroboration_count: opts.corroboration } : undefined,
  });
}

const ALL = { filterClause: '', filterParams: [] as unknown[], importanceFloor: 0.5, maxEntries: 7 };

describe('promoteLessons', () => {
  it('promotes high-importance lessons into the core_memory block for their namespace', async () => {
    await seed({ title: 'incident: orders API 500s — pool exhausted', content: '## Symptom\norders down', document_type: 'incident', namespace: 'edc', importance: 0.9 });
    await seed({ title: 'lesson: add a circuit breaker before third-party calls', content: '## What\ncircuit breaker', document_type: 'lesson', namespace: 'edc', importance: 0.8 });

    const { promoted } = promoteLessons(db, ALL);
    expect(promoted).toBe(2);

    const block = handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' });
    expect(block.content).toContain('incident: orders API 500s — pool exhausted');
    expect(block.content).toContain('lesson: add a circuit breaker before third-party calls');
  });

  it('excludes lessons below the importance floor', async () => {
    await seed({ title: 'lesson: trivial low-signal note', content: '## What\nmeh', document_type: 'lesson', namespace: 'edc', importance: 0.1 });
    const { promoted } = promoteLessons(db, ALL);
    expect(promoted).toBe(0);
    const block = handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' });
    expect(block.content).toBe('');
  });

  it('includes a corroborated lesson even below the importance floor', async () => {
    await seed({ title: 'lesson: repeatedly seen flaky deploy', content: '## What\nflaky', document_type: 'lesson', namespace: 'edc', importance: 0.2, corroboration: 3 });
    const { promoted } = promoteLessons(db, { ...ALL, minCorroboration: 2 });
    expect(promoted).toBe(1);
    expect(handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' }).content).toContain('repeatedly seen flaky deploy');
  });

  it('caps the digest at maxEntries (highest importance first)', async () => {
    for (let i = 0; i < 6; i++) {
      await seed({ title: `incident: distinct outage number ${i}`, content: `## Symptom\noutage ${i}`, document_type: 'incident', namespace: 'edc', importance: 0.6 + i * 0.05 });
    }
    const { promoted } = promoteLessons(db, { ...ALL, maxEntries: 3 });
    expect(promoted).toBe(3);
    const block = handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' });
    // top importance ones (4 and 5) kept, lowest (0) dropped
    expect(block.content).toContain('distinct outage number 5');
    expect(block.content).not.toContain('distinct outage number 0');
  });

  it('ignores non-lesson document types', async () => {
    await seed({ title: 'a plain decision', content: 'some decision', document_type: 'decision', namespace: 'edc', importance: 0.9 });
    expect(promoteLessons(db, ALL).promoted).toBe(0);
  });

  it('writes a separate digest per namespace', async () => {
    await seed({ title: 'incident: edc outage', content: '## Symptom\nedc', document_type: 'incident', namespace: 'edc', importance: 0.9 });
    await seed({ title: 'incident: core outage', content: '## Symptom\ncore', document_type: 'incident', namespace: 'core', importance: 0.9 });
    promoteLessons(db, ALL);
    expect(handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' }).content).toContain('edc outage');
    expect(handleCoreMemoryGet(db, { scope: 'project', namespace: 'core' }).content).toContain('core outage');
  });

  it('dry_run counts without writing', async () => {
    await seed({ title: 'incident: would-be promoted', content: '## Symptom\nx', document_type: 'incident', namespace: 'edc', importance: 0.9 });
    const { promoted } = promoteLessons(db, { ...ALL, dryRun: true });
    expect(promoted).toBe(1);
    expect(handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' }).content).toBe('');
  });
});
