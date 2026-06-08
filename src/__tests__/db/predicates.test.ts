/**
 * Unit test for the single-source-of-truth predicate builders in
 * `src/db/predicates.ts`.
 *
 * Two invariants are pinned here:
 *  (a) NO-ALIAS output is BYTE-IDENTICAL to the historical bare-column form, so
 *      every existing consumer (and the 6 sites already consolidated) is
 *      unchanged.
 *  (b) An optional `alias` prefixes EVERY emitted column with `<alias>.` while
 *      binding the IDENTICAL params — this lets the alias-prefixed memories-table
 *      sites (questions/insights/health) route through the SoT instead of
 *      hand-rolling `m.`/`s.`/`t.` predicates.
 */
import { describe, it, expect } from 'vitest';
import { liveConditions, scopeConditions, NOW_ISO_SQL } from '../../db/predicates.js';

describe('liveConditions — no alias (byte-identical to historical bare form)', () => {
  it('base: bitemporal validity guard only', () => {
    expect(liveConditions()).toEqual(['valid_to IS NULL', 'tx_expired IS NULL']);
  });

  it('excludeSuperseded appends superseded_at guard', () => {
    expect(liveConditions({ excludeSuperseded: true })).toEqual([
      'valid_to IS NULL',
      'tx_expired IS NULL',
      'superseded_at IS NULL',
    ]);
  });

  it('topLevelOnly appends parent_id guard', () => {
    expect(liveConditions({ topLevelOnly: true })).toEqual([
      'valid_to IS NULL',
      'tx_expired IS NULL',
      'parent_id IS NULL',
    ]);
  });

  it('excludeExpired appends the TTL guard using NOW_ISO_SQL', () => {
    expect(liveConditions({ excludeExpired: true })).toEqual([
      'valid_to IS NULL',
      'tx_expired IS NULL',
      `(expires_at IS NULL OR expires_at > ${NOW_ISO_SQL})`,
    ]);
  });

  it('all flags together, deterministic order', () => {
    expect(
      liveConditions({ excludeSuperseded: true, topLevelOnly: true, excludeExpired: true }),
    ).toEqual([
      'valid_to IS NULL',
      'tx_expired IS NULL',
      'superseded_at IS NULL',
      'parent_id IS NULL',
      `(expires_at IS NULL OR expires_at > ${NOW_ISO_SQL})`,
    ]);
  });
});

describe('liveConditions — with alias (prefixes every column)', () => {
  it('base: each column gets the alias prefix', () => {
    expect(liveConditions({ alias: 'm' })).toEqual(['m.valid_to IS NULL', 'm.tx_expired IS NULL']);
  });

  it('topLevelOnly aliased', () => {
    expect(liveConditions({ topLevelOnly: true, alias: 's' })).toEqual([
      's.valid_to IS NULL',
      's.tx_expired IS NULL',
      's.parent_id IS NULL',
    ]);
  });

  it('excludeExpired aliases only the column, NOW_ISO_SQL stays bare', () => {
    expect(liveConditions({ excludeExpired: true, alias: 'm' })).toEqual([
      'm.valid_to IS NULL',
      'm.tx_expired IS NULL',
      `(m.expires_at IS NULL OR m.expires_at > ${NOW_ISO_SQL})`,
    ]);
  });

  it('all flags aliased, deterministic order', () => {
    expect(
      liveConditions({
        excludeSuperseded: true,
        topLevelOnly: true,
        excludeExpired: true,
        alias: 't',
      }),
    ).toEqual([
      't.valid_to IS NULL',
      't.tx_expired IS NULL',
      't.superseded_at IS NULL',
      't.parent_id IS NULL',
      `(t.expires_at IS NULL OR t.expires_at > ${NOW_ISO_SQL})`,
    ]);
  });
});

describe('scopeConditions — no alias (byte-identical to historical bare form)', () => {
  it('only defined fields are constrained, with matching params', () => {
    expect(scopeConditions({ scope: 'project', namespace: 'ns' })).toEqual({
      conditions: ['scope = ?', 'namespace = ?'],
      params: ['project', 'ns'],
    });
  });

  it('department included when defined', () => {
    expect(scopeConditions({ scope: 'project', namespace: 'ns', department: 'eng' })).toEqual({
      conditions: ['scope = ?', 'namespace = ?', 'department = ?'],
      params: ['project', 'ns', 'eng'],
    });
  });

  it('empty input → no conditions, no params', () => {
    expect(scopeConditions({})).toEqual({ conditions: [], params: [] });
  });
});

describe('scopeConditions — with alias (prefixes columns, identical params)', () => {
  it('aliases each emitted column but keeps the same params', () => {
    expect(scopeConditions({ scope: 'project', namespace: 'ns' }, 's')).toEqual({
      conditions: ['s.scope = ?', 's.namespace = ?'],
      params: ['project', 'ns'],
    });
  });

  it('department aliased too', () => {
    expect(scopeConditions({ scope: 'project', namespace: 'ns', department: 'eng' }, 'm')).toEqual({
      conditions: ['m.scope = ?', 'm.namespace = ?', 'm.department = ?'],
      params: ['project', 'ns', 'eng'],
    });
  });

  it('empty input with an alias still yields nothing', () => {
    expect(scopeConditions({}, 't')).toEqual({ conditions: [], params: [] });
  });
});
