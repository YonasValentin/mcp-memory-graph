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
import { redactContent, redactRecord } from '../lib/redact-content.js';
import { computeGroundedness } from '../search/scoring.js';
import { buildIntegrityManifest, memoryLeafHash } from '../tools/manifest.js';
import { writeManifestSidecar } from '../vault/sidecar.js';
import { createTestDb } from '../testing/test-db.js';
import { insertMemory, updateMemory } from '../db/repository.js';
import { handleVerify } from '../tools/verify.js';
import type { MemoryRow } from '../types.js';

function memRow(id: string, content: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id, scope: 'global', namespace: null, title: null, content,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null, parent_id: null, chunk_index: null,
    version: 1, created_at: '2026-06-04T00:00:00.000Z', updated_at: '2026-06-04T00:00:00.000Z',
    expires_at: null, access_count: 0, last_accessed_at: null, importance_score: 0.5,
    confidence_score: 0.7, stability: 1.0, ...over,
  };
}

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

  // Self-calibrating linearity guards (machine-independent). The previous absolute
  // wall-clock ceilings (4s) flaked: the large inputs take multiple seconds even on
  // idle Apple Silicon, and shared CI runners (Windows/macOS GitHub-hosted) are
  // slower still. Instead we time a SMALL input and the 10×-LARGE input on the SAME
  // machine and assert the ratio. Linear scaling → ~10×; the pre-fix O(n^2) → ~100×.
  // A 30× bound sits safely between. The small baseline is the median of 3 runs
  // (single samples showed ~3× GC/scheduler jitter) and is floored so timer noise
  // on a fast machine can't shrink the denominator toward 0. A very generous
  // absolute ceiling remains purely as a hang-stop, not a perf bar.
  const SMALL_TO_LARGE_RATIO_BOUND = 30; // linear ≈10×, pre-fix quadratic ≈100×
  const BASELINE_FLOOR_MS = 50; // denominator floor against timer/JIT noise
  const HANG_STOP_MS = 60_000; // only catches a real hang/catastrophic blowup
  const timeMs = (fn: () => void): number => {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  const medianOf3 = (fn: () => void): number =>
    [timeMs(fn), timeMs(fn), timeMs(fn)].sort((a, b) => a - b)[1];

  it('PEM ReDoS: many BEGIN markers with no END scale linearly (small→10× input)', () => {
    const small = '-----BEGIN PRIVATE KEY-----\n'.repeat(2000); // ~56KB, no END
    const large = '-----BEGIN PRIVATE KEY-----\n'.repeat(20000); // ~560KB, no END
    // Warm-up (absorbs first-call JIT/regex lazy-compile cost) + functional check.
    expect(redactContent(small, 'scrub').redactions).toBe(0);
    const smallMs = medianOf3(() => { redactContent(small, 'scrub'); });
    let r!: ReturnType<typeof redactContent>;
    // Median the large sample too — a single GC pause on a shared CI runner
    // showed up to ~1.7x inflation on one sample (fix-breaker measurement).
    const largeMs = medianOf3(() => { r = redactContent(large, 'scrub'); });
    expect(r.redactions).toBe(0); // no closing marker → no match
    // The bounded {0,8192} PEM body keeps this linear; a re-introduced unbounded
    // backtrack scales quadratically and blows the ratio by an order of magnitude.
    expect(largeMs).toBeLessThan(SMALL_TO_LARGE_RATIO_BOUND * Math.max(smallMs, BASELINE_FLOOR_MS));
    expect(largeMs).toBeLessThan(HANG_STOP_MS);
  });

  it('secret_assignment ReDoS: a long alnum run scales linearly (bounded prefix)', () => {
    const small = 'a'.repeat(100_000);
    const large = 'a'.repeat(1_000_000); // schema-legal; pre-fix O(n^2) → ~minutes
    // Warm-up (absorbs first-call JIT/regex lazy-compile cost) + functional check.
    expect(redactContent(small, 'scrub').redactions).toBe(0);
    const smallMs = medianOf3(() => { redactContent(small, 'scrub'); });
    let r!: ReturnType<typeof redactContent>;
    const largeMs = medianOf3(() => { r = redactContent(large, 'scrub'); });
    expect(r.redactions).toBe(0);
    // The bounded {0,64} `_secret` prefix keeps this linear over 1M chars; the
    // pre-fix unbounded prefix rescanned the run per position (O(n^2) → ~100×).
    expect(largeMs).toBeLessThan(SMALL_TO_LARGE_RATIO_BOUND * Math.max(smallMs, BASELINE_FLOOR_MS));
    expect(largeMs).toBeLessThan(HANG_STOP_MS);
  });

  it('lowercase "bearer" scheme is detected (case-insensitive)', () => {
    expect(redactContent(`authorization: bearer ${'x'.repeat(30)}`, 'scrub').redactions).toBeGreaterThanOrEqual(1);
  });

  it('redactRecord gates secrets in metadata leaves (not just content)', () => {
    const r = redactRecord(
      { content: 'clean', metadata: { nested: { token: `ghp_${'a'.repeat(36)}` } } },
      'scrub',
    );
    expect(r.redactions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.metadata)).not.toContain('ghp_aaaa');
    expect(() => redactRecord({ content: 'clean', metadata: { k: `sk-${'a'.repeat(30)}` } }, 'block')).toThrow();
  });
});

describe('M2 round-2 — trust-signal correctness (signed-row lifecycle)', () => {
  let keyDir2: string;
  beforeAll(() => {
    keyDir2 = mkdtempSync(path.join(tmpdir(), 'm2h2-keys-'));
    process.env.MCP_MEMORY_KEY_DIR = keyDir2;
    process.env.MCP_SIGN_MEMORIES = '1';
  });
  afterAll(() => {
    delete process.env.MCP_SIGN_MEMORIES;
    process.env.MCP_MEMORY_KEY_DIR = keyDir; // restore outer
    rmSync(keyDir2, { recursive: true, force: true });
  });

  it('a legitimate updateMemory re-signs → stays "verified" (not "tampered")', () => {
    const db = createTestDb();
    try {
      insertMemory(db, memRow('u1', 'original signed content'), new Float32Array(384));
      expect(handleVerify(db, { id: 'u1' }).summary.verified).toBe(1);
      updateMemory(db, 'u1', { content: 'legitimately edited content' }, new Float32Array(384));
      const after = handleVerify(db, { id: 'u1' }).summary;
      expect(after.verified).toBe(1);
      expect(after.tampered).toBe(0);
    } finally {
      db.close();
    }
  });

  it('a direct-DB content forge (no re-sign) still reports "tampered"', () => {
    const db = createTestDb();
    try {
      insertMemory(db, memRow('u2', 'signed content'), new Float32Array(384));
      db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('FORGED', 'u2');
      expect(handleVerify(db, { id: 'u2' }).summary.tampered).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('M2.6 merkle leaf binding — frontmatter demotion + content-swap change the root', () => {
  it('access_level demotion changes the leaf hash (not content-only)', () => {
    const a = memoryLeafHash({ id: 'x', scope: 'global', access_level: 'restricted', content: 'secret' });
    const b = memoryLeafHash({ id: 'x', scope: 'global', access_level: 'public', content: 'secret' });
    expect(a).not.toBe(b);
  });
  it('content-swap between two ids changes both leaves (id-bound)', () => {
    const a1 = memoryLeafHash({ id: 'id-1', scope: 'global', access_level: 'public', content: 'A' });
    const a1swapped = memoryLeafHash({ id: 'id-1', scope: 'global', access_level: 'public', content: 'B' });
    expect(a1).not.toBe(a1swapped);
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
    // RBAC battle F4: the configured vault egress cap is now intersected with the
    // caller principal's access ceiling (the more restrictive of the two wins)
    // before applyEgressFilter sees it — so the live export path still consults
    // the egress filter, with the per-request ceiling folded in.
    expect(src).toContain(
      'applyEgressFilter(vaultRoot, relPath, memoryToMarkdown(memory), memory, intersectEgressWithCeiling(getVaultEgress(), opts.accessCeiling))',
    );
  });
});
