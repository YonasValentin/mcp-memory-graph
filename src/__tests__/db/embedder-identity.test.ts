import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initializeSchema, assertEmbedderIdentity } from '../../db/schema.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../constants/enums.js';

const prevModel = process.env.MCP_MEMORY_MODEL;
afterEach(() => {
  if (prevModel === undefined) delete process.env.MCP_MEMORY_MODEL;
  else process.env.MCP_MEMORY_MODEL = prevModel;
});

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  return db;
}

function storedModel(db: Database.Database): string | undefined {
  return (
    db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get('embedding_model') as { value: string } | undefined
  )?.value;
}

describe('embedder identity guard (schema_meta.embedding_model)', () => {
  it('stamps the configured model on a fresh DB', () => {
    delete process.env.MCP_MEMORY_MODEL;
    const db = freshDb();
    initializeSchema(db);
    expect(storedModel(db)).toBe(DEFAULT_EMBEDDING_MODEL);
    db.close();
  });

  it('stamps a custom MCP_MEMORY_MODEL on a fresh DB', () => {
    process.env.MCP_MEMORY_MODEL = 'Xenova/bge-small-en-v1.5';
    const db = freshDb();
    initializeSchema(db);
    expect(storedModel(db)).toBe('Xenova/bge-small-en-v1.5');
    db.close();
  });

  it('re-opening with the same model passes', () => {
    delete process.env.MCP_MEMORY_MODEL;
    const db = freshDb();
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
    db.close();
  });

  it('opening with a DIFFERENT model throws with both names and a rebuild hint', () => {
    delete process.env.MCP_MEMORY_MODEL;
    const db = freshDb();
    initializeSchema(db);
    process.env.MCP_MEMORY_MODEL = 'Xenova/bge-small-en-v1.5';
    expect(() => initializeSchema(db)).toThrow(
      /built with "Xenova\/all-MiniLM-L6-v2".*"Xenova\/bge-small-en-v1\.5".*rebuild/s,
    );
    db.close();
  });

  it('legacy DB without a recorded model is accepted and stamped (three-state: unknown)', () => {
    delete process.env.MCP_MEMORY_MODEL;
    const db = freshDb();
    initializeSchema(db);
    db.prepare('DELETE FROM schema_meta WHERE key = ?').run('embedding_model');
    expect(() => initializeSchema(db)).not.toThrow();
    expect(storedModel(db)).toBe(DEFAULT_EMBEDDING_MODEL);
    db.close();
  });

  it('assertEmbedderIdentity is exported and three-state on its own', () => {
    const db = freshDb();
    initializeSchema(db);
    expect(() => assertEmbedderIdentity(db, DEFAULT_EMBEDDING_MODEL)).not.toThrow();
    expect(() => assertEmbedderIdentity(db, 'other/model')).toThrow(/Embedding model mismatch/);
    db.close();
  });

  // CONFIRMED HIGH (fix-breaker battle): an empty-string MCP_MEMORY_MODEL is a
  // realistic Docker footgun (`-e MCP_MEMORY_MODEL` / compose `environment: -
  // MCP_MEMORY_MODEL`). transformers.js treats '' as "no model" and loads the
  // real default all-MiniLM-L6-v2, so the vectors ARE the default model's — but
  // the guard used to stamp/compare '' and brick the DB on the next restart.
  it('DB stamped under empty MCP_MEMORY_MODEL re-opens cleanly when the var is unset', () => {
    process.env.MCP_MEMORY_MODEL = '';
    const db = freshDb();
    initializeSchema(db);
    // Vectors are the default model's, so the stamp must be the default model.
    expect(storedModel(db)).toBe(DEFAULT_EMBEDDING_MODEL);
    delete process.env.MCP_MEMORY_MODEL;
    expect(() => initializeSchema(db)).not.toThrow();
    db.close();
  });

  it('default-stamped DB opened with an empty MCP_MEMORY_MODEL does NOT throw', () => {
    delete process.env.MCP_MEMORY_MODEL;
    const db = freshDb();
    initializeSchema(db);
    process.env.MCP_MEMORY_MODEL = '';
    expect(() => initializeSchema(db)).not.toThrow();
    db.close();
  });

  // Fix-breaker WAVE 2 HIGH: a DB built by the OLD code with an empty/whitespace
  // MCP_MEMORY_MODEL was stamped literally '' (the vectors ARE the default
  // model's). The empty→DEFAULT resolution fix would then brick it on upgrade
  // (stored '' != configured DEFAULT). The guard must normalize a legacy
  // empty/whitespace stamp to the default and re-stamp, not throw.
  it('a legacy empty-string embedding_model stamp normalizes to the default, not a brick', () => {
    delete process.env.MCP_MEMORY_MODEL;
    const db = freshDb();
    initializeSchema(db);
    db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('', 'embedding_model');
    expect(() => initializeSchema(db)).not.toThrow();
    expect(storedModel(db)).toBe(DEFAULT_EMBEDDING_MODEL); // re-stamped
    db.close();
  });

  it('a legacy whitespace-only embedding_model stamp normalizes to the default', () => {
    delete process.env.MCP_MEMORY_MODEL;
    const db = freshDb();
    initializeSchema(db);
    db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('   ', 'embedding_model');
    expect(() => assertEmbedderIdentity(db, DEFAULT_EMBEDDING_MODEL)).not.toThrow();
    expect(storedModel(db)).toBe(DEFAULT_EMBEDDING_MODEL);
    db.close();
  });
});
