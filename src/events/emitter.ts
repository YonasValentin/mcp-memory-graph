import type Database from 'better-sqlite3';
import { enqueueDelivery, listWebhookTargets, targetWantsEvent } from './store.js';
import { logger } from '../lib/logger.js';
import { forcedNamespace } from '../lib/tenancy.js';
import { currentPrincipal } from '../lib/request-context.js';

/**
 * Event emitter for the active-infrastructure bus (M3.1). Mutation tool handlers
 * call {@link emitMemoryEvent} at the semantic mutation points (created/updated/
 * superseded/deleted/forgotten). It is a no-op unless the bus is enabled AND a
 * subscribing target exists, so the hot write path pays only one cheap SELECT
 * when no webhooks are configured. Enqueue only — the HTTP send is the
 * dispatcher's job (crash-durable queue), so a slow/dead sink never blocks a write.
 */

export const MEMORY_EVENT_TYPES = [
  'memory.created',
  'memory.updated',
  'memory.superseded',
  'memory.deleted',
  'memory.forgotten',
] as const;

export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

/** The metadata published to sinks. Deliberately EXCLUDES both `content` AND
 * `title` — a webhook is an egress path and a title can carry the same secrets/
 * PII the content does (and is only opt-in-redacted). A sink that needs the body
 * fetches it over the authenticated REST API using the id. */
export interface MemoryEventPayload {
  id: string;
  scope?: string | null;
  namespace?: string | null;
  document_type?: string | null;
  access_level?: string | null;
  agent_id?: string | null;
  version?: number | null;
}

/** The bus is OFF unless explicitly enabled — it is the first outbound egress. */
export function webhooksEnabled(): boolean {
  return process.env.MCP_WEBHOOKS === '1' || process.env.MCP_WEBHOOKS === 'true';
}

/**
 * Enqueue an event for every active target that subscribes to it and matches
 * the memory's scope/namespace filter (NULL filter = all). Fail-soft: any error
 * is logged and swallowed so an event-bus problem can never break a memory write.
 * Returns the number of deliveries enqueued (0 when disabled / no match).
 */
export function emitMemoryEvent(
  db: Database.Database,
  eventType: MemoryEventType,
  payload: MemoryEventPayload,
): number {
  if (!webhooksEnabled()) return 0;
  try {
    const targets = listWebhookTargets(db).filter((t) => t.active === 1);
    if (targets.length === 0) return 0;

    const body = JSON.stringify({
      event: eventType,
      memory: payload,
      // Event-emit wall-clock; the delivery row also stamps created_at in SQL.
      timestamp: new Date().toISOString(),
    });

    // battle-v16 re-battle WH-2: on a namespace-pinned deployment a target with
    // namespace=NULL is a dangerous cross-tenant WILDCARD — it would catch EVERY
    // tenant's event metadata (and register-forcing can't retire a wildcard that
    // pre-dates forcing). Under forcing, require an EXACT match to the pinned
    // namespace, dropping wildcards AND foreign targets; this per-process scoping
    // also means no foreign delivery is ever enqueued, so the shared dispatch
    // queue carries nothing cross-tenant (closes the WH-1 dispatch trigger too).
    // Unforced (single-tenant) behaviour is unchanged: NULL = match-all.
    //
    // RBAC §5: under a PRINCIPAL the gate is the EVENT's own partition
    // (payload.namespace), not the key default — forcedNamespace() is
    // namespaces[0] there, which would mis-route a multi-namespace key's write
    // into namespaces[1] (matching [0]'s targets, skipping [1]'s). The payload
    // namespace comes from the already-scoped row, so it is a member of the key
    // set by construction; wildcards stay dropped, and a namespace-less payload
    // matches nothing (fail closed).
    const ctx = currentPrincipal();
    const fns = forcedNamespace();
    let enqueued = 0;
    for (const t of targets) {
      if (!targetWantsEvent(t, eventType)) continue;
      if (t.scope != null && t.scope !== (payload.scope ?? null)) continue;
      if (ctx) {
        if (t.namespace == null || t.namespace !== (payload.namespace ?? null)) continue;
      } else if (fns !== undefined) {
        if (t.namespace !== fns) continue;
      } else if (t.namespace != null && t.namespace !== (payload.namespace ?? null)) {
        continue;
      }
      if (enqueueDelivery(db, t.id, eventType, body) !== null) enqueued += 1;
    }
    return enqueued;
  } catch (err) /* c8 ignore start */ {
    logger.warn({
      event: 'webhook_emit_failed',
      event_type: eventType,
      memory_id: payload.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  /* c8 ignore stop */
}
