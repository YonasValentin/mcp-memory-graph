/**
 * RBAC battle F1 (HIGH) — the version-history tools honour the §6 access ceiling.
 *
 * memory_versions / memory_history / memory_version_diff each return a row's
 * full per-version CONTENT (and the current-row content via `from == current`),
 * so a key whose ceiling caps at `internal` could read a CONFIDENTIAL row's body
 * in its OWN namespace — the namespace guard (`idInForcedNs`) passes, but the
 * ceiling was never checked. The fix mirrors memory_get's by-id chokepoint:
 * the DISPATCH closure now gates on
 * `!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)` and returns the
 * not-found / empty non-confirmation.
 *
 * The createServer dispatch path is smoke-only (no unit harness reaches the
 * registered tool closures), so — exactly like tenancy-byid-write.test.ts — this
 * is a SOURCE-LEVEL wiring guard: each of the three registrations must carry the
 * ceiling check `idWithinCeiling(parsed.id)`. The runtime semantics are covered
 * behaviorally by ceiling-version-remote-auth.test.ts (a real internal-ceiling
 * key over POST /mcp gets [] / exists:false / "Memory not found" on a
 * confidential row, real data on an internal one). Without the
 * `idWithinCeiling` clause the dispatch would fall through to the handler and
 * egress the confidential content.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts');
const src = readFileSync(serverSrc, 'utf8');

/** Slice the registration block for `tool` — from its `reg(\n    'tool',`
 * (NOT the bare `'tool',` that also appears in the READ_ONLY_TOOLS list) to the
 * NEXT `reg(` — so an assertion is scoped to that tool's registration only. */
function regBlock(tool: string): string {
  const start = src.indexOf(`reg(\n    '${tool}',`);
  expect(start, `registration for ${tool} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  reg(', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('server.ts gates the version-history tools on the §6 ceiling (F1 wiring guard)', () => {
  it.each([['memory_versions'], ['memory_history'], ['memory_version_diff']])(
    '%s registration carries the idWithinCeiling guard',
    (tool) => {
      const block = regBlock(tool);
      expect(block).toContain('idWithinCeiling(parsed.id)');
      // ...and it must be the by-id chokepoint twin of the namespace guard, so a
      // foreign-ns OR over-ceiling row is non-confirmed in ONE branch.
      expect(block).toContain('!idInForcedNs(parsed.id) || !idWithinCeiling(parsed.id)');
    },
  );
});

/**
 * RBAC RE-BATTLE residual (HIGH, confirmed) + systematic close. The F1 fix gated
 * the three READ version tools but the re-battle found memory_version_restore —
 * a WRITE that ALSO echoes the restored content — bypassed the ceiling (mutated
 * AND leaked an over-ceiling row for a sub-ceiling principal owning the
 * namespace). Per the battle-v9 lesson (a cross-cutting invariant must be
 * enforced on EVERY consumer, not the one that was reported), the ceiling guard
 * was extended to ALL by-id write/mutation/egress tools. This tripwire pins
 * every one of them so a future registration can't silently drop the clause.
 * Egress (echo content): version_restore, restore, forget(hard exports), verify.
 * Mutation (touch above clearance): update, delete, revalidate(confirm).
 * Seed surface: unlinked_mentions (by-id seed).
 */
describe('server.ts gates EVERY by-id write/mutation tool on the §6 ceiling (re-battle systematic close)', () => {
  it.each([
    ['memory_update'],
    ['memory_delete'],
    ['memory_restore'],
    ['memory_forget'],
    ['memory_version_restore'],
    ['memory_verify'],
    ['memory_unlinked_mentions'],
    ['memory_revalidate'],
  ])('%s registration carries the idWithinCeiling guard', (tool) => {
    expect(regBlock(tool)).toContain('idWithinCeiling(parsed.id)');
  });

  // The two by-id tools with VARIANT id-param names (the grep-by-`parsed.id`
  // miss that the re-battle's own systematic pass nearly repeated): extract
  // reads content to derive entities; condense rewrites content into a summary.
  it('memory_extract_entities gates the ceiling on parsed.memory_id', () => {
    expect(regBlock('memory_extract_entities')).toContain('idWithinCeiling(parsed.memory_id)');
  });
  it('memory_condense gates the ceiling on every listed m.id', () => {
    expect(regBlock('memory_condense')).toContain('idWithinCeiling(m.id)');
  });
});
