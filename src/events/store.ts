import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { assertSafeWebhookUrl } from './ssrf-guard.js';

/**
 * Persistence layer for the webhook event bus (M3.1). Targets + a crash-durable
 * delivery queue live in SQLite (migration v11) so an event fired while a sink
 * is down survives a restart and is retried by the dispatcher.
 */

export interface WebhookTargetRow {
  id: string;
  url: string;
  secret: string | null;
  events: string;
  scope: string | null;
  namespace: string | null;
  active: number;
  failure_count: number;
  circuit_open_until: string | null;
  created_at: string;
  last_delivery_at: string | null;
}

export interface WebhookDeliveryRow {
  id: string;
  target_id: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface RegisterTargetInput {
  url: string;
  secret?: string;
  /** Comma-separated event types, or '*' (default) for all. */
  events?: string;
  scope?: string;
  namespace?: string;
}

/**
 * Register an outbound webhook target. Validates the URL against the SSRF guard
 * (scheme + literal-host policy) BEFORE persisting, so a private/loopback/
 * metadata URL can never enter the queue. Throws {@link SsrfError} on a bad URL.
 */
export function registerWebhookTarget(
  db: Database.Database,
  input: RegisterTargetInput,
): WebhookTargetRow {
  assertSafeWebhookUrl(input.url);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO webhook_targets (id, url, secret, events, scope, namespace)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.url,
    input.secret ?? null,
    input.events && input.events.trim().length > 0 ? input.events.trim() : '*',
    input.scope ?? null,
    input.namespace ?? null,
  );
  return getWebhookTarget(db, id)!;
}

export function getWebhookTarget(db: Database.Database, id: string): WebhookTargetRow | null {
  return (
    db
      .prepare<[string], WebhookTargetRow>('SELECT * FROM webhook_targets WHERE id = ?')
      .get(id) ?? null
  );
}

export function listWebhookTargets(db: Database.Database): WebhookTargetRow[] {
  return db
    .prepare<[], WebhookTargetRow>('SELECT * FROM webhook_targets ORDER BY created_at')
    .all();
}

export function deleteWebhookTarget(db: Database.Database, id: string): boolean {
  // Deliveries cascade via the FK. Use IMMEDIATE so a concurrent dispatcher
  // waits on busy_timeout instead of throwing on the lock upgrade.
  const tx = db.transaction(() => db.prepare('DELETE FROM webhook_targets WHERE id = ?').run(id).changes);
  return tx.immediate() > 0;
}

/** True when a target subscribes to this event type (exact match or '*'). */
export function targetWantsEvent(target: WebhookTargetRow, eventType: string): boolean {
  const spec = target.events.trim();
  if (spec === '*' || spec.length === 0) return true;
  return spec
    .split(',')
    .map((s) => s.trim())
    .some((s) => s === eventType || s === '*');
}

/** Cap on a single delivery payload (bytes). Events carry only metadata, so this
 * is generous; it bounds a pathological title/metadata from bloating the queue. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Enqueue one delivery row (pending, due now). Internal — used by the emitter.
 * `next_attempt_at` is stamped as ISO-8601-Z explicitly (NOT the SQL
 * datetime('now') default) so every row shares ONE timestamp format with the
 * dispatcher's retry writes — a mixed format breaks the ORDER BY fairness in
 * getReadyDeliveries. Oversized payloads are refused (returns null). */
export function enqueueDelivery(
  db: Database.Database,
  targetId: string,
  eventType: string,
  payload: string,
): string | null {
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) return null;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO webhook_deliveries (id, target_id, event_type, payload, next_attempt_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(id, targetId, eventType, payload);
  return id;
}

/**
 * Deliveries that are due for a (re)try: not terminal (delivered/dead), due by
 * `nowIso`, on an ACTIVE target whose circuit breaker is not currently open.
 */
export function getReadyDeliveries(
  db: Database.Database,
  nowIso: string,
  limit = 50,
): Array<WebhookDeliveryRow & { target: WebhookTargetRow }> {
  const rows = db
    .prepare<[string, string, number], WebhookDeliveryRow & {
      t_id: string;
      t_url: string;
      t_secret: string | null;
      t_events: string;
      t_scope: string | null;
      t_namespace: string | null;
      t_active: number;
      t_failure_count: number;
      t_circuit_open_until: string | null;
      t_created_at: string;
      t_last_delivery_at: string | null;
    }>(
      `SELECT d.*,
              t.id AS t_id, t.url AS t_url, t.secret AS t_secret, t.events AS t_events,
              t.scope AS t_scope, t.namespace AS t_namespace, t.active AS t_active,
              t.failure_count AS t_failure_count, t.circuit_open_until AS t_circuit_open_until,
              t.created_at AS t_created_at, t.last_delivery_at AS t_last_delivery_at
         FROM webhook_deliveries d
         JOIN webhook_targets t ON t.id = d.target_id
        WHERE d.status IN ('pending','failed','sending')
          AND d.next_attempt_at <= ?
          AND t.active = 1
          AND (t.circuit_open_until IS NULL OR t.circuit_open_until <= ?)
        ORDER BY d.next_attempt_at
        LIMIT ?`,
    )
    .all(nowIso, nowIso, limit);

  return rows.map((r) => ({
    id: r.id,
    target_id: r.target_id,
    event_type: r.event_type,
    payload: r.payload,
    status: r.status,
    attempts: r.attempts,
    next_attempt_at: r.next_attempt_at,
    last_error: r.last_error,
    created_at: r.created_at,
    delivered_at: r.delivered_at,
    target: {
      id: r.t_id,
      url: r.t_url,
      secret: r.t_secret,
      events: r.t_events,
      scope: r.t_scope,
      namespace: r.t_namespace,
      active: r.t_active,
      failure_count: r.t_failure_count,
      circuit_open_until: r.t_circuit_open_until,
      created_at: r.t_created_at,
      last_delivery_at: r.t_last_delivery_at,
    },
  }));
}

export function countPendingDeliveries(db: Database.Database): number {
  return (
    db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN ('pending','failed')",
      )
      .get()?.n ?? 0
  );
}
