import { describe, it, expect, afterEach } from 'vitest';
import { envInt, envFlag } from '../../lib/env.js';

const VAR = 'MCP_TEST_ENV_HELPER_VAR';

afterEach(() => {
  delete process.env[VAR];
});

describe('envInt', () => {
  it('returns fallback when unset, non-numeric, or non-positive', () => {
    expect(envInt(VAR, 7)).toBe(7);
    process.env[VAR] = 'abc';
    expect(envInt(VAR, 7)).toBe(7);
    process.env[VAR] = '0';
    expect(envInt(VAR, 7)).toBe(7);
    process.env[VAR] = '-3';
    expect(envInt(VAR, 7)).toBe(7);
  });

  it('returns the parsed value when positive', () => {
    process.env[VAR] = '42';
    expect(envInt(VAR, 7)).toBe(42);
  });
});

describe('envFlag', () => {
  it('is false when unset or explicitly off', () => {
    expect(envFlag(VAR)).toBe(false);
    process.env[VAR] = '0';
    expect(envFlag(VAR)).toBe(false);
    process.env[VAR] = 'false';
    expect(envFlag(VAR)).toBe(false);
    process.env[VAR] = '';
    expect(envFlag(VAR)).toBe(false);
  });

  it('is true for 1/true (case-insensitive)', () => {
    process.env[VAR] = '1';
    expect(envFlag(VAR)).toBe(true);
    process.env[VAR] = 'true';
    expect(envFlag(VAR)).toBe(true);
    process.env[VAR] = 'TRUE';
    expect(envFlag(VAR)).toBe(true);
  });
});
