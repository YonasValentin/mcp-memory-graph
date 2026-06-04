/**
 * M2.2 — Signed provenance envelope (the moat).
 *
 * Each memory can carry a tamper-evident envelope:
 *   - content_hash: sha256(content) hex
 *   - signature:    base64 ed25519 signature over the canonical JSON of the
 *                   signed fields (content_hash + selected metadata)
 *   - pubkey:       the signer's ed25519 public key (SPKI PEM)
 *   - signed_at:    a caller-supplied ISO timestamp (NEVER read from the clock
 *                   here, so signing stays deterministic and testable)
 *
 * The signing keypair is generated once per machine and persisted under
 * ~/.mcp-memory/keys with restrictive permissions (dir 0700, private key 0600).
 * Tests override the location via the MCP_MEMORY_KEY_DIR env var.
 *
 * Verification recomputes the hash, confirms it matches the stored content_hash,
 * then ed25519-verifies the signature against the same canonical JSON — yielding
 * one of: 'ok', 'unsigned', 'content_mismatch', 'bad_signature'.
 *
 * Dependency-free: uses only node: builtins.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The four signed metadata fields (besides content_hash) that bind provenance. */
export interface EnvelopeMeta {
  agent_id?: string | null;
  provenance?: string | null;
  scope?: string | null;
  namespace?: string | null;
  valid_from?: string | null;
  created_at?: string | null;
  /** When the envelope was signed. Covered by the signature (else it would be a
   *  forgeable "freshness" attribute on a signed row). */
  signed_at?: string | null;
}

/** The full set of fields covered by the signature (content_hash + meta). */
export type SignedFields = EnvelopeMeta & { content_hash?: string | null };

/** The envelope written onto a memory row. */
export interface SignedEnvelope {
  content_hash: string;
  signature: string;
  pubkey: string;
  signed_at: string;
}

/** A row (or partial row) presented for verification. */
export interface VerifiableRow extends EnvelopeMeta {
  content_hash?: string | null;
  signature?: string | null;
  pubkey?: string | null;
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: VerifyReason };
export type VerifyReason = 'unsigned' | 'content_mismatch' | 'bad_signature' | 'untrusted_key';

/** Resolve the directory holding the keypair (override via MCP_MEMORY_KEY_DIR). */
function keyDir(): string {
  const base = process.env.MCP_MEMORY_KEY_DIR ?? join(homedir(), '.mcp-memory');
  return join(base, 'keys');
}

/**
 * Lazily load (or, on first use, generate + persist) the per-machine ed25519
 * signing keypair. The private key is written 0600 inside a 0700 directory.
 */
export function getSigningKey(): { privateKeyPem: string; publicKeyPem: string } {
  const dir = keyDir();
  const keyPath = join(dir, 'ed25519.key');
  const pubPath = join(dir, 'ed25519.pub');

  if (existsSync(keyPath) && existsSync(pubPath)) {
    return {
      privateKeyPem: readFileSync(keyPath, 'utf8'),
      publicKeyPem: readFileSync(pubPath, 'utf8'),
    };
  }

  // mkdir the dir 0700 (recursive ensures parent ~/.mcp-memory exists too).
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  // mode on writeFileSync only applies when the file is created; passing it
  // makes the very first write land as 0600 without a follow-up chmod.
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(pubPath, publicKeyPem, { mode: 0o644 });

  return { privateKeyPem, publicKeyPem };
}

/**
 * Deterministic canonical JSON: keys sorted, `undefined` values omitted. This is
 * the exact byte string that is signed and verified — both sides must agree.
 */
export function canonicalize(fields: SignedFields): string {
  const keys = (Object.keys(fields) as (keyof SignedFields)[])
    .filter((k) => fields[k] !== undefined)
    .sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) {
    ordered[k] = fields[k];
  }
  return JSON.stringify(ordered);
}

/** sha256(content) as lowercase hex. */
function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Build the signed fields object from the content hash + metadata, normalizing
 * `null`/absent to `undefined` so canonicalize omits them — a row that stored
 * NULL must hash-canonicalize identically to one that signed with the field
 * absent.
 */
function signedFields(content_hash: string, meta: EnvelopeMeta): SignedFields {
  return {
    content_hash,
    agent_id: meta.agent_id ?? undefined,
    provenance: meta.provenance ?? undefined,
    scope: meta.scope ?? undefined,
    namespace: meta.namespace ?? undefined,
    valid_from: meta.valid_from ?? undefined,
    created_at: meta.created_at ?? undefined,
    signed_at: meta.signed_at ?? undefined,
  };
}

/**
 * Compare two SPKI public keys for EQUALITY of the key material, robust to PEM
 * whitespace/line-ending differences from a DB round-trip — by normalizing both
 * to DER bytes. Returns false on any parse error (an unparseable key is never
 * "trusted").
 */
function samePublicKey(a: string, b: string): boolean {
  try {
    const da = createPublicKey(a).export({ type: 'spki', format: 'der' });
    const db = createPublicKey(b).export({ type: 'spki', format: 'der' });
    return Buffer.isBuffer(da) && Buffer.isBuffer(db) && da.equals(db);
  } catch {
    return false;
  }
}

/**
 * Sign a memory's content + provenance metadata. `signed_at` is a REQUIRED ISO
 * string parameter — this function never reads the system clock, keeping the
 * output fully deterministic for a given (content, meta, signed_at).
 */
export function signEnvelope(
  content: string,
  meta: EnvelopeMeta,
  signed_at: string,
): SignedEnvelope {
  const { privateKeyPem, publicKeyPem } = getSigningKey();
  const content_hash = contentHash(content);
  // signed_at is folded into the SIGNED message (not just the returned object)
  // so it cannot be altered post-hoc on a "verified" row.
  const message = Buffer.from(canonicalize(signedFields(content_hash, { ...meta, signed_at })), 'utf8');
  const signature = edSign(null, message, createPrivateKey(privateKeyPem)).toString('base64');
  return { content_hash, signature, pubkey: publicKeyPem, signed_at };
}

/**
 * Verify a memory against its stored envelope. Distinguishes:
 *   - 'unsigned'         — no signature/pubkey on the row
 *   - 'content_mismatch' — sha256(content) ≠ stored content_hash (content edited)
 *   - 'untrusted_key'    — the row's pubkey is NOT this machine's signing key
 *                          (a re-sign-with-attacker-key forge): the envelope is
 *                          only self-consistent, not authentic
 *   - 'bad_signature'    — hash matches but the ed25519 signature does not verify
 *   - { ok: true }       — hash matches, key is the trust root, signature verifies
 *
 * TRUST ROOT: the signature is verified against `trustedPubkeyPem` (default: this
 * machine's signing key) and the row's embedded pubkey MUST equal it. Verifying
 * against the row's own pubkey alone is a self-consistency check, not an
 * authenticity check — anyone with table-write access (the export/sync/git-vault
 * threat model M2 targets) could rewrite content + re-sign with their own key.
 * (Multi-machine team vaults are a future extension: pass an allowlist member
 * here once a real trust store exists; today getSigningKey() is the only key.)
 */
export function verifyEnvelope(
  content: string,
  row: VerifiableRow,
  trustedPubkeyPem?: string,
): VerifyOutcome {
  if (!row.signature || !row.pubkey) {
    return { ok: false, reason: 'unsigned' };
  }

  const recomputed = contentHash(content);
  if (recomputed !== row.content_hash) {
    return { ok: false, reason: 'content_mismatch' };
  }

  const trusted = trustedPubkeyPem ?? getSigningKey().publicKeyPem;
  if (!samePublicKey(row.pubkey, trusted)) {
    return { ok: false, reason: 'untrusted_key' };
  }

  const message = Buffer.from(canonicalize(signedFields(recomputed, row)), 'utf8');
  let verified = false;
  try {
    verified = edVerify(
      null,
      message,
      createPublicKey(row.pubkey),
      Buffer.from(row.signature, 'base64'),
    );
  } catch {
    // Malformed key/signature → treat as a failed signature, not a crash.
    verified = false;
  }

  return verified ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
