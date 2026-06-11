/**
 * Fix-breaker S18 LOW: d1d421c added team/department/sop/agent to ENTITY_TYPES
 * (the enterprise-brain org ontology) but did NOT add them to SPECIFIC_TYPES in
 * findOrCreateEntity, so a node first inferred as a generic type
 * (concept/file/pattern) could never UPGRADE to an org kind when explicitly
 * extracted — leaving it stale-typed and invisible to memory_graph's exact
 * `type = ?` filter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { findOrCreateEntity } from '../../graph/entity-store.js';

let db: Database.Database;
const P = { scope: 'global', namespace: '' };

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db.close();
});

function typeOf(name: string): string | undefined {
  return (
    db
      .prepare<[string], { type: string }>('SELECT type FROM entities WHERE normalized_name = ?')
      .get(name.toLowerCase()) as { type: string } | undefined
  )?.type;
}

describe('org entity types upgrade from a generic first-inference (fix-breaker S18)', () => {
  it.each([
    ['team'],
    ['department'],
    ['sop'],
    ['agent'],
  ])('a concept/file node upgrades to %s when explicitly extracted', (orgType) => {
    findOrCreateEntity(db, 'Platform', 'concept', P);
    findOrCreateEntity(db, 'Platform', orgType, P);
    expect(typeOf('platform')).toBe(orgType);
  });

  it('does NOT downgrade an org type back to a generic regex hit', () => {
    findOrCreateEntity(db, 'Billing', 'team', P);
    findOrCreateEntity(db, 'Billing', 'concept', P);
    expect(typeOf('billing')).toBe('team');
  });
});
