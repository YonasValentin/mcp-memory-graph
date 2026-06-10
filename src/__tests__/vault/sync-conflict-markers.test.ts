/**
 * E2E-found (2-dev vault sim): rebuildFromVault quarantines a marker-bearing .md
 * (battle-v15 GT-4), but syncVault had NO such guard — a sloppily-committed git
 * 3-way merge became searchable memory containing `<<<<<<< HEAD`. syncVault now
 * applies the SAME hasGitConflictMarkers check per file: a conflicted file is
 * skipped with a structured warn and counted (`conflicted`), BEFORE the
 * delete-old step so a conflicted update never tears down the previously-synced
 * memory. Quarantine is non-destructive — the .md stays on disk for the user to
 * resolve, and the next sync picks it up once the markers are gone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { syncVault } from '../../vault/sync.js';

const embedder = new MockEmbeddingProvider();

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function mkVault(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-confl-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf-8');
  }
  return dir;
}

const CONFLICT_BODY = [
  '<<<<<<< HEAD',
  'The retry budget is 5 attempts.',
  '=======',
  'The retry budget is 2 attempts.',
  '>>>>>>> devb/main',
].join('\n');

describe('syncVault quarantines a conflicted .md (GT-4 parity with rebuild)', () => {
  it('skips + counts a marker-bearing file instead of indexing it as live memory', async () => {
    tmp = mkVault({
      'clean.md': '---\ntitle: Clean\n---\n\nVector search uses sqlite-vec.\n',
      'conflicted.md': `---\ntitle: Conflicted\n---\n\n${CONFLICT_BODY}\n`,
    });

    const db = createTestDb();
    const res = await syncVault(db, embedder, { vaultPath: tmp });

    expect(res.conflicted).toBe(1);
    expect(res.files_added).toBe(1);

    const rows = db.prepare<[], { content: string }>('SELECT content FROM memories').all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !r.content.includes('<<<<<<<'))).toBe(true);
    // The quarantined file is untouched on disk (non-destructive).
    expect(fs.existsSync(path.join(tmp, 'conflicted.md'))).toBe(true);
  });

  it('a conflicted UPDATE keeps the previously-synced memory intact (guard runs before delete-old)', async () => {
    tmp = mkVault({ 'note.md': '---\ntitle: Note\n---\n\nThe retry budget is 3 attempts.\n' });

    const db = createTestDb();
    const first = await syncVault(db, embedder, { vaultPath: tmp });
    expect(first.files_added).toBe(1);

    // The same file comes back from a sloppily-resolved merge with raw markers.
    fs.writeFileSync(
      path.join(tmp, 'note.md'),
      `---\ntitle: Note\n---\n\n${CONFLICT_BODY}\n`,
      'utf-8',
    );
    const second = await syncVault(db, embedder, { vaultPath: tmp, force: true });

    expect(second.conflicted).toBe(1);
    expect(second.files_updated).toBe(0);
    // The old memory survives — the conflicted file must not tear it down.
    const rows = db
      .prepare<[], { content: string }>("SELECT content FROM memories WHERE title = 'Note'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('The retry budget is 3 attempts.');
  });

  it('does NOT quarantine a decorative banner (battle-v16 bare-separator discriminator preserved)', async () => {
    // Git's real separator line is BARE; a labeled banner is prose, not a conflict.
    tmp = mkVault({
      'banner.md': [
        '---',
        'title: Banner',
        '---',
        '',
        'Deployment reference banner:',
        '<<<<<<<< STAGING',
        'run the smoke suite first',
        '======== PRODUCTION',
        'require two approvals',
        '>>>>>>>> ROLLBACK',
        '',
      ].join('\n'),
    });

    const db = createTestDb();
    const res = await syncVault(db, embedder, { vaultPath: tmp });
    expect(res.conflicted).toBe(0);
    expect(res.files_added).toBe(1);
  });
});
