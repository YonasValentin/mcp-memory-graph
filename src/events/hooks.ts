import type Database from 'better-sqlite3';
import type { MemoryRow } from '../types.js';
import { emitMemoryEvent, type MemoryEventType, type MemoryEventPayload } from './emitter.js';
import { propagateInvalidation } from '../graph/propagate.js';
import { logger } from '../lib/logger.js';

/**
 * Mutation side-effect hooks (M3). Tool handlers call these at their semantic
 * mutation points so BOTH the MCP and REST entry paths fire the same events and
 * change-propagation. Everything here is FAIL-SOFT: an event-bus or propagation
 * error is logged and swallowed, never surfaced into the memory write — active
 * infrastructure must not be able to break the core store.
 */

export function rowToEventPayload(row: MemoryRow): MemoryEventPayload {
  // No title/content — see MemoryEventPayload: titles can carry PII and egress
  // unredacted, so the event ships only non-sensitive routing metadata.
  return {
    id: row.id,
    scope: row.scope,
    namespace: row.namespace ?? null,
    document_type: row.document_type ?? null,
    access_level: row.access_level ?? null,
    agent_id: row.agent_id ?? null,
    version: row.version ?? null,
  };
}

/** Emit a memory event (gated + fail-soft via the emitter). */
export function notify(
  db: Database.Database,
  type: MemoryEventType,
  payload: MemoryEventPayload,
): void {
  emitMemoryEvent(db, type, payload);
}

/**
 * Flag dependents of a changed/retired memory `stale`. Fail-soft. Returns the
 * flagged ids (empty on error or no dependents). Call BEFORE a HARD delete —
 * the FK cascade removes the dependency edges, so propagation must read them
 * while they still exist.
 */
export function propagateSafe(db: Database.Database, id: string): string[] {
  try {
    return propagateInvalidation(db, id).flagged;
  } catch (err) /* c8 ignore start */ {
    logger.warn({
      event: 'propagation_failed',
      memory_id: id,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  /* c8 ignore stop */
}
