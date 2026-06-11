/**
 * Fix-breaker S18 HIGH: with the config the documented `init --scope project`
 * writes (defaults.namespace:'auto'), memory_session_note threw on every call
 * after the first. handleStore config-filled the CREATE row's namespace to
 * basename(cwd) while session-note's append-lookup searched namespace IS NULL —
 * the row was never found, re-created, hit the UNIQUE source index, exhausted
 * the retry budget, and threw. Config store-defaults must NOT leak into the
 * shared handleStore used by sibling source-keyed tools.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleSessionNote } from '../../tools/session-note.js';
import { clearConfigCache } from '../../config/loader.js';

let tmpRoot: string;
let projectDir: string;
let db: Database.Database;
const embedder = new MockEmbeddingProvider();
const ORIG_CFG = process.env.MCP_MEMORY_CONFIG_PATH;
const ORIG_NS = process.env.MCP_API_NAMESPACE;
const origCwd = process.cwd();

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-cfg-'));
  projectDir = path.join(tmpRoot, 'rocket-proj');
  fs.mkdirSync(path.join(projectDir, '.mcp-memory'), { recursive: true });
  // Exactly what `init --scope project --yes` produces.
  fs.writeFileSync(
    path.join(projectDir, '.mcp-memory', 'config.json'),
    JSON.stringify({ defaults: { scope: 'project', namespace: 'auto' } }),
  );
  process.env.MCP_MEMORY_CONFIG_PATH = path.join(projectDir, '.mcp-memory', 'config.json');
  delete process.env.MCP_API_NAMESPACE;
  process.chdir(projectDir);
  clearConfigCache();
  db = createTestDb();
});

afterEach(() => {
  db.close();
  process.chdir(origCwd);
  if (ORIG_CFG === undefined) delete process.env.MCP_MEMORY_CONFIG_PATH;
  else process.env.MCP_MEMORY_CONFIG_PATH = ORIG_CFG;
  if (ORIG_NS === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = ORIG_NS;
  clearConfigCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('memory_session_note under a project config (fix-breaker S18 HIGH)', () => {
  it('appends to the single session row instead of throwing on the 2nd call', async () => {
    const first = await handleSessionNote(db, embedder, { session_id: 'sess-abc', text: 'note 1' });
    expect(first.created).toBe(true);
    const second = await handleSessionNote(db, embedder, { session_id: 'sess-abc', text: 'note 2' });
    expect(second.appended).toBe(true);
    expect(second.memory_id).toBe(first.memory_id);
  });

  it('keeps the session row at the legacy null namespace (config namespace must not bleed in)', async () => {
    const r = await handleSessionNote(db, embedder, { session_id: 'sess-xyz', text: 'a note' });
    const row = db.prepare('SELECT namespace FROM memories WHERE id = ?').get(r.memory_id) as { namespace: string | null };
    expect(row.namespace).toBeNull();
  });

  // Fix-breaker WAVE 2 MED: only the config NAMESPACE default breaks the
  // source-keyed append-lookup; the SCOPE default is safe (the lookup is by
  // source+namespace, not scope) and SHOULD apply to every store-family tool so
  // a memory_store memory and a session note share a dedup partition. Wave-1
  // over-corrected by dropping both.
  it('still honors the config defaults.scope (only namespace is withheld from siblings)', async () => {
    const r = await handleSessionNote(db, embedder, { session_id: 'sess-scope', text: 'scoped note' });
    const row = db.prepare('SELECT scope, namespace FROM memories WHERE id = ?').get(r.memory_id) as {
      scope: string;
      namespace: string | null;
    };
    expect(row.scope).toBe('project'); // from config defaults.scope
    expect(row.namespace).toBeNull(); // namespace default withheld (source-keyed lookup)
  });
});
