import type Database from 'better-sqlite3';
import { liveConditions, scopeConditions } from '../db/predicates.js';
import { verifyEnvelopeAny, trustedPubkeys } from '../provenance/envelope.js';

/** A single memory's verification outcome. */
export interface VerifyEntry {
  id: string;
  status: 'verified' | 'unsigned' | 'tampered' | 'untrusted';
}

/** Aggregate counts across the inspected memories. */
export interface VerifySummary {
  verified: number;
  unsigned: number;
  tampered: number;
  /** Signed by a key that is NOT this machine's trust root (e.g. a teammate's
   *  key on a synced vault). Distinct from 'tampered' — a foreign-but-valid
   *  signer is not a content forge. */
  untrusted: number;
}

export interface VerifyResult {
  results: VerifyEntry[];
  summary: VerifySummary;
}

/** Shape of the columns selected for verification. */
interface VerifyRow {
  id: string;
  content: string;
  content_hash: string | null;
  signature: string | null;
  pubkey: string | null;
  agent_id: string | null;
  provenance: string | null;
  scope: string | null;
  namespace: string | null;
  valid_from: string | null;
  created_at: string;
  signed_at: string | null;
}

const SELECT_COLS =
  'id, content, content_hash, signature, pubkey, agent_id, provenance, scope, namespace, valid_from, created_at, signed_at';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * M2.2 — memory_verify (read-only).
 *
 * Re-derives each memory's content_hash from the stored content and ed25519-
 * verifies its signature against the canonical provenance JSON, then buckets each
 * memory into one of three statuses:
 *   - 'verified' — hash matches and the signature verifies under the row's pubkey
 *   - 'unsigned' — no signature/pubkey on the row (nothing to attest)
 *   - 'tampered' — signed, but the content was edited (content_mismatch) or the
 *                  signature/metadata was forged (bad_signature)
 *
 * Verify a single memory by `id`, or a batch filtered by scope/namespace and
 * capped by `limit`. Batch mode only inspects currently-live rows (valid_to /
 * tx_expired NULL) so the report agrees with what memory_search/get surface.
 * Read-only: it issues a single SELECT and never mutates the store.
 */
export function handleVerify(
  db: Database.Database,
  input: { id?: string; scope?: string; namespace?: string; limit?: number; trusted_pubkeys?: string[] },
): VerifyResult {
  // Trust allowlist (M2-LOW): own key + MCP_TRUSTED_PUBKEYS files + any PEM keys
  // passed inline on this call. A teammate's valid signature on a synced vault
  // then reads 'verified' instead of 'untrusted'.
  const allowlist = [...trustedPubkeys(), ...(input.trusted_pubkeys ?? [])];
  let rows: VerifyRow[];

  if (input.id !== undefined) {
    rows = db
      .prepare<[string], VerifyRow>(`SELECT ${SELECT_COLS} FROM memories WHERE id = ?`)
      .all(input.id);
  } else {
    const scope = scopeConditions({ scope: input.scope, namespace: input.namespace });
    const conditions = [...liveConditions(), ...scope.conditions];
    const where = `WHERE ${conditions.join(' AND ')}`;
    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    rows = db
      .prepare<unknown[], VerifyRow>(
        `SELECT ${SELECT_COLS} FROM memories ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...scope.params, limit);
  }

  const results: VerifyEntry[] = [];
  const summary: VerifySummary = { verified: 0, unsigned: 0, tampered: 0, untrusted: 0 };

  for (const row of rows) {
    const outcome = verifyEnvelopeAny(row.content, {
      content_hash: row.content_hash,
      signature: row.signature,
      pubkey: row.pubkey,
      agent_id: row.agent_id,
      // provenance is INTENTIONALLY excluded from the signed envelope: it is
      // mutated after insert (e.g. reflect stamps provenance='reflection' on an
      // already-stored insight), which would otherwise false-flag the row as
      // tampered. Identity is bound by content_hash + agent_id + scope +
      // namespace + valid_from + created_at, which are stable at insert.
      provenance: undefined,
      scope: row.scope,
      namespace: row.namespace,
      valid_from: row.valid_from,
      created_at: row.created_at,
      signed_at: row.signed_at,
    }, allowlist);

    let status: VerifyEntry['status'];
    if (outcome.ok) {
      status = 'verified';
      summary.verified += 1;
    } else if (outcome.reason === 'unsigned') {
      status = 'unsigned';
      summary.unsigned += 1;
    } else if (outcome.reason === 'untrusted_key') {
      // Signed, but by a key that is not this machine's trust root (e.g. a
      // teammate's key on a synced vault). NOT a content forge — report it as
      // its own status rather than conflating it with 'tampered'.
      status = 'untrusted';
      summary.untrusted += 1;
    } else {
      // content_mismatch | bad_signature — the attestation no longer holds.
      status = 'tampered';
      summary.tampered += 1;
    }
    results.push({ id: row.id, status });
  }

  return { results, summary };
}
