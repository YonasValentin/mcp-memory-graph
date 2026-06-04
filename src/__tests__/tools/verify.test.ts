/**
 * M2.2 — memory_verify tool (read-only).
 *
 * handleVerify re-derives each memory's content_hash from the stored content and
 * ed25519-verifies its signature against the canonical provenance JSON, bucketing
 * every memory into verified / unsigned / tampered. It can verify a single memory
 * by id or a batch (filtered by scope/namespace, capped by limit).
 *
 * Setup: store rows via handleStore (which today writes no envelope — so rows are
 * unsigned by default), then sign a subset by calling signEnvelope + a manual
 * UPDATE of content_hash/signature/pubkey/signed_at. A "tampered" row is one that
 * was signed and then had its content edited out from under the signature.
 *
 * Uses createTestDb + MockEmbeddingProvider; MCP_MEMORY_KEY_DIR points at a fresh
 * mkdtemp dir so the real key store is never touched and nothing is downloaded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { signEnvelope } from '../../provenance/envelope.js';
import { handleVerify } from '../../tools/verify.js';

const embedder = new MockEmbeddingProvider();
const SIGNED_AT = '2026-06-04T10:00:00.000Z';

let db: Database.Database;
let keyDir: string;
const prevKeyDir = process.env.MCP_MEMORY_KEY_DIR;

/**
 * Ensure the schema-v10 provenance columns exist. Idempotent: a duplicate-column
 * ALTER is swallowed, so this is a no-op on a real v10 DB and back-fills them on
 * an older test baseline — keeping this test self-contained regardless of the
 * worktree's migration high-water mark (the orchestrator wires the columns via
 * the v10 migration in the shared schema).
 */
function ensureProvenanceColumns(d: Database.Database): void {
  for (const col of ['content_hash', 'signature', 'pubkey', 'signed_at']) {
    try {
      d.exec(`ALTER TABLE memories ADD COLUMN ${col} TEXT`);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('duplicate column name')) throw err;
    }
  }
}

beforeEach(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'mcp-mem-verify-'));
  process.env.MCP_MEMORY_KEY_DIR = keyDir;
  db = createTestDb();
  ensureProvenanceColumns(db);
});

afterEach(() => {
  if (prevKeyDir === undefined) {
    delete process.env.MCP_MEMORY_KEY_DIR;
  } else {
    process.env.MCP_MEMORY_KEY_DIR = prevKeyDir;
  }
  rmSync(keyDir, { recursive: true, force: true });
});

/** Sign an already-stored memory by reading its row and stamping the envelope. */
function signStored(id: string): void {
  const row = db
    .prepare<[string], { content: string; agent_id: string | null; provenance: string; scope: string; namespace: string | null; valid_from: string | null; created_at: string }>(
      'SELECT content, agent_id, provenance, scope, namespace, valid_from, created_at FROM memories WHERE id = ?',
    )
    .get(id)!;
  // Mirrors insertMemory's signing contract: provenance is EXCLUDED from the
  // signed envelope (it is mutated post-insert — reflect stamps it — so signing
  // it would false-flag those rows; verify.ts omits it symmetrically).
  const env = signEnvelope(
    row.content,
    {
      agent_id: row.agent_id,
      scope: row.scope,
      namespace: row.namespace,
      valid_from: row.valid_from,
      created_at: row.created_at,
    },
    SIGNED_AT,
  );
  db.prepare(
    'UPDATE memories SET content_hash = ?, signature = ?, pubkey = ?, signed_at = ? WHERE id = ?',
  ).run(env.content_hash, env.signature, env.pubkey, env.signed_at, id);
}

describe('handleVerify', () => {
  it('verifies a single signed memory by id → ok', async () => {
    const stored = await handleStore(db, embedder, { content: 'signed fact', title: 'A' });
    signStored(stored.memory.id);

    const result = handleVerify(db, { id: stored.memory.id });

    expect(result.summary).toEqual({ verified: 1, unsigned: 0, tampered: 0 });
    expect(result.results).toEqual([{ id: stored.memory.id, status: 'verified' }]);
  });

  it('reports an unsigned memory as unsigned', async () => {
    const stored = await handleStore(db, embedder, { content: 'no envelope here', title: 'B' });

    const result = handleVerify(db, { id: stored.memory.id });

    expect(result.summary).toEqual({ verified: 0, unsigned: 1, tampered: 0 });
    expect(result.results[0]).toEqual({ id: stored.memory.id, status: 'unsigned' });
  });

  it('reports a content-tampered signed memory as tampered', async () => {
    const stored = await handleStore(db, embedder, { content: 'original', title: 'C' });
    signStored(stored.memory.id);
    // Edit content directly, bypassing the (would-be) re-signing path.
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('tampered', stored.memory.id);

    const result = handleVerify(db, { id: stored.memory.id });

    expect(result.summary).toEqual({ verified: 0, unsigned: 0, tampered: 1 });
    expect(result.results[0]).toEqual({ id: stored.memory.id, status: 'tampered' });
  });

  it('reports a forged-signature signed memory as tampered', async () => {
    const stored = await handleStore(db, embedder, { content: 'forge me', title: 'D' });
    signStored(stored.memory.id);
    // Flip a signature byte (keep content_hash correct).
    const { signature } = db
      .prepare<[string], { signature: string }>('SELECT signature FROM memories WHERE id = ?')
      .get(stored.memory.id)!;
    const buf = Buffer.from(signature, 'base64');
    buf[0] ^= 0xff;
    db.prepare('UPDATE memories SET signature = ? WHERE id = ?').run(
      buf.toString('base64'),
      stored.memory.id,
    );

    const result = handleVerify(db, { id: stored.memory.id });
    expect(result.summary).toEqual({ verified: 0, unsigned: 0, tampered: 1 });
    expect(result.results[0]).toEqual({ id: stored.memory.id, status: 'tampered' });
  });

  it('batch-verifies and buckets a mix of verified / unsigned / tampered', async () => {
    const ok = await handleStore(db, embedder, { content: 'good one', title: 'ok' });
    const unsigned = await handleStore(db, embedder, { content: 'bare one', title: 'bare' });
    const tampered = await handleStore(db, embedder, { content: 'will rot', title: 'rot' });

    signStored(ok.memory.id);
    signStored(tampered.memory.id);
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('rotted', tampered.memory.id);

    const result = handleVerify(db, {});

    expect(result.summary).toEqual({ verified: 1, unsigned: 1, tampered: 1 });
    const byId = new Map(result.results.map((r) => [r.id, r.status]));
    expect(byId.get(ok.memory.id)).toBe('verified');
    expect(byId.get(unsigned.memory.id)).toBe('unsigned');
    expect(byId.get(tampered.memory.id)).toBe('tampered');
  });

  it('a missing id returns an empty batch with a zeroed summary', () => {
    const result = handleVerify(db, { id: 'does-not-exist' });
    expect(result.results).toEqual([]);
    expect(result.summary).toEqual({ verified: 0, unsigned: 0, tampered: 0 });
  });

  it('honors scope filter and limit in batch mode', async () => {
    const a = await handleStore(db, embedder, { content: 'p1', title: 'p1', scope: 'project' });
    await handleStore(db, embedder, { content: 'g1', title: 'g1', scope: 'global' });
    signStored(a.memory.id);

    const scoped = handleVerify(db, { scope: 'project' });
    expect(scoped.results.every((r) => r.id === a.memory.id)).toBe(true);
    expect(scoped.summary.verified).toBe(1);

    const limited = handleVerify(db, { limit: 1 });
    expect(limited.results.length).toBe(1);
  });
});
