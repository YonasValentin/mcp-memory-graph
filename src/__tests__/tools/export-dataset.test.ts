import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExportDataset } from '../../tools/export-dataset.js';

const embedder = new MockEmbeddingProvider();

describe('M6.3 memory_export_dataset', () => {
  let db: Database.Database;
  beforeEach(async () => {
    db = createTestDb();
    await handleStore(db, embedder, {
      content: 'Use pgBouncer in transaction mode to avoid connection exhaustion under load.',
      title: 'Postgres pooling decision',
      document_type: 'decision',
      scope: 'project',
      importance_score: 0.9,
    });
    await handleStore(db, embedder, {
      content: 'Always validate redirect targets to prevent open redirects.',
      title: 'Open redirect convention',
      document_type: 'convention',
      scope: 'project',
      importance_score: 0.8,
    });
    // A plain note (not a learning category) — must NOT be exported.
    await handleStore(db, embedder, {
      content: 'Random scratch note with no training value here.',
      title: 'scratch',
      document_type: 'note',
      scope: 'project',
    });
  });
  afterEach(() => db.close());

  it('exports only learning-category rows as prompt/completion pairs', () => {
    const r = handleExportDataset(db, { format: 'pairs' });
    expect(r.count).toBe(2);
    const prompts = (r.samples as Array<{ prompt: string; completion: string }>).map((s) => s.prompt);
    expect(prompts).toContain('Postgres pooling decision');
    expect(prompts).not.toContain('scratch');
    expect(r.jsonl.split('\n')).toHaveLength(2);
  });

  it('honors the importance floor', () => {
    const r = handleExportDataset(db, { min_importance: 0.85 });
    expect(r.count).toBe(1); // only the 0.9 decision clears 0.85
  });

  it('emits chatml and alpaca shapes', () => {
    const chat = handleExportDataset(db, { format: 'chatml' });
    const first = chat.samples[0] as { messages: Array<{ role: string; content: string }> };
    expect(first.messages[0].role).toBe('user');
    expect(first.messages[1].role).toBe('assistant');

    const alpaca = handleExportDataset(db, { format: 'alpaca' });
    const a = alpaca.samples[0] as { instruction: string; input: string; output: string };
    expect(a.input).toBe('');
    expect(a.output.length).toBeGreaterThan(0);
  });
});
