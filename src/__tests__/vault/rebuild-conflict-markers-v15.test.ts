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

  // battle-v16 GT-4-FN: this expectation was REVERSED from the v15 rebattle FP
  // fix. A note that quotes a COMPLETE conflict block (the full ordered triple,
  // markers at column 0) is now flagged even inside a code fence — because a real
  // git merge writes those exact markers inside a fence when two devs edit a
  // fenced code block, and skipping fences silently indexed the corruption. The
  // FP cost is bounded: quarantine is non-destructive (the .md stays on disk,
  // surfaced in errors[]), so a documentation note is recoverable; a real
  // unflagged conflict is silent index corruption. A note that DISCUSSES markers
  // without reproducing the full ordered triple at column 0 is still NOT flagged
  // (covered by the prose / setext / partial-fragment cases above and below).
  it('GT-4-FN: a full conflict block inside a fence IS flagged (real git output, recoverable FP)', () => {
    const fencedConflict = [
      'The token timeout is set in this block:',
      '',
      '```ts',
      '<<<<<<< HEAD',
      'export const TIMEOUT = 30;',
      '=======',
      'export const TIMEOUT = 60;',
      '>>>>>>> feature/longer-timeout',
      '```',
    ].join('\n');
    expect(hasGitConflictMarkers(fencedConflict)).toBe(true);
  });

  it('GT-4-FN: a stray/unbalanced fence does NOT mask a later real conflict', () => {
    const body = [
      'Some explanation.',
      '```', // unclosed fence (truncated paste) — must NOT disable detection
      'a snippet line',
      '',
      '<<<<<<< HEAD',
      'real conflict ours',
      '=======',
      'real conflict theirs',
      '>>>>>>> branch',
    ].join('\n');
    expect(hasGitConflictMarkers(body)).toBe(true);
  });

  it('does NOT flag a note that merely MENTIONS markers without the full ordered triple', () => {
    // Discussing conflicts in prose (no column-0 <<<<<<< / ======= / >>>>>>> triple).
    const prose = 'When you see <<<<<<< and >>>>>>> in a file, resolve the conflict.';
    expect(hasGitConflictMarkers(prose)).toBe(false);
  });

  // battle-v16 re-battle GT4-MARKERSIZE: git's conflict-marker-size is configurable.
  it('detects a conflict written with a non-default conflict-marker-size (>7)', () => {
    const sz10 = [
      '<<<<<<<<<< HEAD',
      'retry budget is 5',
      '==========',
      'retry budget is 2',
      '>>>>>>>>>> devb/main',
    ].join('\n');
    expect(hasGitConflictMarkers(sz10)).toBe(true);
  });

  it('detects a nested / re-merged conflict (outer open, sep, inner open, outer close)', () => {
    const nested = [
      '<<<<<<< HEAD',
      'outer ours',
      '=======',
      '<<<<<<< nested',
      'inner',
      '>>>>>>> nested-branch',
      '>>>>>>> outer-branch',
    ].join('\n');
    expect(hasGitConflictMarkers(nested)).toBe(true);
  });

  it('still does NOT flag a 7-char setext underline of a 7+ char heading', () => {
    // No preceding <<<<<<< open, so the ======= (or longer) underline is inert.
    expect(hasGitConflictMarkers('Overview\n========\nbody')).toBe(false);
    expect(hasGitConflictMarkers('Title\n==============\nbody')).toBe(false);
  });

  // battle-v16 re-battle GT4-FP1: a decorative ASCII banner LABELS all three
  // lines; git's real separator is BARE. The bare-separator rule distinguishes
  // them, so the banner is NOT quarantined (no false-positive data loss).
  it('does NOT flag a decorative ASCII banner with labeled separator lines', () => {
    const banner = [
      'Deployment reference banner:',
      '<<<<<<<< STAGING',
      'run the smoke suite first',
      '======== PRODUCTION',
      'require two approvals',
      '>>>>>>>> ROLLBACK',
    ].join('\n');
    expect(hasGitConflictMarkers(banner)).toBe(false);
  });

  it('still flags a real conflict (bare separator) even at non-default marker size', () => {
    const real = '<<<<<<<< HEAD\nours\n========\ntheirs\n>>>>>>>> branch';
    expect(hasGitConflictMarkers(real)).toBe(true);
  });

  // battle-v16 round-4 GT4-CR-FN: a lone-CR (classic Mac) file is one "line" to
  // /\r?\n/, hiding the conflict. Split on all three terminators.
  it('detects a conflict in a lone-CR (\\r) line-ending file', () => {
    const cr = '<<<<<<< HEAD\rmine\r=======\rtheirs\r>>>>>>> branch\r';
    expect(hasGitConflictMarkers(cr)).toBe(true);
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
