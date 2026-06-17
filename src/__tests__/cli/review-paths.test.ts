import { resolveReviewPaths } from '../../cli/review-paths.js';

describe('resolveReviewPaths', () => {
  const nowIso = '2026-01-01T00:00:00.000Z';

  it('anchors logs + marker in a logs/ dir next to the DB, keyed on the session', () => {
    const p = resolveReviewPaths('/home/u/.mcp-memory/memory.db', 'sess-1', nowIso);
    expect(p.logDir).toBe('/home/u/.mcp-memory/logs');
    expect(p.logFile).toBe('/home/u/.mcp-memory/logs/review-sess-1.log');
    expect(p.markerPath).toBe('/home/u/.mcp-memory/logs/reviewed-sess-1.marker');
  });

  it('falls back to the timestamp and drops the re-run marker when there is no session', () => {
    const p = resolveReviewPaths('/var/data/memory.db', undefined, nowIso);
    expect(p.logDir).toBe('/var/data/logs');
    expect(p.logFile).toBe(`/var/data/logs/review-${nowIso}.log`);
    // no session → unique per run → no dedup marker
    expect(p.markerPath).toBeNull();
  });

  it('tracks the DB directory when the DB is relocated', () => {
    const p = resolveReviewPaths('/custom/dir/db.sqlite', 'abc', nowIso);
    expect(p.logDir).toBe('/custom/dir/logs');
    expect(p.markerPath).toBe('/custom/dir/logs/reviewed-abc.marker');
  });
});
