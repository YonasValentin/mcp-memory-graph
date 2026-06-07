/**
 * battle-v15 GT-4 — a git 3-way merge of the SAME memory's per-file .md (native
 * merge, not the sidecar union driver) writes <<<<<<< / ======= / >>>>>>> markers
 * into the body on a real conflict. rebuildFromVault/parseMemoryFile did ZERO
 * marker detection, so an accidentally-committed conflicted .md was rebuilt with
 * raw markers as its live memory content. The post-merge rebuild hook also
 * deletes the integrity manifest first, disarming that guard. Quarantine a
 * conflicted file (skip + warn + count) instead of indexing markers as content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleSearch } from '../../tools/search.js';
import { rebuildFromVault } from '../../vault/rebuild.js';
import { hasGitConflictMarkers } from '../../vault/memory-file.js';

const embedder = new MockEmbeddingProvider();

describe('hasGitConflictMarkers', () => {
  it('detects a real git conflict (both <<<<<<< and >>>>>>>)', () => {
    const body = '<<<<<<< HEAD\nretry budget is 5\n=======\nretry budget is 2\n>>>>>>> devb/main\n';
    expect(hasGitConflictMarkers(body)).toBe(true);
  });
  it('does NOT flag a setext H1 underline (======= without the <<< / >>>)', () => {
    expect(hasGitConflictMarkers('My Heading\n=======\nbody text')).toBe(false);
  });
  it('does NOT flag ordinary prose containing < and > characters', () => {
    expect(hasGitConflictMarkers('use a <div> and compare a > b carefully')).toBe(false);
  });

  it('rebattle FP: does NOT flag a note DOCUMENTING a conflict inside a code fence', () => {
    const tutorial = [
      'How to resolve a git merge conflict:',
      '',
      '```',
      '<<<<<<< HEAD',
      'const timeout = 30;',
      '=======',
      'const timeout = 60;',
      '>>>>>>> feature/timeout',
      '```',
      '',
      'Pick the right side, then delete the markers.',
    ].join('\n');
    expect(hasGitConflictMarkers(tutorial)).toBe(false);
  });

  it('still detects a diff3-style conflict (||||||| base section)', () => {
    const body = '<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> branch';
    expect(hasGitConflictMarkers(body)).toBe(true);
  });

  it('still detects a CRLF conflict', () => {
    const body = '<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> branch\r\n';
    expect(hasGitConflictMarkers(body)).toBe(true);
  });

  it('does NOT flag a partial fragment missing the >>>>>>> close (already being resolved)', () => {
    expect(hasGitConflictMarkers('<<<<<<< HEAD\nours\n=======\ntheirs')).toBe(false);
  });
});

describe('rebuildFromVault quarantines a conflicted .md (GT-4)', () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-confl-'));
    process.env.MCP_VAULT_PATH = vault;
  });
  afterEach(() => {
    delete process.env.MCP_VAULT_PATH;
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('does not index conflict markers as memory content', async () => {
    const db1 = createTestDb();
    await handleStore(db1, embedder, { content: 'The retry budget is 3 attempts.', title: 'Retry', scope: 'global' });
    await handleStore(db1, embedder, { content: 'Vector search uses sqlite-vec.', title: 'Vectors', scope: 'global' });
    db1.close();

    // Inject conflict markers into the Retry .md body (simulating a sloppily
    // committed git 3-way merge of the same memory). Find the .md anywhere under
    // the vault (write-through namespaces into a subdir).
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === '.memory' ? [] : walk(p);
        return e.name.endsWith('.md') ? [p] : [];
      });
    let conflicted = '';
    for (const abs of walk(vault)) {
      const raw = fs.readFileSync(abs, 'utf-8');
      if (raw.includes('The retry budget is 3 attempts.')) {
        const merged = raw.replace(
          /The retry budget is 3 attempts\./,
          '<<<<<<< HEAD\nThe retry budget is 5 attempts.\n=======\nThe retry budget is 2 attempts.\n>>>>>>> devb/main',
        );
        fs.writeFileSync(abs, merged, 'utf-8');
        conflicted = abs;
      }
    }
    expect(conflicted).not.toBe('');

    const db2 = createTestDb();
    const result = await rebuildFromVault(db2, embedder, vault);

    // The conflicted file is quarantined: only the clean Vectors memory indexed.
    expect(result.conflicted).toBe(1);
    expect(result.memories).toBe(1);

    // No memory content carries conflict markers.
    const rows = db2.prepare<[], { content: string }>('SELECT content FROM memories').all();
    expect(rows.every((r) => !r.content.includes('<<<<<<<'))).toBe(true);

    // And a search for the conflicted topic does not surface marker garbage.
    const found = await handleSearch(db2, embedder, { query: 'retry budget attempts' });
    const contents = (found.results ?? []).map((r) => r.memory?.content ?? '');
    expect(contents.every((c) => !c.includes('======='))).toBe(true);
    db2.close();
  });
});
