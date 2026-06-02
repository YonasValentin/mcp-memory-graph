import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMergeDriverCommand } from '../../cli/share.js';
import { mergeGraphFiles, type GraphArtifact } from '../../graph/graph-export.js';

describe('buildMergeDriverCommand — git merge driver string', () => {
  it('quotes the dist entry path so paths with spaces survive the shell', () => {
    const cmd = buildMergeDriverCommand('/Users/My Name/Projects/mcp/dist/index.js');
    // The path is quoted as a single argument…
    expect(cmd).toContain('"/Users/My Name/Projects/mcp/dist/index.js"');
    // …and the driver still ends with the placeholder contract git expects.
    expect(cmd).toMatch(/merge-graphs %A %B %A$/);
    expect(cmd.startsWith('node ')).toBe(true);
  });

  it('quotes even a space-free path (uniform, predictable output)', () => {
    const cmd = buildMergeDriverCommand('/opt/mcp/dist/index.js');
    expect(cmd).toBe('node "/opt/mcp/dist/index.js" merge-graphs %A %B %A');
  });
});

describe('mergeGraphFiles — preserves exported_at', () => {
  function artifact(exported_at?: string): GraphArtifact & { exported_at?: string } {
    const base: GraphArtifact = { version: 1, memories: [], links: [], entities: [] };
    return exported_at ? { ...base, exported_at } : base;
  }

  it('restamps exported_at to the LATER of the two inputs (most recent state)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-merge-'));
    try {
      const oursPath = join(dir, 'ours.json');
      const theirsPath = join(dir, 'theirs.json');
      const outPath = join(dir, 'out.json');
      writeFileSync(oursPath, JSON.stringify(artifact('2026-01-01T00:00:00.000Z')));
      writeFileSync(theirsPath, JSON.stringify(artifact('2026-05-01T00:00:00.000Z')));

      mergeGraphFiles(oursPath, theirsPath, outPath);
      const out = JSON.parse(readFileSync(outPath, 'utf8')) as { exported_at?: string };
      // The merged artifact is at least as fresh as both inputs → keep the later.
      expect(out.exported_at).toBe('2026-05-01T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the one exported_at present when the other input lacks it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-merge-'));
    try {
      const oursPath = join(dir, 'ours.json');
      const theirsPath = join(dir, 'theirs.json');
      const outPath = join(dir, 'out.json');
      writeFileSync(oursPath, JSON.stringify(artifact())); // no exported_at
      writeFileSync(theirsPath, JSON.stringify(artifact('2026-03-01T00:00:00.000Z')));

      mergeGraphFiles(oursPath, theirsPath, outPath);
      const out = JSON.parse(readFileSync(outPath, 'utf8')) as { exported_at?: string };
      expect(out.exported_at).toBe('2026-03-01T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits exported_at entirely when neither input has it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-merge-'));
    try {
      const oursPath = join(dir, 'ours.json');
      const theirsPath = join(dir, 'theirs.json');
      const outPath = join(dir, 'out.json');
      writeFileSync(oursPath, JSON.stringify(artifact()));
      writeFileSync(theirsPath, JSON.stringify(artifact()));

      mergeGraphFiles(oursPath, theirsPath, outPath);
      const out = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
      expect('exported_at' in out).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
