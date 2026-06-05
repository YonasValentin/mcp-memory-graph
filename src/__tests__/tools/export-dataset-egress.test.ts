/**
 * battle-v7 M2 — memory_export_dataset must apply an access_level egress ceiling.
 *
 * THE BUG (MEDIUM, security): the dataset export (the LoRA/distillation flywheel)
 * selected high-signal rows with NO access_level filter, so a learning/reflection
 * marked `confidential` or `restricted` was emitted into a training corpus that
 * leaves the trust boundary (distilled into a model, shared). The vault and wiki
 * egress paths already cap access_level; this one didn't.
 *
 * THE FIX: cap egress at `internal` by default (override via
 * MCP_DATASET_MAX_ACCESS_LEVEL), excluding confidential/restricted. Fail-closed
 * (an unknown level is excluded).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleExportDataset } from '../../tools/export-dataset.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(async () => {
  db = createTestDb();
  await handleStore(db, embedder, {
    content: 'Public learning: prefer integer cents for all money math.',
    title: 'cents convention',
    document_type: 'convention',
    importance_score: 0.9,
    access_level: 'public',
  });
  await handleStore(db, embedder, {
    content: 'Internal learning: the staging DB password rotates weekly via the ops runbook.',
    title: 'internal rotation note',
    document_type: 'convention',
    importance_score: 0.9,
    access_level: 'internal',
  });
  await handleStore(db, embedder, {
    content: 'CONFIDENTIAL: the prod master key derivation uses customer-tenant salts as follows...',
    title: 'confidential key derivation',
    document_type: 'decision',
    importance_score: 0.95,
    access_level: 'confidential',
  });
  await handleStore(db, embedder, {
    content: 'RESTRICTED: named individual PII handling exception for legal hold case 4471.',
    title: 'restricted legal note',
    document_type: 'decision',
    importance_score: 0.95,
    access_level: 'restricted',
  });
});
afterEach(() => db.close());

function prompts(r: ReturnType<typeof handleExportDataset>): string[] {
  return (r.samples as Array<{ prompt: string }>).map((s) => s.prompt);
}

describe('handleExportDataset — M2: access_level egress ceiling', () => {
  it('excludes confidential and restricted rows from the training corpus by default', () => {
    const r = handleExportDataset(db, { format: 'pairs' });
    const p = prompts(r);
    expect(p).toContain('cents convention');
    expect(p).toContain('internal rotation note');
    expect(p).not.toContain('confidential key derivation');
    expect(p).not.toContain('restricted legal note');
    expect(r.jsonl).not.toContain('master key derivation');
    expect(r.jsonl).not.toContain('legal hold case 4471');
  });

  it('a tighter cap (public) also excludes internal', () => {
    const prev = process.env.MCP_DATASET_MAX_ACCESS_LEVEL;
    process.env.MCP_DATASET_MAX_ACCESS_LEVEL = 'public';
    try {
      const p = prompts(handleExportDataset(db, {}));
      expect(p).toContain('cents convention');
      expect(p).not.toContain('internal rotation note');
    } finally {
      if (prev === undefined) delete process.env.MCP_DATASET_MAX_ACCESS_LEVEL;
      else process.env.MCP_DATASET_MAX_ACCESS_LEVEL = prev;
    }
  });
});
