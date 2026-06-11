import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ManifestEntry, MemoryScope, MemoryRow } from '../types.js';
import { liveConditions, scopeConditions, accessCeilingCondition } from '../db/predicates.js';
import { CURRENT_SCHEMA_VERSION } from '../db/schema.js';

interface ManifestInput {
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  document_type?: string;
  limit?: number;
  offset?: number;
  /**
   * RBAC §6 egress ceiling. The manifest emits row TITLES — a confidential
   * title is itself sensitive egress, so a capped principal's manifest (and its
   * content-hash) reflects only rows at/below the ceiling.
   */
  access_level_ceiling?: string[];
}

export function handleManifest(
  db: Database.Database,
  input: ManifestInput,
): { entries: ManifestEntry[]; total: number; has_more: boolean } {
  // Top-level, currently-live memories only — agree with list/search/stats.
  const scope = scopeConditions(input);
  const conditions: string[] = [
    ...liveConditions({ topLevelOnly: true }),
    ...scope.conditions,
  ];
  const params: unknown[] = [...scope.params];

  if (input.document_type !== undefined) {
    conditions.push('document_type = ?');
    params.push(input.document_type);
  }
  const ceiling = accessCeilingCondition(input.access_level_ceiling);
  conditions.push(...ceiling.conditions);
  params.push(...ceiling.params);

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
 * Drift/tamper DETECTOR for the live, top-level corpus. `memories_merkle_root`
 * is a sha256 over the SORTED per-memory leaf hashes (each binds id + scope +
 * access_level + content — see memoryLeafHash), so it is independent of
 * row/insertion order and changes iff any memory's identity, sensitivity, or
 * content changes (or one is added/removed/swapped). `generated_at` is supplied
 * by the caller — the builder never reads the system clock.
 *
 * NOT cryptographically tamper-PROOF on its own: the sidecar lives in the same
 * (git) tree as the .md files, so an attacker who can rewrite the vault can also
 * recompute the root. It detects accidental drift + catches tampering UNLESS the
 * attacker also rewrites the sidecar; the signed provenance envelope
 * (memory_verify, keyed off-vault) is the cryptographic authenticity layer.
 */
export interface IntegrityManifest {
  schema_version: number;
  total: number;
  /** sha256(hex) over the newline-joined, sorted per-memory content hashes. */
  memories_merkle_root: string;
  /** ISO-8601 timestamp passed in by the caller (never read from the clock). */
  generated_at: string;
}

/** The fields bound into a per-memory integrity leaf. */
export interface IntegrityLeaf {
  id: string;
  scope: string;
  access_level: string;
  content: string;
}

/**
 * Per-memory leaf hash for the integrity merkle. Binds the memory IDENTITY
 * (id), the SECURITY-relevant frontmatter (scope, access_level), and the
 * content — NUL-separated so no field-boundary shift can collide two leaves.
 * Binding id makes the merkle position/ownership-aware (a content-swap between
 * two vault files changes both leaves); binding access_level/scope makes a
 * frontmatter-only demotion (e.g. restricted→public) change the root. Content
 * has trailing whitespace stripped to match the vault round-trip
 * (`memoryToMarkdown`/`parseMemoryFile`), so a legitimate round-trip still
 * agrees and is never false-flagged.
 */
export function memoryLeafHash(leaf: IntegrityLeaf): string {
  const preimage = [leaf.id, leaf.scope, leaf.access_level, leaf.content.replace(/\s+$/, '')].join('\u0000');
  return createHash('sha256').update(preimage, 'utf-8').digest('hex');
}

/** sha256(hex) of a single memory's content (trailing-ws-stripped). Retained for
 *  callers that need a content-only digest; the integrity merkle uses
 *  {@link memoryLeafHash}, which also binds id/scope/access_level. */
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
  filter?: { scope?: string; namespace?: string },
): IntegrityManifest {
  // battle-v14 F1: on a namespace-forced deployment the manifest sidecar is
  // committed INTO the tenant's (git-shared) vault, so it must fingerprint ONLY
  // the tenant's corpus — an unscoped manifest leaks the global memory count and
  // a merkle root that moves whenever any other tenant writes. Unscoped (no
  // filter) is the single-user default and stays whole-corpus.
  const scope = scopeConditions(filter ?? {});
  const conditions = [...liveConditions({ topLevelOnly: true }), ...scope.conditions];
  const params: unknown[] = [...scope.params];
  const rows = db
    .prepare<unknown[], { id: string; scope: string; access_level: string; content: string }>(
      `SELECT id, scope, access_level, content FROM memories WHERE ${conditions.join(' AND ')}`,
    )
    .all(...params);

  const hashes = rows.map((r) => memoryLeafHash(r));

  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    total: hashes.length,
    memories_merkle_root: merkleRootFromHashes(hashes),
    generated_at: generatedAt,
  };
}
