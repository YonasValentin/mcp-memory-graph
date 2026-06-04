/**
 * M2.2 — Signed provenance envelope (the moat).
 *
 * A memory carries a tamper-evident envelope: a sha256 content_hash plus an
 * ed25519 signature over the canonical (key-sorted, undefined-omitted) JSON of
 * the signed fields. The signing key is a per-machine ed25519 keypair persisted
 * under ~/.mcp-memory/keys with 0600/0700 perms (override via MCP_MEMORY_KEY_DIR).
 *
 * Verification recomputes the hash, confirms it matches the stored content_hash,
 * then ed25519-verifies the signature against the same canonical JSON. The four
 * outcomes are distinguished: 'ok', 'unsigned' (no signature), 'content_mismatch'
 * (content edited after signing), and 'bad_signature' (signature/hash forged).
 *
 * Determinism: signEnvelope takes signed_at as an ISO-string PARAMETER — it never
 * reads the system clock — so the same inputs always produce the same envelope.
 *
 * Uses MCP_MEMORY_KEY_DIR pointed at a fresh mkdtemp dir so tests never touch the
 * real ~/.mcp-memory and never download anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getSigningKey,
  canonicalize,
  signEnvelope,
  verifyEnvelope,
} from '../../provenance/envelope.js';

const SIGNED_AT = '2026-06-04T10:00:00.000Z';
const META = {
  agent_id: 'agent-007',
  provenance: 'manual',
  scope: 'project',
  namespace: 'demo',
  valid_from: '2026-06-04T09:00:00.000Z',
  created_at: '2026-06-04T09:00:00.000Z',
};

let keyDir: string;
const prevKeyDir = process.env.MCP_MEMORY_KEY_DIR;

beforeEach(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'mcp-mem-keys-'));
  process.env.MCP_MEMORY_KEY_DIR = keyDir;
});

afterEach(() => {
  if (prevKeyDir === undefined) {
    delete process.env.MCP_MEMORY_KEY_DIR;
  } else {
    process.env.MCP_MEMORY_KEY_DIR = prevKeyDir;
  }
  rmSync(keyDir, { recursive: true, force: true });
});

describe('canonicalize', () => {
  it('produces deterministic key-sorted JSON regardless of input key order', () => {
    const a = canonicalize({ scope: 'project', agent_id: 'x', content_hash: 'h' });
    const b = canonicalize({ content_hash: 'h', agent_id: 'x', scope: 'project' });
    expect(a).toBe(b);
    // keys appear in sorted order
    expect(a).toBe('{"agent_id":"x","content_hash":"h","scope":"project"}');
  });

  it('omits undefined fields (so an absent namespace is not signed as null)', () => {
    const out = canonicalize({ content_hash: 'h', namespace: undefined, scope: 'global' });
    expect(out).toBe('{"content_hash":"h","scope":"global"}');
  });
});

describe('getSigningKey', () => {
  it('lazily generates an ed25519 keypair persisted with 0600 perms in a 0700 dir', () => {
    const { privateKeyPem, publicKeyPem } = getSigningKey();
    expect(privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(publicKeyPem).toContain('BEGIN PUBLIC KEY');

    const keyPath = join(keyDir, 'keys', 'ed25519.key');
    const pubPath = join(keyDir, 'keys', 'ed25519.pub');
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(pubPath)).toBe(true);

    // Private key file is 0600; containing dir is 0700.
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(keyDir, 'keys')).mode & 0o777).toBe(0o700);
  });

  it('reuses the persisted key on subsequent calls (stable pubkey)', () => {
    const first = getSigningKey();
    const second = getSigningKey();
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
  });
});

describe('signEnvelope / verifyEnvelope', () => {
  it('sign then verify the same content → ok', () => {
    const content = 'the deploy key rotates every 90 days';
    const env = signEnvelope(content, META, SIGNED_AT);

    expect(env.signed_at).toBe(SIGNED_AT);
    expect(env.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(env.pubkey).toContain('BEGIN PUBLIC KEY');
    expect(env.signature.length).toBeGreaterThan(0);

    const row = { content_hash: env.content_hash, signature: env.signature, pubkey: env.pubkey, ...META, signed_at: env.signed_at };
    const res = verifyEnvelope(content, row);
    expect(res).toEqual({ ok: true });
  });

  it('is deterministic — same content + meta + signed_at yields the same envelope', () => {
    const content = 'deterministic envelope';
    const a = signEnvelope(content, META, SIGNED_AT);
    const b = signEnvelope(content, META, SIGNED_AT);
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.signature).toBe(b.signature);
  });

  it('content edited after signing → content_mismatch', () => {
    const content = 'original content';
    const env = signEnvelope(content, META, SIGNED_AT);
    const row = { content_hash: env.content_hash, signature: env.signature, pubkey: env.pubkey, ...META, signed_at: env.signed_at };

    const res = verifyEnvelope('tampered content', row);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('content_mismatch');
  });

  it('flipped signature byte → bad_signature', () => {
    const content = 'sign me';
    const env = signEnvelope(content, META, SIGNED_AT);

    // Flip one base64 char of the signature (keep the hash correct so we reach
    // the signature-verification step rather than failing on the hash).
    const buf = Buffer.from(env.signature, 'base64');
    buf[0] ^= 0xff;
    const tamperedSig = buf.toString('base64');

    const row = { content_hash: env.content_hash, signature: tamperedSig, pubkey: env.pubkey, ...META, signed_at: env.signed_at };
    const res = verifyEnvelope(content, row);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad_signature');
  });

  it('meta changed after signing (provenance forged) → bad_signature', () => {
    const content = 'provenance bound to signature';
    const env = signEnvelope(content, META, SIGNED_AT);
    // Same content (hash matches) but a forged provenance value — the canonical
    // JSON differs, so the signature must no longer verify.
    const row = {
      content_hash: env.content_hash,
      signature: env.signature,
      pubkey: env.pubkey,
      ...META,
      signed_at: env.signed_at,
      provenance: 'reflection',
    };
    const res = verifyEnvelope(content, row);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad_signature');
  });

  it('row with no signature → unsigned', () => {
    const content = 'never signed';
    const row = { content_hash: null, signature: null, pubkey: null, ...META };
    const res = verifyEnvelope(content, row);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unsigned');
  });
});
