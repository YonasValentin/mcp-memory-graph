import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleSessionState } from '../../tools/session-state.js';
import { handleExpertise } from '../../tools/expertise.js';

const embedder = new MockEmbeddingProvider();

describe('M5.1 memory_session_state', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('save then resume round-trips full structured state on the same key', async () => {
    await handleSessionState(db, embedder, {
      action: 'save',
      session_key: 'feat/x',
      scope: 'project',
      namespace: 'proj',
      summary: 'wiring the event bus',
      next_steps: ['add dispatcher', 'add tests'],
      open_questions: ['HMAC header name?'],
      branch: 'feat/x',
    });
    const r = await handleSessionState(db, embedder, {
      action: 'resume',
      session_key: 'feat/x',
      scope: 'project',
      namespace: 'proj',
    });
    expect(r.found).toBe(true);
    expect(r.state?.summary).toBe('wiring the event bus');
    expect(r.state?.next_steps).toEqual(['add dispatcher', 'add tests']);
    expect(r.content).toContain('Next steps');
  });

  it('a second save UPSERTS the same row (no dedup-gate NOOP) and bumps version', async () => {
    const s1 = await handleSessionState(db, embedder, {
      action: 'save', session_key: 'k', scope: 'project', namespace: 'proj', summary: 'first',
    });
    const s2 = await handleSessionState(db, embedder, {
      action: 'save', session_key: 'k', scope: 'project', namespace: 'proj', summary: 'first, plus a small addition',
    });
    expect(s2.memory_id).toBe(s1.memory_id); // same row, not a new one
    expect((s2.version ?? 0)).toBeGreaterThan(s1.version ?? 0); // versioned for diffing

    // exactly one live session-state row for the key
    const cnt = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE document_type='session-state' AND valid_to IS NULL",
      )
      .get() as { n: number };
    expect(cnt.n).toBe(1);
  });

  it('resume on a missing key returns found:false', async () => {
    const r = await handleSessionState(db, embedder, { action: 'resume', session_key: 'nope' });
    expect(r.found).toBe(false);
  });
});

describe('M5.2 memory_expertise', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('observe raises level on a saturating curve and never collapses other topics', async () => {
    const a1 = await handleExpertise(db, embedder, { action: 'observe', topic: 'rust' });
    expect(a1.observed?.evidence_count).toBe(1);
    expect(a1.observed?.level).toBeCloseTo(0.5, 5); // 1 - 1/(1+1)

    const a2 = await handleExpertise(db, embedder, { action: 'observe', topic: 'rust' });
    expect(a2.observed?.evidence_count).toBe(2);
    expect(a2.observed?.level).toBeCloseTo(1 - 1 / 3, 5); // ~0.667, rises but < 1

    // a different topic must be its own row, not a NOOP-collapse of 'rust'
    const b = await handleExpertise(db, embedder, { action: 'observe', topic: 'postgres' });
    expect(b.observed?.evidence_count).toBe(1);

    const profile = await handleExpertise(db, embedder, { action: 'get' });
    expect(profile.profile?.map((e) => e.topic).sort()).toEqual(['postgres', 'rust']);
  });

  it('observe is a metadata-only update — does not snapshot versions', async () => {
    const o = await handleExpertise(db, embedder, { action: 'observe', topic: 'graphs' });
    await handleExpertise(db, embedder, { action: 'observe', topic: 'graphs' });
    await handleExpertise(db, embedder, { action: 'observe', topic: 'graphs' });
    const versions = db
      .prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?')
      .get(o.observed!.memory_id) as { n: number };
    expect(versions.n).toBe(0); // counter bumps don't churn the edit history
  });

  it('get filters by topic', async () => {
    await handleExpertise(db, embedder, { action: 'observe', topic: 'kafka' });
    await handleExpertise(db, embedder, { action: 'observe', topic: 'redis' });
    const r = await handleExpertise(db, embedder, { action: 'get', topic: 'kafka' });
    expect(r.profile?.map((e) => e.topic)).toEqual(['kafka']);
  });
});
