/**
 * E2E-found (2-dev vault sim): quarantine was INVISIBLE — `memory rebuild`
 * printed only "Rebuilt: N memories", so a post-merge rebuild that skipped
 * conflicted notes silently omitted data and nobody knew to resolve the markers.
 * The human summary now surfaces the quarantined count + file list.
 */
import { describe, it, expect, vi } from 'vitest';
import { printRebuildSummary } from '../../cli/rebuild.js';

function capture(fn: () => void): string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    spy.mockRestore();
  }
}

describe('printRebuildSummary', () => {
  it('prints the rebuilt memory count', () => {
    const out = capture(() =>
      printRebuildSummary({ memories: 5, linksRestored: 2, conflicted: 0, conflictedFiles: [] }, '/v'),
    );
    expect(out).toContain('5 memories');
    expect(out).toContain('/v');
  });

  it('stays quiet about quarantine when nothing was quarantined', () => {
    const out = capture(() =>
      printRebuildSummary({ memories: 3, linksRestored: 0, conflicted: 0, conflictedFiles: [] }, '/v'),
    );
    expect(out).not.toMatch(/conflict/i);
  });

  it('surfaces the quarantined count + file list when files were skipped (the E2E gap)', () => {
    const out = capture(() =>
      printRebuildSummary(
        { memories: 3, linksRestored: 0, conflicted: 2, conflictedFiles: ['a.md', 'team/b.md'] },
        '/v',
      ),
    );
    expect(out).toMatch(/conflict/i);
    expect(out).toContain('2');
    expect(out).toContain('a.md');
    expect(out).toContain('team/b.md');
  });
});
