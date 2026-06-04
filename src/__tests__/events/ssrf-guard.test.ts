import { describe, it, expect } from 'vitest';
import {
  assertSafeWebhookUrl,
  assertResolvedHostSafe,
  isBlockedHost,
  SsrfError,
} from '../../events/ssrf-guard.js';

describe('ssrf-guard: isBlockedHost', () => {
  it('blocks loopback, link-local, RFC1918, CGNAT, metadata', () => {
    for (const h of [
      '127.0.0.1',
      '127.5.5.5',
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '169.254.0.1',
      '100.64.0.1', // CGNAT
      '224.0.0.1', // multicast
      '240.0.0.1', // reserved
      '255.255.255.255',
    ]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const h of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1']) {
      expect(isBlockedHost(h), h).toBe(false);
    }
  });

  it('blocks octal/leading-zero IPv4 bypass forms', () => {
    // 010.0.0.1 could be parsed as octal 8.0.0.1 by some resolvers — refuse.
    expect(isBlockedHost('010.0.0.1')).toBe(true);
    expect(isBlockedHost('0177.0.0.1')).toBe(true);
  });

  it('blocks local names', () => {
    for (const h of ['localhost', 'foo.localhost', 'box.local', 'db.internal', 'host.lan']) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });

  it('blocks IPv6 loopback, ULA, link-local, multicast and mapped/translated v4', () => {
    for (const h of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1',
      '64:ff9b::169.254.169.254', // NAT64 to metadata
      '[fe80::1]',
    ]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isBlockedHost('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedHost('::ffff:8.8.8.8')).toBe(false);
  });

  // Regression — M3 battle finding #1/#3/#4: HEX-WORD embedded-IPv4 forms must be
  // blocked structurally, not just the dotted spelling. Node's URL parser
  // canonicalizes ::ffff:169.254.169.254 INTO ::ffff:a9fe:a9fe, so missing the
  // hex form is a real loopback/metadata SSRF bypass.
  it('blocks IPv4-mapped IPv6 in HEX-WORD form (the canonicalized bypass)', () => {
    expect(isBlockedHost('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isBlockedHost('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254 metadata
    expect(isBlockedHost('[::ffff:a9fe:a9fe]')).toBe(true);
    expect(isBlockedHost('::ffff:0a00:1')).toBe(true); // 10.0.0.1
    // public mapped stays allowed (8.8.8.8 = 0808:0808)
    expect(isBlockedHost('::ffff:808:808')).toBe(false);
  });

  it('blocks NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carrying a private v4', () => {
    expect(isBlockedHost('64:ff9b::7f00:1')).toBe(true); // NAT64 → 127.0.0.1
    expect(isBlockedHost('64:ff9b::a9fe:a9fe')).toBe(true); // NAT64 → metadata
    expect(isBlockedHost('2002:7f00:1::')).toBe(true); // 6to4 → 127.0.0.x
    expect(isBlockedHost('2002:a9fe:a9fe::')).toBe(true); // 6to4 → metadata
  });
});

describe('ssrf-guard: assertSafeWebhookUrl', () => {
  it('accepts a public https URL', () => {
    const u = assertSafeWebhookUrl('https://hooks.example.com/path?x=1');
    expect(u.hostname).toBe('hooks.example.com');
  });

  it('rejects non-http(s) schemes', () => {
    for (const u of ['ftp://example.com', 'file:///etc/passwd', 'gopher://x', 'data:text/plain,hi']) {
      expect(() => assertSafeWebhookUrl(u), u).toThrow(SsrfError);
    }
  });

  it('rejects private/loopback/metadata literal hosts', () => {
    for (const u of [
      'http://127.0.0.1:8080/x',
      'http://169.254.169.254/latest/meta-data',
      'http://192.168.1.5/hook',
      'http://[::1]:9000/x',
      'http://localhost/x',
    ]) {
      expect(() => assertSafeWebhookUrl(u), u).toThrow(SsrfError);
    }
  });

  it('rejects embedded credentials', () => {
    expect(() => assertSafeWebhookUrl('https://user:pass@example.com/x')).toThrow(SsrfError);
  });

  it('rejects malformed URLs', () => {
    expect(() => assertSafeWebhookUrl('not a url')).toThrow(SsrfError);
  });
});

describe('ssrf-guard: assertResolvedHostSafe (DNS rebinding defense)', () => {
  it('passes a public literal IP without DNS', async () => {
    const out = await assertResolvedHostSafe('1.1.1.1');
    expect(out).toEqual(['1.1.1.1']);
  });

  it('refuses a hostname that resolves to a private IP', async () => {
    const fakeLookup = async () => [{ address: '10.0.0.5' }];
    await expect(assertResolvedHostSafe('evil.example.com', fakeLookup)).rejects.toThrow(SsrfError);
  });

  it('refuses if ANY resolved address is private (mixed records)', async () => {
    const fakeLookup = async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }];
    await expect(assertResolvedHostSafe('mixed.example.com', fakeLookup)).rejects.toThrow(SsrfError);
  });

  it('accepts a hostname that resolves only to public IPs', async () => {
    const fakeLookup = async () => [{ address: '93.184.216.34' }];
    const out = await assertResolvedHostSafe('good.example.com', fakeLookup);
    expect(out).toEqual(['93.184.216.34']);
  });

  it('refuses when the host does not resolve', async () => {
    const fakeLookup = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertResolvedHostSafe('nope.example.com', fakeLookup)).rejects.toThrow(SsrfError);
  });

  it('refuses an empty resolution set', async () => {
    const fakeLookup = async () => [];
    await expect(assertResolvedHostSafe('empty.example.com', fakeLookup)).rejects.toThrow(SsrfError);
  });
});
