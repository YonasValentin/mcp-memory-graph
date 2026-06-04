/**
 * Regression tests for the M2 adversarial-battle findings (wf_7190770a). The
 * isolated TDD slices passed their own unit tests, but battle-testing the
 * INTEGRATED code found real defects: a forgeable trust attestation, a ReDoS,
 * redaction bypasses, a groundedness collapse, and two dead-code wirings
 * (egress filter + integrity manifest). Each test below would have caught the
 * corresponding bug; together they lock the fixes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { signEnvelope, verifyEnvelope } from '../provenance/envelope.js';
import { redactContent } from '../lib/redact-content.js';
import { computeGroundedness } from '../search/scoring.js';
import { buildIntegrityManifest } from '../tools/manifest.js';
import { writeManifestSidecar } from '../vault/sidecar.js';
import { createTestDb } from '../testing/test-db.js';
import { insertMemory } from '../db/repository.js';
import type { MemoryRow } from '../types.js';

const SIGNED_AT = '2026-06-04T00:00:00.000Z';
const META = { agent_id: 'a1', scope: 'global', namespace: null, valid_from: SIGNED_AT, created_at: SIGNED_AT };

let keyDir: string;
beforeAll(() => {
  keyDir = mkdtempSync(path.join(tmpdir(), 'm2h-keys-'));
  process.env.MCP_MEMORY_KEY_DIR = keyDir;
});
afterAll(() => {
  delete process.env.MCP_MEMORY_KEY_DIR;
  rmSync(keyDir, { recursive: true, force: true });
});

describe('M2.2 trust root — a re-sign-with-attacker-key forge is rejected', () => {
  it('swapping in an attacker pubkey → untrusted_key (not verified)', () => {
    const content = 'TRUSTED FACT: prod DB is db-1.example';
    const env = signEnvelope(content, META, SIGNED_AT);
    // Forge: keep the (self-consistent) content_hash + a signature, but present
    // an attacker-controlled pubkey. Pre-fix this verified because the row was
    // checked against its OWN embedded key.
    const attacker = generateKeyPairSync('ed25519');
    const attackerPub = attacker.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const forged = { ...env, ...META, pubkey: attackerPub };
    const res = verifyEnvelope(content, forged);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('untrusted_key');
  });

  it('a genuinely machine-signed row still verifies', () => {
    const content = 'legit signed memory';
    const env = signEnvelope(content, META, SIGNED_AT);
    const row = { ...env, ...META };
    expect(verifyEnvelope(content, row)).toEqual({ ok: true });
  });

  it('signed_at is now covered by the signature — tampering it fails verification', () => {
    const content = 'freshness matters';
    const env = signEnvelope(content, META, SIGNED_AT);
    const row = { ...env, ...META, signed_at: '1970-01-01T00:00:00.000Z' };
    const res = verifyEnvelope(content, row);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });
});

describe('M2.1 redaction — bypasses are closed', () => {
  it('detects a secret GLUED to a preceding word char (no leading \\b)', () => {
    const r = redactContent(`export MYKEY=sk-ant-${'a'.repeat(30)}`, 'scrub');
    expect(r.redactions).toBeGreaterThanOrEqual(1);
    expect(r.content).not.toContain('sk-ant-aaaa');
  });

  it('detects a secret with a zero-width char spliced inside the token', () => {
    const zwsp = '​';
    const smuggled = `ghp_${'a'.repeat(15)}${zwsp}${'b'.repeat(20)}`;
    expect(redactContent(smuggled, 'scrub').redactions).toBeGreaterThanOrEqual(1);
    expect(() => redactContent(smuggled, 'block')).toThrow();
  });

  it('preserves legitimate zero-width joiners when there is NO secret (no over-strip)', () => {
    const emoji = 'family: \u{1F468}‍\u{1F469}‍\u{1F467} ok';
    expect(redactContent(emoji, 'scrub')).toEqual({ content: emoji, redactions: 0, kinds: [] });
  });

  it('PEM ReDoS: many BEGIN markers with no END complete in linear time', () => {
    const evil = '-----BEGIN PRIVATE KEY-----\n'.repeat(20000); // ~560KB, no END
    const start = process.hrtime.bigint();
    const r = redactContent(evil, 'scrub');
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(r.redactions).toBe(0); // no closing marker → no match
    expect(ms).toBeLessThan(1000); // pre-fix this was multiple seconds (O(n^2))
  });
});

describe('M2.4 groundedness — a corrupt access_count does not collapse a max-trust memory', () => {
  it('non-finite access_count degrades to zero boost, not zero score', () => {
    const row = {
      confidence_score: 1,
      provenance: 'manual',
      created_at: SIGNED_AT,
      updated_at: SIGNED_AT,
      valid_to: null,
      access_count: Number.NaN,
    };
    const g = computeGroundedness(row, SIGNED_AT);
    expect(g.groundedness).toBeGreaterThan(0.6);
    expect(g.groundedness_level).toBe('high');
  });
});

describe('M2.6 integrity manifest — persisted + drift guard engages', () => {
  it('writeManifestSidecar persists .memory/manifest.json (was never written) + merkle is drift-sensitive', () => {
    const db = createTestDb();
    const now = SIGNED_AT;
    const row: MemoryRow = {
      id: 'mem-1', scope: 'global', namespace: null, title: 't', content: 'integrity body',
      document_type: null, source: null, author: null, department: null, tags: null,
      access_level: 'public', language: 'en', metadata: null, parent_id: null, chunk_index: null,
      version: 1, created_at: now, updated_at: now, expires_at: null, access_count: 0,
      last_accessed_at: null, importance_score: 0.5, confidence_score: 0.7, stability: 1.0,
    };
    insertMemory(db, row, new Float32Array(384));

    const vault = mkdtempSync(path.join(tmpdir(), 'm2h-vault-'));
    try {
      // Persist fix: production paths now write the sidecar that arms the rebuild
      // drift guard (it was dead code → guard dormant on every real vault).
      const written = writeManifestSidecar(db, vault, now);
      expect(written).not.toBeNull();
      expect(existsSync(path.join(vault, '.memory', 'manifest.json'))).toBe(true);

      // Drift-sensitivity: tampering content changes the merkle root, so the
      // persisted manifest no longer matches a tampered corpus.
      const before = buildIntegrityManifest(db, now).memories_merkle_root;
      db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('TAMPERED', 'mem-1');
      const after = buildIntegrityManifest(db, now).memories_merkle_root;
      expect(after).not.toBe(before);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      db.close();
    }
  });
});

describe('M2.5 egress filter — wired into the LIVE write paths (not dead code)', () => {
  // The unit tests prove the predicate; these source guards prove it is actually
  // CALLED on the live mirror + export paths (the dead-code gap that leaked
  // restricted memories into the git vault despite a passing unit test).
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('write-through mirrorMemoryWrite consults isEgressBlocked', () => {
    const src = read('../vault/write-through.ts');
    expect(src).toMatch(/isEgressBlocked\(memory, livePath\(memory\), getVaultEgress\(\)\)/);
  });

  it('exportMemoriesToVault routes writes through applyEgressFilter', () => {
    const src = read('../vault/writer.ts');
    expect(src).toContain('applyEgressFilter(vaultRoot, relPath, memoryToMarkdown(memory), memory, getVaultEgress())');
  });
});
