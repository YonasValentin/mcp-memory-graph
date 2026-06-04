import type Database from 'better-sqlite3';
import {
  registerWebhookTarget,
  listWebhookTargets,
  deleteWebhookTarget,
  type WebhookTargetRow,
} from '../events/store.js';
import { dispatchPendingWebhooks } from '../events/dispatcher.js';
import { webhooksEnabled } from '../events/emitter.js';

/**
 * `memory_webhook` (M3.1) — manage the active-infrastructure event bus.
 *   - register : add an outbound target (URL is SSRF-validated before persist).
 *   - list     : the registered targets (secrets are NEVER returned).
 *   - delete   : remove a target (its queued deliveries cascade away).
 *   - dispatch : drain the delivery queue now (HMAC-signed POSTs, retried).
 *
 * Gated on MCP_WEBHOOKS so the first outbound egress in this otherwise
 * local-first server is opt-in.
 */

export interface WebhookInput {
  action?: 'register' | 'list' | 'delete' | 'dispatch';
  url?: string;
  secret?: string;
  events?: string;
  scope?: string;
  namespace?: string;
  id?: string;
}

/** Public view of a target — secret replaced by a boolean so it never egresses. */
function safeView(t: WebhookTargetRow): Record<string, unknown> {
  return {
    id: t.id,
    url: t.url,
    has_secret: t.secret != null && t.secret.length > 0,
    events: t.events,
    scope: t.scope,
    namespace: t.namespace,
    active: t.active === 1,
    failure_count: t.failure_count,
    circuit_open_until: t.circuit_open_until,
    created_at: t.created_at,
    last_delivery_at: t.last_delivery_at,
  };
}

export async function handleWebhook(
  db: Database.Database,
  input: WebhookInput,
): Promise<Record<string, unknown>> {
  const action = input.action ?? 'list';

  if (!webhooksEnabled()) {
    return {
      action,
      enabled: false,
      message: 'Webhook bus is disabled. Set MCP_WEBHOOKS=1 to enable outbound events.',
    };
  }

  switch (action) {
    case 'register': {
      if (!input.url) throw new Error('memory_webhook action=register requires a url');
      // registerWebhookTarget runs the SSRF guard and throws on a bad URL.
      const t = registerWebhookTarget(db, {
        url: input.url,
        secret: input.secret,
        events: input.events,
        scope: input.scope,
        namespace: input.namespace,
      });
      return { action, enabled: true, target: safeView(t) };
    }
    case 'delete': {
      if (!input.id) throw new Error('memory_webhook action=delete requires an id');
      return { action, enabled: true, deleted: deleteWebhookTarget(db, input.id) };
    }
    case 'dispatch': {
      const result = await dispatchPendingWebhooks(db);
      return { action, enabled: true, dispatch: result };
    }
    case 'list':
    default:
      return { action: 'list', enabled: true, targets: listWebhookTargets(db).map(safeView) };
  }
}
