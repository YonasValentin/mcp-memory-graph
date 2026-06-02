import fs from 'node:fs';

/**
 * Hot-reload gate (T26 / Pillar 8).
 *
 * The memory DB is a single SQLite file. SQLite already lets our one
 * better-sqlite3 connection see committed writes from other connections, so
 * *query* freshness is automatic. The genuine staleness risk is the
 * per-process DERIVED cache (`graphCache` in src/api/routes.ts), which holds
 * assembled nodes+edges with a TTL and can serve stale graph payloads after an
 * out-of-band rewrite (background writer / git-hook rebuild / `git pull`).
 *
 * This module detects such rewrites by `(mtime_ns, size)` and busts that cache
 * the moment the file changes. It deliberately does NOT reopen the live SQLite
 * connection — that is concurrency-unsafe and unnecessary.
 */

export interface FileSignature {
  mtimeNs: bigint;
  size: number;
}

/**
 * Cheap one-stat probe of a path. Returns `null` if the file does not exist
 * (or is otherwise unstattable). `mtimeNs` is nanosecond-precision so rapid
 * same-size rewrites are still detected.
 */
export function fileSignature(path: string): FileSignature | null {
  try {
    const stat = fs.statSync(path, { bigint: true });
    return { mtimeNs: stat.mtimeNs, size: Number(stat.size) };
  } catch {
    return null;
  }
}

function sameSignature(a: FileSignature | null, b: FileSignature | null): boolean {
  if (a === null || b === null) return a === b; // both-missing is "same"
  return a.mtimeNs === b.mtimeNs && a.size === b.size;
}

/**
 * Tracks a single watched file. The constructor captures the baseline
 * signature; `shouldReload()` returns `true` only when the current signature
 * differs from the last observed one — including present↔missing transitions —
 * and advances the baseline so an immediate repeat call returns `false`. A
 * missing→missing call returns `false`. One `stat` per call.
 */
export class ReloadGate {
  private readonly path: string;
  private last: FileSignature | null;

  constructor(path: string) {
    this.path = path;
    this.last = fileSignature(path);
  }

  shouldReload(): boolean {
    const current = fileSignature(this.path);
    if (sameSignature(this.last, current)) return false;
    this.last = current;
    return true;
  }
}

/**
 * Bust the /api/graph derived cache iff the gate's watched file changed.
 * Extracted so the route wiring is a one-liner and unit-testable in isolation.
 */
export function maybeBustGraphCache(gate: ReloadGate, cache: Map<string, unknown>): void;
export function maybeBustGraphCache<V>(gate: ReloadGate, cache: Map<string, V>): void;
export function maybeBustGraphCache(gate: ReloadGate, cache: Map<string, unknown>): void {
  if (gate.shouldReload()) cache.clear();
}
