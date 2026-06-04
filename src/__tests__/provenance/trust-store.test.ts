/**
 * M2-LOW — multi-machine trust store. A memory signed by a TEAMMATE's key (e.g.
 * synced through a team git-vault) must verify when that key is in the allowlist
 * (MCP_TRUSTED_PUBKEYS file paths, an inline allowlist, or memory_verify's
 * trusted_pubkeys param), and read 'untrusted' otherwise — never 'tampered'
 * (a foreign-but-valid signer is not a content forge).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  signEnvelope,
  verifyEnvelope,
  verifyEnvelopeAny,
  getSigningKey,
} from '../../provenance/envelope.js';

let dirA: string; // "teammate" machine
let dirB: string; // "this" machine
const orig = process.env.MCP_MEMORY_KEY_DIR;

beforeEach(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-keyA-'));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-keyB-'));
});
afterEach(() => {
  if (orig === undefined) delete process.env.MCP_MEMORY_KEY_DIR;
  else process.env.MCP_MEMORY_KEY_DIR = orig;
  delete process.env.MCP_TRUSTED_PUBKEYS;
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

describe('multi-machine trust store', () => {
  it('a teammate-signed row is untrusted by default but verifies when allowlisted', () => {
    const content = 'A team decision recorded on the teammate machine.';
    const meta = { agent_id: 'mate', scope: 'project', namespace: 'team', created_at: '2026-06-04T00:00:00.000Z', valid_from: '2026-06-04T00:00:00.000Z' };

    // Sign as the TEAMMATE (key dir A).
    process.env.MCP_MEMORY_KEY_DIR = dirA;
    const env = signEnvelope(content, meta, '2026-06-04T00:00:00.000Z');
    const teammatePub = getSigningKey().publicKeyPem;

    const row = { ...meta, content_hash: env.content_hash, signature: env.signature, pubkey: env.pubkey, signed_at: env.signed_at };

    // Switch to THIS machine (key dir B). Default trust = own key only.
    process.env.MCP_MEMORY_KEY_DIR = dirB;
    const def = verifyEnvelopeAny(content, row);
    expect(def.ok).toBe(false);
    if (!def.ok) expect(def.reason).toBe('untrusted_key');

    // Single-key verifyEnvelope against the row's own key is self-consistent but
    // still not authentic vs THIS machine's root.
    expect(verifyEnvelope(content, row).ok).toBe(false);

    // With the teammate key in the allowlist → verified.
    const ok = verifyEnvelopeAny(content, row, [getSigningKey().publicKeyPem, teammatePub]);
    expect(ok.ok).toBe(true);
  });

  it('content edits still beat the allowlist (content_mismatch wins)', () => {
    const meta = { scope: 'project', created_at: '2026-06-04T00:00:00.000Z', valid_from: '2026-06-04T00:00:00.000Z' };
    process.env.MCP_MEMORY_KEY_DIR = dirA;
    const env = signEnvelope('original', meta, '2026-06-04T00:00:00.000Z');
    const teammatePub = getSigningKey().publicKeyPem;
    const row = { ...meta, content_hash: env.content_hash, signature: env.signature, pubkey: env.pubkey, signed_at: env.signed_at };

    const out = verifyEnvelopeAny('TAMPERED', row, [teammatePub]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('content_mismatch');
  });
});
