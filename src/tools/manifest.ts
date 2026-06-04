import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ManifestEntry, MemoryScope, MemoryRow } from '../types.js';
import { liveConditions } from '../db/predicates.js';
import { CURRENT_SCHEMA_VERSION } from '../db/schema.js';

interface ManifestInput {
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  document_type?: string;
  limit?: number;
  offset?: number;
}

export function handleManifest(
  db: Database.Database,
  input: ManifestInput,
): { entries: ManifestEntry[]; total: number; has_more: boolean } {
  // Top-level, currently-live memories only — agree with list/search/stats.
  const conditions: string[] = liveConditions({ topLevelOnly: true });
  const params: unknown[] = [];

  if (input.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(input.scope);
  }
  if (input.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(input.namespace);
  }
  if (input.department !== undefined) {
    conditions.push('department = ?');
    params.push(input.department);
  }
  if (input.document_type !== undefined) {
    conditions.push('document_type = ?');
    params.push(input.document_type);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const limit = input.limit ?? 500;
  const offset = input.offset ?? 0;

  const countRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM memories ${whereClause}`,
    )
    .get(...params);
  const total = countRow?.cnt ?? 0;

  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT id, title, scope, namespace, document_type, tags, importance_score, access_count, updated_at
       FROM memories ${whereClause}
       ORDER BY importance_score DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  const entries: ManifestEntry[] = rows.map((row) => {
    let tags: string[] = [];
    if (row.tags) {
      try {
        const parsed: unknown = JSON.parse(row.tags);
        if (Array.isArray(parsed)) {
          tags = parsed.filter((t): t is string => typeof t === 'string');
        }
      } catch {
        tags = [];
      }
    }

    const ageDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86_400_000),
    );

    return {
      id: row.id,
      title: row.title,
      scope: row.scope as MemoryScope,
      namespace: row.namespace,
      document_type: row.document_type,
      tags,
      importance_score: row.importance_score,
      access_count: row.access_count,
      age_days: ageDays,
      updated_at: row.updated_at,
    };
  });

  return {
    entries,
    total,
    has_more: offset + entries.length < total,
  };
}

// ── M2.6: Signed integrity manifest ──────────────────────────────────────────

/**
 * Tamper-evident fingerprint of the live, top-level corpus. `memories_merkle_root`
 * is a sha256 over the SORTED per-memory content hashes, so it is independent of
 * row/insertion order and changes iff any memory's content changes (or one is
 * added/removed). `generated_at` is supplied by the caller — the builder never
 * reads the system clock, keeping it deterministic and testable.
 */
export interface IntegrityManifest {
  schema_version: number;
  total: number;
  /** sha256(hex) over the newline-joined, sorted per-memory content hashes. */
  memories_merkle_root: string;
  /** ISO-8601 timestamp passed in by the caller (never read from the clock). */
  generated_at: string;
}

/**
 * sha256(hex) of a single memory's content — the per-memory leaf hash.
 *
 * Content is normalized by stripping trailing whitespace BEFORE hashing, to
 * match the vault round-trip: `memoryToMarkdown`/`parseMemoryFile` collapse a
 * memory's trailing whitespace (`src/vault/memory-file.ts` does `/\s+$/`), so a
 * manifest built from the live DB and one recomputed after a legitimate vault
 * round-trip MUST agree. Hashing raw content would false-positive every
 * round-tripped memory as "tampered". Trailing whitespace is semantically
 * insignificant and cannot survive the round-trip anyway, so this loses no real
 * tamper-detection (the signed provenance envelope, which hashes raw content,
 * is the byte-exact integrity primitive).
 */
export function memoryContentHash(content: string): string {
  return createHash('sha256').update(content.replace(/\s+$/, ''), 'utf-8').digest('hex');
}

/**
 * Fold an unordered set of per-memory content hashes into one root. Sorting
 * before joining makes the root order-independent; the trailing newline join is
 * a fixed, unambiguous framing so two corpora can never collide via concatenation.
 */
export function merkleRootFromHashes(hashes: readonly string[]): string {
  const root = createHash('sha256');
  for (const h of [...hashes].sort()) {
    root.update(h);
    root.update('\n');
  }
  return root.digest('hex');
}

/**
 * Build the integrity manifest for the live, top-level memories in `db`. Reads
 * only `content` (the signed payload) and computes the merkle root over the
 * sorted leaf hashes. `generatedAt` is a required ISO-string PARAMETER so the
 * result is fully deterministic for a given corpus + timestamp.
 */
export function buildIntegrityManifest(
  db: Database.Database,
  generatedAt: string,
): IntegrityManifest {
  const conditions = liveConditions({ topLevelOnly: true });
  const rows = db
    .prepare<unknown[], { content: string }>(
      `SELECT content FROM memories WHERE ${conditions.join(' AND ')}`,
    )
    .all();

  const hashes = rows.map((r) => memoryContentHash(r.content));

  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    total: hashes.length,
    memories_merkle_root: merkleRootFromHashes(hashes),
    generated_at: generatedAt,
  };
}
