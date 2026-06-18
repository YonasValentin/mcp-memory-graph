/**
 * memory_lesson — ergonomic one-call capture of a structured lesson/incident.
 *
 * The tool fills the matching template scaffold (reusing fillTemplate, the same
 * field list as memory_template) from caller-supplied section values, then
 * delegates persistence to handleStore — so it inherits dedup/NLI/conflict and
 * never duplicates store logic. provenance stays 'manual' (it is a manual
 * capture); the lesson is discoverable via its document_type + tag.
 *
 * Uses createTestDb + MockEmbeddingProvider + handleStore so runs stay fast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleLesson } from '../../tools/lesson.js';
import { getMemoryById } from '../../db/repository.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db?.close();
});

describe('handleLesson', () => {
  it('stores a structured incident note from section fields (operation ADD)', async () => {
    const result = await handleLesson(db, embedder, {
      document_type: 'incident',
      fields: {
        symptom: 'API returns 500 on /orders',
        root_cause: 'connection pool exhausted',
        fix: 'raised pool size to 50',
        prevention: 'alert at 80% pool utilisation',
      },
    });

    expect(result.stored).toBe(true);
    expect(result.operation).toBe('ADD');
    expect(result.document_type).toBe('incident');
    expect(result.template_known).toBe(true);
    expect(result.fields_used).toEqual(['Symptom', 'Root Cause', 'Fix', 'Prevention']);

    const row = getMemoryById(db, result.memory_id);
    expect(row).not.toBeNull();
    expect(row?.document_type).toBe('incident');
    expect(row?.content).toContain('## Symptom\nAPI returns 500 on /orders');
    expect(row?.content).toContain('## Root Cause\nconnection pool exhausted');
    // document_type is added as a tag for discoverability.
    expect(row?.tags).toContain('incident');
  });

  it('defaults document_type to "lesson" when omitted', async () => {
    const result = await handleLesson(db, embedder, {
      fields: { what: 'cache the third-party token', why_it_matters: 'avoids rate limits' },
    });
    expect(result.document_type).toBe('lesson');
    expect(result.template_known).toBe(true);
    const row = getMemoryById(db, result.memory_id);
    expect(row?.document_type).toBe('lesson');
    expect(row?.content).toContain('## What\ncache the third-party token');
  });

  it('NOOPs a duplicate capture instead of double-storing', async () => {
    const input = {
      document_type: 'incident',
      fields: { symptom: 'checkout latency spiked to 9s during the Friday sale' },
    };
    const first = await handleLesson(db, embedder, input);
    const second = await handleLesson(db, embedder, input);
    expect(first.operation).toBe('ADD');
    expect(second.operation).toBe('NOOP');
    expect(second.memory_id).toBe(first.memory_id);
  });

  it('uses the generic scaffold for an unknown document_type', async () => {
    const result = await handleLesson(db, embedder, {
      document_type: 'retro',
      fields: { summary: 'sprint went well, deploys were smooth and predictable' },
    });
    expect(result.template_known).toBe(false);
    expect(result.fields_used).toEqual(['Summary', 'Details', 'Notes']);
    const row = getMemoryById(db, result.memory_id);
    expect(row?.document_type).toBe('retro');
    expect(row?.content).toContain('## Summary\nsprint went well');
  });

  it('uses an explicit title verbatim when provided', async () => {
    const result = await handleLesson(db, embedder, {
      document_type: 'incident',
      title: 'Black Friday checkout outage',
      fields: { symptom: 'checkout unavailable for 12 minutes during the sale' },
    });
    const row = getMemoryById(db, result.memory_id);
    expect(row?.title).toBe('Black Friday checkout outage');
  });

  it('derives a title from document_type alone when no field has a value', async () => {
    const result = await handleLesson(db, embedder, {
      document_type: 'incident',
      fields: {},
    });
    const row = getMemoryById(db, result.memory_id);
    expect(row?.title).toBe('incident');
    // empty fields still produce a structured (placeholder) note
    expect(row?.content).toContain('## Symptom\n_…_');
  });

  it('truncates a long auto-derived title to 80 characters', async () => {
    const long = 'the orders service degraded badly because every query hit an unindexed column and scanned the whole table repeatedly';
    const result = await handleLesson(db, embedder, {
      document_type: 'incident',
      fields: { symptom: long },
    });
    const row = getMemoryById(db, result.memory_id);
    expect(row?.title?.length).toBe(80);
    expect(row?.title?.endsWith('...')).toBe(true);
  });

  it('persists under the requested scope and namespace', async () => {
    const result = await handleLesson(db, embedder, {
      document_type: 'incident',
      scope: 'project',
      namespace: 'acme',
      fields: { symptom: 'nightly job stopped firing after the host upgrade' },
    });
    const row = getMemoryById(db, result.memory_id);
    expect(row?.scope).toBe('project');
    expect(row?.namespace).toBe('acme');
  });
});
