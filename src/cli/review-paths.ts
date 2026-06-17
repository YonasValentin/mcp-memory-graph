import { dirname, join } from 'node:path';

export interface ReviewPaths {
  /** Directory holding review logs + per-session markers (next to the DB). */
  logDir: string;
  /** Per-session (or per-run) log file capturing the headless review's output. */
  logFile: string;
  /**
   * Re-run guard marker. Non-null only when a sessionId is known — a
   * timestamp-tagged run is already unique, so it needs no dedup guard.
   */
  markerPath: string | null;
}

/**
 * Pure path computation for the Stop-hook review. The log + the per-session
 * re-run marker live under a `logs/` dir next to the DB, so a silently-failed
 * review is observable and a re-fired Stop doesn't re-review the same session.
 * No filesystem I/O — the caller creates the dir/files.
 *
 * @param dbPath   the resolved SQLite DB path (its directory anchors `logs/`)
 * @param sessionId the Claude Code session id, or undefined
 * @param nowIso   an ISO timestamp used to name the log when there is no session
 *                 (passed in rather than read here to keep this pure/testable)
 */
export function resolveReviewPaths(
  dbPath: string,
  sessionId: string | undefined,
  nowIso: string,
): ReviewPaths {
  const logDir = join(dirname(dbPath), 'logs');
  return {
    logDir,
    logFile: join(logDir, `review-${sessionId ?? nowIso}.log`),
    markerPath: sessionId ? join(logDir, `reviewed-${sessionId}.marker`) : null,
  };
}
