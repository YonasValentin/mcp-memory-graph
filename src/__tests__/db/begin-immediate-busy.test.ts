/**
 * P9-begin-immediate (battle-v3 — deferred-txn write-upgrade SQLITE_BUSY).
 *
 * better-sqlite3's `db.transaction(fn)` issues a DEFAULT-DEFERRED `BEGIN`: the
 * write lock is acquired lazily on the FIRST write statement, not at BEGIN.
 * When a read-then-write txn (SELECT … then UPDATE/DELETE) runs while another
 * connection holds the write lock, the deferred → write UPGRADE throws
 * SQLITE_BUSY IMMEDIATELY — `busy_timeout = 5000` (set in createDatabase) is
 * NOT honored on a lock UPGRADE, only on a fresh lock acquisition. Result:
 * consolidate's prune/expire/dedup stages (deleteMemory / updateMemory) swallow
 * the SQLITE_BUSY into report.errors and SILENTLY UNDER-PRUNE under concurrent
 * writers.
 *
 * Fix: invoke the read-then-write repository txns via the `.immediate` variant
 * (BEGIN IMMEDIATE acquires the write lock at BEGIN, so busy_timeout applies and
 * the txn WAITS for the holder instead of throwing). Read-only txns
 * (findNearDuplicates) and write-first INSERTs are left DEFERRED.
 *
 * These tests use a real file-backed createDatabase connection plus a SECOND
 * connection in a worker thread that holds the WAL write lock briefly. The
 * worker releases the lock on a timer running on ITS OWN thread — the main
 * thread is synchronously busy-waiting inside the contended repository call, so
 * a same-process timer could never fire. The contended call must WAIT then
 * SUCCEED rather than throw SQLITE_BUSY.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../db/connection.js';
import { initializeSchema } from '../../db/schema.js';
import { runMigrations } from '../../db/migrations.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleForget } from '../../tools/forget.js';
import { storeExtractedEntities } from '../../graph/entity-store.js';
import { deleteMemory, updateMemory, getMemoryById } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();
const HOLDER_WORKER = fileURLToPath(new URL('./p9-lock-holder.worker.mjs', import.meta.url));

let dir: string;
let dbPath: string;
let actor: Database.Database; // the connection running the contended repository fn

function makeFileDb(path: string): Database.Database {
  const db = createDatabase(path);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}

/**
 * Spawn a worker that holds the WAL write lock for `holdMs`. Resolves once the
 * lock is confirmed held, handing back a `released` promise that resolves when
 * the worker has committed and exited.
 */
function holdWriteLockInWorker(holdMs: number): Promise<{ released: Promise<void> }> {
  const worker = new Worker(HOLDER_WORKER, { workerData: { dbPath, holdMs } });
  const released = new Promise<void>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', () => resolve());
  });
  return new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (m: string) => {
      if (m === 'locked') resolve({ released });
    });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-p9-'));
  dbPath = join(dir, 'memory.db');
  actor = makeFileDb(dbPath);
});

afterEach(() => {
  if (actor.open) actor.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P9-begin-immediate — read-then-write txns honor busy_timeout under contention', () => {
  it('deleteMemory WAITS for a held write lock and SUCCEEDS (does not throw SQLITE_BUSY)', async () => {
    const { memory } = await handleStore(actor, embedder, { content: 'P9 delete-under-contention fact.' });

    const { released } = await holdWriteLockInWorker(250);

    const t0 = Date.now();
    // DEFERRED form: throws SQLITE_BUSY ("database is locked") in ~0ms (RED).
    // BEGIN IMMEDIATE: blocks on busy_timeout until the worker commits (GREEN).
    const ok = deleteMemory(actor, memory.id);
    const waited = Date.now() - t0;

    await released;

    expect(ok).toBe(true);
    // It actually WAITED for the holder rather than failing instantly.
    expect(waited).toBeGreaterThan(100);
    // The row is really gone — the delete committed.
    expect(getMemoryById(actor, memory.id)).toBeNull();
  });

  it('updateMemory WAITS for a held write lock and SUCCEEDS (does not throw SQLITE_BUSY)', async () => {
    const { memory } = await handleStore(actor, embedder, { content: 'P9 update-under-contention fact.' });

    const { released } = await holdWriteLockInWorker(250);

    const t0 = Date.now();
    const updated = updateMemory(actor, memory.id, { title: 'P9 updated title' });
    const waited = Date.now() - t0;

    await released;

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('P9 updated title');
    expect(waited).toBeGreaterThan(100);
  });
});

/**
 * P9-residual — the SAME deferred-txn write-upgrade exposure on every OTHER
 * read-then-write `db.transaction` in the codebase (entity-store, forget,
 * import, condense, vault/sync, extract-entities). These exercise two
 * representative residual sites end-to-end: each does a SELECT (findOrCreateEntity
 * / recursive descendant scan) as its first statement inside the txn, so a
 * DEFERRED begin throws SQLITE_BUSY instantly under a concurrent writer; the
 * `.immediate` variant makes them WAIT on busy_timeout and succeed.
 */
describe('P9-residual — other read-then-write txns honor busy_timeout under contention', () => {
  it('storeExtractedEntities (entity-store) WAITS for a held write lock and SUCCEEDS', async () => {
    const { memory } = await handleStore(actor, embedder, { content: 'P9 entity-store-under-contention fact.' });

    const { released } = await holdWriteLockInWorker(250);

    const t0 = Date.now();
    // findOrCreateEntity does `SELECT id FROM entities …` FIRST, then INSERT/UPDATE.
    // DEFERRED: SQLITE_BUSY in ~0ms (RED). IMMEDIATE: waits then commits (GREEN).
    storeExtractedEntities(
      actor,
      memory.id,
      [{ name: 'P9ResidualWidget', type: 'tool', confidence: 0.9 }],
      'regex',
    );
    const waited = Date.now() - t0;

    await released;

    expect(waited).toBeGreaterThan(100);
    const linked = actor
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM memory_entities WHERE memory_id = ?')
      .get(memory.id)!;
    expect(linked.n).toBeGreaterThan(0);
  });

  it('handleForget(hard) (forget) WAITS for a held write lock and SUCCEEDS', async () => {
    const { memory } = await handleStore(actor, embedder, { content: 'P9 forget-under-contention fact.' });

    const { released } = await holdWriteLockInWorker(250);

    const t0 = Date.now();
    // eraseDescendantIndexes opens with a recursive SELECT, then deletes — the
    // erase txn is read-then-write and must take BEGIN IMMEDIATE.
    const result = handleForget(actor, { id: memory.id, hard: true });
    const waited = Date.now() - t0;

    await released;

    expect(result.forgotten).toBe(true);
    expect(result.mode).toBe('hard');
    expect(waited).toBeGreaterThan(100);
    expect(getMemoryById(actor, memory.id)).toBeNull();
  });
});

/**
 * Timing-free regression tripwire for the 9 read-then-write txn sites. Spinning
 * up a 2-connection contention test for every site is impractical (and flaky on
 * loaded CI), so this asserts at the SOURCE level that each site whose first
 * in-txn statement is a SELECT is invoked via `.immediate()` (BEGIN IMMEDIATE),
 * never the deferred `<name>()`. A future refactor that drops `.immediate()` from
 * any of them re-fails here even though no concurrent writer is present.
 *
 * Sites 1-5 were named by the original P9 author; sites 6-9 were found by audit
 * (identical deferred-upgrade exposure) — see the per-site comments in source.
 */
describe('P9-residual — source tripwire: read-then-write txns are invoked via .immediate()', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));

  const sites: Array<{ file: string; txnConst: string }> = [
    { file: 'tools/forget.ts', txnConst: 'erase' },
    { file: 'tools/condense.ts', txnConst: 'persist' },
    { file: 'tools/import.ts', txnConst: 'process' },
    { file: 'tools/extract-entities.ts', txnConst: 'process' },
    { file: 'graph/entity-store.ts', txnConst: 'store' },
    { file: 'graph/entity-store.ts', txnConst: 'update' },
    { file: 'vault/sync.ts', txnConst: 'insertBatch' },
    { file: 'vault/sync.ts', txnConst: 'insertAll' },
    { file: 'vault/sync.ts', txnConst: 'apply' },
  ];

  for (const { file, txnConst } of sites) {
    it(`${file}: \`${txnConst}\` read-then-write txn is invoked via .immediate()`, () => {
      const src = readFileSync(join(root, file), 'utf8');
      expect(src).toContain(`const ${txnConst} = db.transaction`);
      expect(src).toContain(`${txnConst}.immediate()`);
    });
  }
});
