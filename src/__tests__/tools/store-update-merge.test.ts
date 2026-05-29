/**
 * Group G3, Finding 3 — the on_conflict='update' merge path must apply the same
 * containment dedup that consolidate's mergeContent uses, so storing content
 * already contained in the existing memory is a no-op append (not a duplicate
 * concatenation that grows content unboundedly).
 *
 * Uses a fixed crafted embedding so the conflict lands deterministically in the
 * superseded band (the mock embedder's near-orthogonal vectors never would).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import { insertMemory, getMemoryById } from '../../db/repository.js';
import type { EmbeddingProvider, MemoryRow } from '../../types.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

function unit(vals: number[]): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < vals.length; i++) v[i] = vals[i];
  let n = 0;
  for (let i = 0; i < 384; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 384; i++) v[i] /= n;
  return v;
}

function baseRow(id: string, content: string): MemoryRow {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id, scope: 'global', namespace: null, title: null, content,
    document_type: null, source: null, author: null, department: null,
    tags: null, access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1, created_at: now,
    updated_at: now, expires_at: null, access_count: 0, last_accessed_at: null,
    importance_score: 0.5, confidence_score: 0.7,
  };
}

function fixedEmbedder(vec: Float32Array): EmbeddingProvider {
  return {
    dimensions: 384,
    modelName: 'fixed',
    async initialize() {},
    isReady() { return true; },
    async embed() { return vec; },
    async embedBatch(texts: string[]) { return texts.map(() => vec); },
  };
}

describe('handleStore — F3: UPDATE merge containment dedup', () => {
  it('does NOT re-append content already contained in the existing memory', async () => {
    const v = unit([1, 0.01, 0]);
    const id = randomUUID();
    // Existing content fully contains the new content as a substring; with the
    // same vector the heuristic lands in the superseded band → on_conflict
    // 'update' decides UPDATE (merge).
    const existing = 'deployment scheduler runs nightly batch jobs reliably every weekday';
    const incoming = 'deployment scheduler runs nightly batch';
    insertMemory(db, baseRow(id, existing), v);

    const embedder = fixedEmbedder(v);
    const result = await handleStore(db, embedder, { content: incoming, on_conflict: 'update' });

    expect(result.operation).toBe('UPDATE');
    expect(result.memory.id).toBe(id);

    // Content unchanged — the incoming text was already contained, so no append.
    const row = getMemoryById(db, id);
    expect(row?.content).toBe(existing);
    expect(row?.content).not.toContain('\n\n');
  });

  it('still concatenates genuinely-new content (no false containment)', async () => {
    const v = unit([1, 0.01, 0]);
    const id = randomUUID();
    const existing = 'deployment scheduler triggers morning batch jobs reliably every weekday';
    const incoming = 'deployment scheduler triggers morning batch jobs at midnight too';
    insertMemory(db, baseRow(id, existing), v);

    const embedder = fixedEmbedder(v);
    const result = await handleStore(db, embedder, { content: incoming, on_conflict: 'update' });

    expect(result.operation).toBe('UPDATE');
    const row = getMemoryById(db, id);
    // Genuinely-new content is appended, separated by the blank line.
    expect(row?.content).toContain(existing);
    expect(row?.content).toContain(incoming);
    expect(row?.content).toContain('\n\n');
  });

  it('lets the fuller incoming content win when it contains the existing', async () => {
    const v = unit([1, 0.01, 0]);
    const id = randomUUID();
    // existing is a strict prefix/substring of incoming → incoming wins outright,
    // no concatenation. Overlap lands in the superseded band.
    const existing = 'deployment scheduler runs nightly batch';
    const incoming = 'deployment scheduler runs nightly batch jobs reliably weekly';
    insertMemory(db, baseRow(id, existing), v);

    const embedder = fixedEmbedder(v);
    const result = await handleStore(db, embedder, { content: incoming, on_conflict: 'update' });

    expect(result.operation).toBe('UPDATE');
    const row = getMemoryById(db, id);
    expect(row?.content).toBe(incoming);
    expect(row?.content).not.toContain('\n\n');
  });
});
