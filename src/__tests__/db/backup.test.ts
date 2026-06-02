import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { backupDatabase } from '../../db/backup.js';

const tmp: string[] = [];
function dest(): string {
  const p = path.join(os.tmpdir(), `backup-${tmp.length}-${Math.floor(process.hrtime()[1])}.db`);
  tmp.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmp.splice(0)) {
    for (const f of [p, `${p}-wal`, `${p}-shm`]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe('backupDatabase produces a restorable copy', () => {
  it('writes a non-empty file whose memories are readable when reopened', async () => {
    const db = createTestDb();
    const { memory } = await handleStore(db, new MockEmbeddingProvider(), {
      content: 'Backups must round-trip the full memory store.',
      title: 'Backup note',
    });

    const out = dest();
    const result = await backupDatabase(db, out);

    expect(result.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(out)).toBe(true);

    // Reopen the backup as an independent database and confirm the row survived.
    const copy = new Database(out, { readonly: true });
    const row = copy.prepare('SELECT id, title FROM memories WHERE id = ?').get(memory.id) as
      | { id: string; title: string }
      | undefined;
    copy.close();
    expect(row?.id).toBe(memory.id);
    expect(row?.title).toBe('Backup note');
  });
});
