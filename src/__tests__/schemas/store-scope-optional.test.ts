/**
 * BUG B (fresh-user E2E) — MemoryStoreSchema's zod default filled scope='global'
 * BEFORE the handler could know the arg was omitted, so a loaded config's
 * defaults.scope/defaults.namespace were dead for memory_store. The store schema
 * must leave an omitted scope undefined; the default chain (explicit arg >
 * config defaults.scope > 'global') now lives in handleStore. Only the STORE
 * schema changes — every other tool keeps its scopeFieldWithDefault behavior.
 */
import { describe, it, expect } from 'vitest';
import { MemoryStoreSchema } from '../../schemas/index.js';

describe('MemoryStoreSchema scope (BUG B)', () => {
  it('leaves an omitted scope undefined so handler-level config defaults can apply', () => {
    expect(MemoryStoreSchema.parse({ content: 'x' }).scope).toBeUndefined();
  });

  it('still parses and validates an explicit scope', () => {
    expect(MemoryStoreSchema.parse({ content: 'x', scope: 'team' }).scope).toBe('team');
    expect(() => MemoryStoreSchema.parse({ content: 'x', scope: 'bogus' })).toThrow();
  });

  it('leaves an omitted namespace undefined (unchanged)', () => {
    expect(MemoryStoreSchema.parse({ content: 'x' }).namespace).toBeUndefined();
  });
});
