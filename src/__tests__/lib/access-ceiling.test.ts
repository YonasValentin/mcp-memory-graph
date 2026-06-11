/**
 * RBAC v1 §6 — per-key access-level egress ceiling.
 *
 * principalAccessCeiling() returns the allowed-levels array (index ≤
 * index(ctx.maxAccessLevel) over ACCESS_LEVELS) IN principal mode, and undefined
 * in legacy/local modes (no ceiling). It reuses the same sensitivity-ordered cap
 * construction as export-dataset's allow-list. The ceiling is a DIFFERENT
 * predicate from the existing single-level `access_level` filter (a MAX, applied
 * as access_level IN (allowed...)); both compose as an intersection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { principalAccessCeiling } from '../../lib/tenancy.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';

function key(maxAccessLevel: PrincipalContext['maxAccessLevel']): PrincipalContext {
  return { principal: 'k', keyId: 'k1', namespaces: ['ns'], maxAccessLevel };
}

const prevEnv = process.env.MCP_API_NAMESPACE;
afterEach(() => {
  if (prevEnv === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prevEnv;
});

describe('principalAccessCeiling', () => {
  it('returns undefined with NO principal (local mode — no ceiling)', () => {
    delete process.env.MCP_API_NAMESPACE;
    expect(principalAccessCeiling()).toBeUndefined();
  });

  it('returns undefined in legacy ENV-pin mode (no ALS principal)', () => {
    process.env.MCP_API_NAMESPACE = 'edc';
    expect(principalAccessCeiling()).toBeUndefined();
  });

  it("maxAccessLevel='public' → ['public'] only", () => {
    runWithPrincipal(key('public'), () => {
      expect(principalAccessCeiling()).toEqual(['public']);
    });
  });

  it("maxAccessLevel='internal' → ['public','internal']", () => {
    runWithPrincipal(key('internal'), () => {
      expect(principalAccessCeiling()).toEqual(['public', 'internal']);
    });
  });

  it("maxAccessLevel='confidential' → public/internal/confidential", () => {
    runWithPrincipal(key('confidential'), () => {
      expect(principalAccessCeiling()).toEqual(['public', 'internal', 'confidential']);
    });
  });

  it("maxAccessLevel='restricted' → all four (no rows hidden)", () => {
    runWithPrincipal(key('restricted'), () => {
      expect(principalAccessCeiling()).toEqual([
        'public',
        'internal',
        'confidential',
        'restricted',
      ]);
    });
  });
});
