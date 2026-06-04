import { describe, it, expect } from 'vitest';
import { extractEntitiesRegex } from '../../graph/entity-extractor.js';

function typesByName(content: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of extractEntitiesRegex(content)) m.set(e.name, e.type);
  return m;
}

describe('M4.1 anchor entities — work_item', () => {
  it('extracts Jira/ADO-style keys', () => {
    const t = typesByName('Fixed in PBI-146146 and also API-42, see EDC-1234.');
    expect(t.get('PBI-146146')).toBe('work_item');
    expect(t.get('API-42')).toBe('work_item');
    expect(t.get('EDC-1234')).toBe('work_item');
  });

  it('does NOT match prose standards tokens (COVID-19, ISO-8601, UTF-8, SHA-256, UTF-16)', () => {
    const names = extractEntitiesRegex(
      'During COVID-19 we used ISO-8601 dates, UTF-8 and UTF-16 encodings, SHA-256 hashing, AES-256, RFC-822.',
    ).filter((e) => e.type === 'work_item');
    expect(names).toEqual([]);
  });

  it('does NOT match decimals or dates', () => {
    const names = extractEntitiesRegex('Version 1.2.3, ratio 3.14, date 2024-01-15, value 100-200.')
      .filter((e) => e.type === 'work_item');
    // 2024-01 starts with a digit → not a key; 100-200 starts with a digit too.
    expect(names).toEqual([]);
  });
});

describe('M4.1 anchor entities — pull_request', () => {
  it('extracts explicit PR/MR references and normalizes them', () => {
    const t = typesByName('Merged PR #146, also PR-99 and MR 12 landed.');
    expect(t.get('PR-146')).toBe('pull_request');
    expect(t.get('PR-99')).toBe('pull_request');
    expect(t.get('MR-12')).toBe('pull_request');
  });

  it('does NOT match a bare #number with no keyword', () => {
    const names = extractEntitiesRegex('See section #146 and item #3 of the list.')
      .filter((e) => e.type === 'pull_request');
    expect(names).toEqual([]);
  });
});

describe('M4.1 anchor entities — commit', () => {
  it('extracts a git SHA', () => {
    const t = typesByName('Reverted in commit 7ebc4b4 and 9b08000a1cdef.');
    expect(t.get('7ebc4b4')).toBe('commit');
    expect(t.get('9b08000a1cdef')).toBe('commit');
  });

  it('does NOT match pure-decimal runs (no a-f letter)', () => {
    const names = extractEntitiesRegex('Order 1234567 shipped; invoice 9999999 paid.')
      .filter((e) => e.type === 'commit');
    expect(names).toEqual([]);
  });

  it('does NOT match UUID segments (hyphen-adjacent hex)', () => {
    const names = extractEntitiesRegex('id 128fcecf-2b9d-4201-a70f-9b9a35e12101 was stored.')
      .filter((e) => e.type === 'commit');
    expect(names).toEqual([]);
  });

  it('does NOT match hex embedded in a longer word/identifier', () => {
    const names = extractEntitiesRegex('the deadbeefcafe0babe variable xdeadbeef0 inside')
      .filter((e) => e.type === 'commit')
      .map((e) => e.name);
    // 'xdeadbeef0' is preceded by 'x' (word char) → excluded; the standalone
    // 'deadbeefcafe0babe' (17 hex, has a-f) IS a valid commit-shaped token.
    expect(names).toEqual(['deadbeefcafe0babe']);
  });
});
