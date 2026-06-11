/**
 * battle-v7 H3 — by-id WRITE/mutation isolation under MCP_API_NAMESPACE.
 *
 * F1/F1b force-scoped every tool whose schema carries a TOP-LEVEL namespace
 * (store/ingest/session_note/core_memory). But the by-ID mutation tools take a
 * memory id, not a namespace, and so were never wrapped: on a namespace-forced
 * (multi-tenant) deployment a caller over POST /mcp could memory_update /
 * memory_delete / memory_forget / memory_restore / memory_condense /
 * memory_version_restore / memory_extract_entities ANOTHER tenant's memory by
 * id. The read tools already guard this with
 * `if (!idInForcedNs(parsed.id)) throw new Error('Memory not found')`
 * (existence non-confirmation). The writes must do the same.
 *
 * The createServer dispatch path is smoke-only (no unit harness reaches the
 * registered tool closures), so — exactly like tenancy-write-path.test.ts (F1b)
 * — this is a SOURCE-LEVEL wiring guard: server.ts must apply the id-ownership
 * guard inside each by-id mutation registration. The guard's runtime semantics
 * are covered behaviorally by tenancy.test.ts (idIsInForcedNamespace: foreign /
 * nonexistent id under a forced namespace → false → throw).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts');
const src = readFileSync(serverSrc, 'utf8');

describe('server.ts force-scopes every by-id mutation under MCP_API_NAMESPACE (H3 wiring guard)', () => {
  // The namespace-ownership check (H3) must be present per tool. These assert the
  // `!idInForcedNs(...)` SUBSTRING rather than the full line, because the §6
  // re-battle close OR'd an `|| !idWithinCeiling(...)` clause into each of these
  // same guards — the namespace forcing is intact (asserted here), the ceiling
  // addition is pinned separately in ceiling-version-tools.test.ts.
  it.each([
    ['memory_update', '!idInForcedNs(parsed.id)'],
    ['memory_restore', '!idInForcedNs(parsed.id)'],
    ['memory_forget', '!idInForcedNs(parsed.id)'],
    ['memory_version_restore', '!idInForcedNs(parsed.id)'],
    ['memory_extract_entities', '!idInForcedNs(parsed.memory_id)'],
    ['memory_delete', '!idInForcedNs(parsed.id)'],
    ['memory_condense', '!idInForcedNs(m.id)'],
  ])('%s registration carries the id-ownership guard', (_tool, guard) => {
    expect(src).toContain(guard);
  });

  it('memory_delete forces the bulk-filter namespace to the forced namespace', () => {
    // A filter delete carries its own filter.namespace — on a forced deployment
    // it must be overridden to the forced namespace so a bulk delete cannot reach
    // across tenants. (The §6 re-battle wrapped this in a conditional spread that
    // ALSO injects access_level_ceiling, so assert the forcing MECHANISM rather
    // than the pre-ceiling object-literal shape.)
    expect(src).toContain('forcedNamespace()');
    expect(src).toMatch(/namespace:\s*scopeFilterToNamespace\(parsed\)\.filter\?\.namespace/);
  });

  it('memory_delete injects the principal access ceiling into the bulk filter (re-battle close)', () => {
    // A sub-ceiling principal's bulk filter-delete must not destroy over-ceiling
    // rows — server.ts injects principalAccessCeiling() into the delete filter.
    expect(src).toMatch(/access_level_ceiling:\s*ceiling/);
    expect(src).toContain('principalAccessCeiling()');
  });
});
