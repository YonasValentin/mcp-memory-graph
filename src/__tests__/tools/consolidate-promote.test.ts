/**
 * Consolidate "Promote" phase wiring — the nightly dream cycle pushes the top
 * lessons/incidents into core_memory. Gated by input.promote_lessons; respects
 * dry_run; reported via report.lessons_promoted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { handleCoreMemoryGet } from '../../tools/core-memory.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

async function seedIncident() {
  await handleStore(db, embedder, {
    content: '## Symptom\norders API down',
    title: 'incident: orders API 500s — pool exhausted',
    document_type: 'incident',
    scope: 'project',
    namespace: 'edc',
    importance_score: 0.9,
  });
}

describe('handleConsolidate promote phase', () => {
  it('promotes lessons into core_memory when promote_lessons is set', async () => {
    await seedIncident();
    const report = await handleConsolidate(db, embedder, { promote_lessons: true });
    expect(report.lessons_promoted).toBe(1);
    expect(handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' }).content).toContain(
      'incident: orders API 500s — pool exhausted',
    );
  });

  it('does not promote by default (opt-in)', async () => {
    await seedIncident();
    const report = await handleConsolidate(db, embedder, {});
    expect(report.lessons_promoted).toBe(0);
    expect(handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' }).content).toBe('');
  });

  it('dry_run reports the count without writing core_memory', async () => {
    await seedIncident();
    const report = await handleConsolidate(db, embedder, { promote_lessons: true, dry_run: true });
    expect(report.lessons_promoted).toBe(1);
    expect(handleCoreMemoryGet(db, { scope: 'project', namespace: 'edc' }).content).toBe('');
  });
});
