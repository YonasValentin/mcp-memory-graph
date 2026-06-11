/**
 * RBAC v1 §1 — per-request principal context over AsyncLocalStorage. tenancy.ts
 * imports this module, NEVER the reverse, so the context store stays a leaf.
 */
import { describe, it, expect } from 'vitest';
import {
  runWithPrincipal,
  currentPrincipal,
  type PrincipalContext,
} from '../../lib/request-context.js';

const ctx = (over: Partial<PrincipalContext> = {}): PrincipalContext => ({
  principal: 'sales-bot',
  keyId: 'key-1',
  namespaces: ['sales'],
  maxAccessLevel: 'internal',
  ...over,
});

describe('runWithPrincipal / currentPrincipal', () => {
  it('is undefined outside any run', () => {
    expect(currentPrincipal()).toBeUndefined();
  });

  it('exposes the context inside the run and returns fn’s value', () => {
    const result = runWithPrincipal(ctx(), () => {
      expect(currentPrincipal()?.principal).toBe('sales-bot');
      expect(currentPrincipal()?.keyId).toBe('key-1');
      return 42;
    });
    expect(result).toBe(42);
    expect(currentPrincipal()).toBeUndefined(); // restored after
  });

  it('propagates across await boundaries (async continuation keeps the store)', async () => {
    const seen: Array<string | undefined> = [];
    await runWithPrincipal(ctx({ principal: 'async-bot' }), async () => {
      seen.push(currentPrincipal()?.principal);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(currentPrincipal()?.principal);
      await Promise.resolve();
      seen.push(currentPrincipal()?.principal);
    });
    expect(seen).toEqual(['async-bot', 'async-bot', 'async-bot']);
    expect(currentPrincipal()).toBeUndefined();
  });

  it('nested runs shadow and restore the outer context', () => {
    runWithPrincipal(ctx({ principal: 'outer', namespaces: ['a'] }), () => {
      expect(currentPrincipal()?.principal).toBe('outer');
      runWithPrincipal(ctx({ principal: 'inner', namespaces: ['b'] }), () => {
        expect(currentPrincipal()?.principal).toBe('inner');
        expect(currentPrincipal()?.namespaces).toEqual(['b']);
      });
      expect(currentPrincipal()?.principal).toBe('outer');
      expect(currentPrincipal()?.namespaces).toEqual(['a']);
    });
  });

  it('two concurrent async runs never bleed into each other', async () => {
    const out: string[] = [];
    await Promise.all([
      runWithPrincipal(ctx({ principal: 'p1', namespaces: ['n1'] }), async () => {
        await new Promise((r) => setTimeout(r, 10));
        out.push(`p1=${currentPrincipal()?.namespaces[0]}`);
      }),
      runWithPrincipal(ctx({ principal: 'p2', namespaces: ['n2'] }), async () => {
        await new Promise((r) => setTimeout(r, 2));
        out.push(`p2=${currentPrincipal()?.namespaces[0]}`);
      }),
    ]);
    expect(out.sort()).toEqual(['p1=n1', 'p2=n2']);
  });

  it('refuses a fail-open context: empty or empty-string namespaces throw', () => {
    expect(() => runWithPrincipal(ctx({ namespaces: [] }), () => 'never')).toThrow(/namespaces/);
    expect(() => runWithPrincipal(ctx({ namespaces: [''] }), () => 'never')).toThrow(/namespaces/);
    expect(() =>
      runWithPrincipal(ctx({ namespaces: ['ok', ''] }), () => 'never'),
    ).toThrow(/namespaces/);
    expect(() =>
      runWithPrincipal(ctx({ namespaces: [7] as unknown as string[] }), () => 'never'),
    ).toThrow(/namespaces/);
    expect(currentPrincipal()).toBeUndefined();
  });
});
