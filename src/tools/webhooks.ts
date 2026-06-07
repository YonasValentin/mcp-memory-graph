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
  // battle-v16 WH-TENANCY: on a namespace-pinned deployment (MCP_API_NAMESPACE /
  // forcedApiNamespace) the caller may only manage targets in its own tenant.
  // Without this a pinned tenant could (a) register a NULL-namespace target,
  // which the dispatcher treats as a WILDCARD that catches EVERY tenant's event
  // metadata (emitter.ts), or a foreign-tenant target; and (b) list/delete other
  // tenants' targets. When undefined (single-tenant / unforced) behaviour is
  // unchanged.
  forcedNamespace?: string,
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
      // Under forcing the namespace is pinned (caller input cannot widen it to
      // null/all or point at another tenant).
      const t = registerWebhookTarget(db, {
        url: input.url,
        secret: input.secret,
        events: input.events,
        scope: input.scope,
        namespace: forcedNamespace ?? input.namespace,
      });
      return { action, enabled: true, target: safeView(t) };
    }
    case 'delete': {
      if (!input.id) throw new Error('memory_webhook action=delete requires an id');
      // Under forcing, only a target owned by the pinned tenant may be deleted.
      if (forcedNamespace !== undefined) {
        const owned = listWebhookTargets(db).some(
          (t) => t.id === input.id && t.namespace === forcedNamespace,
        );
        if (!owned) return { action, enabled: true, deleted: false };
      }
      return { action, enabled: true, deleted: deleteWebhookTarget(db, input.id) };
    }
    case 'dispatch': {
      const result = await dispatchPendingWebhooks(db);
      return { action, enabled: true, dispatch: result };
    }
    case 'list':
    default: {
      // Under forcing, only the pinned tenant's targets are visible.
      const targets = listWebhookTargets(db).filter(
        (t) => forcedNamespace === undefined || t.namespace === forcedNamespace,
      );
      return { action: 'list', enabled: true, targets: targets.map(safeView) };
    }
  }
}
