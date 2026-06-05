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
  it.each([
    // tool, exact ownership guard the registration must contain
    ['memory_update', "if (!idInForcedNs(parsed.id)) throw new Error('Memory not found');"],
    ['memory_restore', "if (!idInForcedNs(parsed.id)) throw new Error('Memory not found');"],
    ['memory_forget', "if (!idInForcedNs(parsed.id)) throw new Error('Memory not found');"],
    ['memory_version_restore', "if (!idInForcedNs(parsed.id)) throw new Error('Memory not found');"],
    ['memory_extract_entities', "if (!idInForcedNs(parsed.memory_id)) throw new Error('Memory not found');"],
    ['memory_delete', "if (parsed.id && !idInForcedNs(parsed.id)) throw new Error('Memory not found');"],
    ['memory_condense', "if (parsed.memories.some((m) => !idInForcedNs(m.id))) throw new Error('Memory not found');"],
  ])('%s registration carries the id-ownership guard', (_tool, guard) => {
    expect(src).toContain(guard);
  });

  it('memory_delete forces the bulk-filter namespace to the forced namespace', () => {
    // A filter delete carries its own filter.namespace — on a forced deployment
    // it must be overridden to the forced namespace so a bulk delete cannot reach
    // across tenants.
    expect(src).toContain('forcedNamespace()');
    expect(src).toMatch(/filter:\s*\{\s*\.\.\.parsed\.filter,\s*namespace:/);
  });
});
