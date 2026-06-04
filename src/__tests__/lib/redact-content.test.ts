/**
 * Tests for the inbound secret/poison redaction gate (M2.1).
 *
 * Memory content is UNTRUSTED and frequently pasted/ingested from terminals,
 * chat transcripts, config files, and CI logs — so it routinely carries live
 * credentials (API keys, tokens, private keys, password assignments). Storing
 * those verbatim turns the memory store into a secret-exfiltration target. The
 * redaction gate runs at the INBOUND boundary, before embedding/persistence:
 *
 *   - 'scrub'  — replace each match with a typed placeholder, return the count.
 *   - 'block'  — if any secret is present, throw naming the kinds (reject write).
 *   - 'off'    — passthrough; count 0 (preserves current behaviour by default).
 *
 * Patterns are anchored + length-bounded to avoid corrupting ordinary prose.
 */
import { describe, it, expect } from 'vitest';
import { redactContent, REDACTION_PATTERNS } from '../../lib/redact-content.js';

describe('redactContent — whitespace-split defense (M2-LOW)', () => {
  it('catches an AWS key wrapped by a space or newline (terminal/email wrap)', () => {
    for (const split of [' ', '\n', '\r\n', '\t']) {
      const r = redactContent(`creds: AKIAIOSFODNN${split}7EXAMPLE done`, 'scrub');
      expect(r.redactions, JSON.stringify(split)).toBe(1);
      expect(r.kinds).toEqual(['aws_access_key']);
      expect(r.content).not.toContain('AKIA');
      expect(r.content).not.toContain('7EXAMPLE');
    }
  });

  it('catches a github token split across a newline', () => {
    const tok = 'ghp_' + 'a'.repeat(15) + '\n' + 'b'.repeat(15);
    const r = redactContent(`token=${tok}`, 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.kinds).toEqual(['github_token']);
  });

  it('blocks a split secret in block mode', () => {
    expect(() => redactContent('AKIAIOSFODNN\n7EXAMPLE', 'block')).toThrow(/aws_access_key/);
  });

  it('does NOT false-positive on all-caps prose with spaces (AKIA-like)', () => {
    // "AKIA" is a rare sigil, but ensure ordinary uppercase headings never match.
    const r = redactContent('THE NORTH AMERICA REGION TODO LIST FOR Q3 PLANNING', 'scrub');
    expect(r.redactions).toBe(0);
  });

  it('does NOT false-positive on multi-word prose that contains the literal AKIA sigil', () => {
    // The collapsed scan would glue "AKIA NORTH AMERICA US WEST 2 PLAN" into an
    // AKIA+16 shape — but that span has MANY whitespace gaps, not the ONE wrap
    // point a real wrapped credential has, so it must be rejected.
    const r = redactContent('AKIA NORTH AMERICA US WEST 2 PLAN AND MORE WORDS HERE', 'scrub');
    expect(r.redactions).toBe(0);
    expect(r.content).toContain('NORTH AMERICA'); // prose left intact
  });

  it('does NOT bridge whitespace for prose-adjacent sigils (sk-/bearer excluded)', () => {
    // "ask- " + a long word must not glue into an sk- key; "bearer of" must not match.
    const r1 = redactContent('please ask- someverylongwordwithtwentychars here', 'scrub');
    expect(r1.kinds).not.toContain('openai_key');
    const r2 = redactContent('the bearer of twentycharslongnews tonight', 'scrub');
    expect(r2.kinds).not.toContain('bearer_token');
  });
});

describe('redactContent — pattern detection (scrub mode)', () => {
  it('redacts an OpenAI sk- key', () => {
    const r = redactContent('key is sk-abcdEFGH1234abcdEFGH5678abcdEFGH1234abcdT3BlbkFJ here', 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.kinds).toEqual(['openai_key']);
    expect(r.content).toContain('[REDACTED:openai_key]');
    expect(r.content).not.toMatch(/sk-abcd/);
  });

  it('redacts an Anthropic sk-ant- key as openai_key family', () => {
    const r = redactContent('use sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ now', 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.content).toContain('[REDACTED:openai_key]');
    expect(r.content).not.toContain('sk-ant-api03');
  });

  it('redacts GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)', () => {
    const r = redactContent('token ghp_1234567890abcdefghijABCDEFGHIJ1234abcd done', 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.kinds).toEqual(['github_token']);
    expect(r.content).toContain('[REDACTED:github_token]');
    expect(r.content).not.toContain('ghp_1234');
  });

  it('redacts an AWS access key id', () => {
    const r = redactContent('aws id AKIAIOSFODNN7EXAMPLE end', 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.kinds).toEqual(['aws_access_key']);
    expect(r.content).toContain('[REDACTED:aws_access_key]');
    expect(r.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts a Bearer token', () => {
    const r = redactContent('Authorization: Bearer abcDEF123456ghiJKL789mnoPQR0stuVWX', 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.kinds).toEqual(['bearer_token']);
    expect(r.content).toContain('[REDACTED:bearer_token]');
    expect(r.content).not.toContain('abcDEF123456');
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const r = redactContent(`session token ${jwt} expires soon`, 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.kinds).toEqual(['jwt']);
    expect(r.content).toContain('[REDACTED:jwt]');
    expect(r.content).not.toContain('eyJhbGci');
  });

  it('redacts a PEM private-key block including its body', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234abcd\nWXYZ5678efgh\n-----END RSA PRIVATE KEY-----';
    const r = redactContent(`here is the key:\n${pem}\nthanks`, 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.kinds).toEqual(['private_key']);
    expect(r.content).toContain('[REDACTED:private_key]');
    expect(r.content).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(r.content).not.toContain('MIIEpAIBAAKCAQEA');
    // surrounding prose preserved
    expect(r.content).toContain('here is the key:');
    expect(r.content).toContain('thanks');
  });

  it('redacts password= / api_key= / *_secret= assignments', () => {
    const r = redactContent('password=hunter2longenough api_key=abcd1234efgh5678 db_secret=topSecretValue9', 'scrub');
    expect(r.redactions).toBe(3);
    expect(r.kinds.sort()).toEqual(['secret_assignment', 'secret_assignment', 'secret_assignment']);
    expect(r.content).toContain('[REDACTED:secret_assignment]');
    expect(r.content).not.toContain('hunter2longenough');
    expect(r.content).not.toContain('abcd1234efgh5678');
    expect(r.content).not.toContain('topSecretValue9');
  });

  it('redacts multiple distinct secrets and reports each kind', () => {
    const text =
      'ghp_1234567890abcdefghijABCDEFGHIJ1234abcd and AKIAIOSFODNN7EXAMPLE';
    const r = redactContent(text, 'scrub');
    expect(r.redactions).toBe(2);
    expect(r.kinds.sort()).toEqual(['aws_access_key', 'github_token']);
  });
});

describe('redactContent — false-positive resistance', () => {
  it('leaves ordinary prose untouched (0 redactions)', () => {
    const prose =
      'We discussed the password policy and decided the API key rotation cadence should be quarterly. ' +
      'The bearer of bad news is rarely thanked. Ship it.';
    const r = redactContent(prose, 'scrub');
    expect(r.redactions).toBe(0);
    expect(r.kinds).toEqual([]);
    expect(r.content).toBe(prose);
  });

  it('does not flag short/empty assignments or natural sentences', () => {
    const r = redactContent('set password to something memorable; the api_key is rotated', 'scrub');
    expect(r.redactions).toBe(0);
    expect(r.content).toBe('set password to something memorable; the api_key is rotated');
  });

  it('does not flag the bare word Bearer in prose', () => {
    const r = redactContent('The flag bearer led the parade.', 'scrub');
    expect(r.redactions).toBe(0);
  });

  it('does not flag sk- or AKIA fragments that are too short', () => {
    const r = redactContent('the suffix sk-foo and prefix AKIA are common', 'scrub');
    expect(r.redactions).toBe(0);
  });
});

describe('redactContent — modes', () => {
  it("'off' passes through unchanged with 0 redactions even with secrets present", () => {
    const text = 'ghp_1234567890abcdefghijABCDEFGHIJ1234abcd';
    const r = redactContent(text, 'off');
    expect(r.redactions).toBe(0);
    expect(r.kinds).toEqual([]);
    expect(r.content).toBe(text);
  });

  it("'block' throws naming the kinds when a secret is present", () => {
    const text = 'leak ghp_1234567890abcdefghijABCDEFGHIJ1234abcd';
    expect(() => redactContent(text, 'block')).toThrow(/github_token/);
  });

  it("'block' throws listing multiple distinct kinds", () => {
    const text = 'ghp_1234567890abcdefghijABCDEFGHIJ1234abcd AKIAIOSFODNN7EXAMPLE';
    let err: Error | undefined;
    try {
      redactContent(text, 'block');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('aws_access_key');
    expect(err?.message).toContain('github_token');
  });

  it("'block' does NOT throw on clean prose and returns it unchanged", () => {
    const prose = 'just a normal note about deployment timing';
    const r = redactContent(prose, 'block');
    expect(r.redactions).toBe(0);
    expect(r.content).toBe(prose);
  });
});

describe('redactContent — unicode / ZWJ safety', () => {
  it('does not corrupt emoji ZWJ sequences or non-Latin prose', () => {
    const text = 'familie 👨‍👩‍👧 og flag 🏳️‍🌈 og می‌خواهم og 日本語';
    const r = redactContent(text, 'scrub');
    expect(r.redactions).toBe(0);
    expect(r.content).toBe(text);
  });

  it('redacts a secret embedded next to unicode without mangling the unicode', () => {
    const text = '日本語 ghp_1234567890abcdefghijABCDEFGHIJ1234abcd 👍';
    const r = redactContent(text, 'scrub');
    expect(r.redactions).toBe(1);
    expect(r.content).toContain('日本語');
    expect(r.content).toContain('👍');
    expect(r.content).toContain('[REDACTED:github_token]');
  });
});

describe('REDACTION_PATTERNS export', () => {
  it('is a non-empty array of { kind, regex } with global, ReDoS-safe regexes', () => {
    expect(Array.isArray(REDACTION_PATTERNS)).toBe(true);
    expect(REDACTION_PATTERNS.length).toBeGreaterThan(0);
    for (const p of REDACTION_PATTERNS) {
      expect(typeof p.kind).toBe('string');
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(p.regex.flags).toContain('g');
    }
  });
});
