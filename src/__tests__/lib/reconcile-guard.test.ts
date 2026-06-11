/**
 * Unit spec for the shared by-id reconcile decision (RBAC write-path durable
 * fix, task #11). The three reconcile sites — import-overwrite, vault_sync
 * (small + large file), consolidate dedup-merge — each pass a different (ns,
 * ceiling) shape; this pins the truth table so a caller can't silently diverge.
 */
import { describe, it, expect } from 'vitest';
import { reconcileBlocked } from '../../lib/reconcile-guard.js';

const row = (namespace: string | null, access_level: string) => ({ namespace, access_level });

describe('reconcileBlocked', () => {
  describe('unconstrained (single-user / legacy: no ns, no ceiling)', () => {
    it('allows reconcile of any row', () => {
      expect(reconcileBlocked(row('anything', 'confidential'), undefined, undefined)).toBe(false);
    });
  });

  describe('namespace constraint (vault_sync: targetNs always defined)', () => {
    it('allows a same-namespace row', () => {
      expect(reconcileBlocked(row('team-a', 'public'), 'team-a', undefined)).toBe(false);
    });
    it('blocks a foreign-namespace row', () => {
      expect(reconcileBlocked(row('team-b', 'public'), 'team-a', undefined)).toBe(true);
    });
  });

  describe('forced-only namespace (import: targetNs = forcedNamespace, undefined when unforced)', () => {
    it('unforced import allows a row from another namespace', () => {
      expect(reconcileBlocked(row('team-b', 'public'), undefined, undefined)).toBe(false);
    });
    it('forced import blocks a row from another namespace', () => {
      expect(reconcileBlocked(row('team-b', 'public'), 'team-a', undefined)).toBe(true);
    });
  });

  describe('ceiling constraint', () => {
    it('allows a row at or below the ceiling', () => {
      expect(reconcileBlocked(row('team-a', 'internal'), 'team-a', ['public', 'internal'])).toBe(false);
    });
    it('blocks a row above the ceiling', () => {
      expect(reconcileBlocked(row('team-a', 'confidential'), 'team-a', ['public', 'internal'])).toBe(true);
    });
    it('applies the ceiling even with no namespace constraint (consolidate shape)', () => {
      // consolidate's findNearDuplicates already partitions to the row's own
      // namespace, so it passes targetNamespace=undefined and relies on ceiling.
      expect(reconcileBlocked(row('team-a', 'confidential'), undefined, ['public'])).toBe(true);
      expect(reconcileBlocked(row('team-a', 'public'), undefined, ['public'])).toBe(false);
    });
  });

  describe('both constraints fail', () => {
    it('blocks (namespace checked first, but either alone suffices)', () => {
      expect(reconcileBlocked(row('team-b', 'confidential'), 'team-a', ['public'])).toBe(true);
    });
  });

  describe('null (global/unscoped) namespace — the load-bearing undefined-vs-null distinction', () => {
    it('allows a true round-trip when both existing and target are null', () => {
      // vault_sync unforced: row.namespace = null, a global memory round-tripping.
      expect(reconcileBlocked(row(null, 'public'), null, undefined)).toBe(false);
    });
    it('blocks a non-null existing row against a null target (vault_sync unconditional ns)', () => {
      expect(reconcileBlocked(row('team-a', 'public'), null, undefined)).toBe(true);
    });
    it('blocks a null existing row against a non-null target', () => {
      expect(reconcileBlocked(row(null, 'public'), 'team-a', undefined)).toBe(true);
    });
    it('undefined target skips the ns check even for a null-namespace row', () => {
      // import unforced: forcedNamespace = undefined, so a null-ns row may overwrite.
      expect(reconcileBlocked(row(null, 'public'), undefined, undefined)).toBe(false);
    });
  });
});
