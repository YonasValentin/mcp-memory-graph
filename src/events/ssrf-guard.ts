import dns from 'node:dns/promises';

/**
 * SSRF guard for the webhook event bus (M3.1).
 *
 * Webhooks are the FIRST outbound network egress in an otherwise local-first,
 * zero-cloud server. An attacker who can register a target (or poison a stored
 * URL) could otherwise make the server POST to `http://169.254.169.254/…`
 * (cloud metadata), `http://127.0.0.1:…` (loopback admin panels), or internal
 * RFC-1918 hosts — classic server-side request forgery. This module is the
 * single chokepoint that refuses any URL whose host is private, loopback,
 * link-local, or otherwise non-public, at BOTH registration time (literal IPs /
 * obvious names) and dispatch time (after DNS resolution, to defeat a hostname
 * that resolves to a private address).
 *
 * Dependency-free, no allow-list of "good" hosts — the policy is "public
 * unicast only". Redirects are handled by the dispatcher (manual, never
 * followed) so a 302 → internal host cannot bypass this.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Parse a dotted-quad IPv4 string to a 32-bit unsigned int, or null. */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const octets = m.slice(1).map((o) => Number(o));
  if (octets.some((o) => o > 255)) return null;
  // Reject non-canonical leading zeros (e.g. 010.0.0.1) — they can be parsed as
  // octal by some resolvers, a known SSRF bypass.
  for (const o of m.slice(1)) {
    if (o.length > 1 && o.startsWith('0')) return null;
  }
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

/** True if a 32-bit IPv4 falls in any non-public (private/reserved) range. */
function isPrivateIpv4(n: number): boolean {
  const inRange = (base: string, prefix: number): boolean => {
    const baseInt = ipv4ToInt(base)!;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (n & mask) === (baseInt & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // RFC1918
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local incl. 169.254.169.254 metadata
    inRange('172.16.0.0', 12) || // RFC1918
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.0.2.0', 24) || // TEST-NET-1
    inRange('192.168.0.0', 16) || // RFC1918
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('198.51.100.0', 24) || // TEST-NET-2
    inRange('203.0.113.0', 24) || // TEST-NET-3
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved / 255.255.255.255
  );
}

/**
 * Expand an IPv6 string to its 16 bytes, or null if it does not parse. Handles
 * `::` compression and an embedded trailing dotted-IPv4 (::ffff:1.2.3.4). This
 * is what lets the policy check the address STRUCTURALLY rather than by string
 * spelling — the hex-word form `::ffff:7f00:1` and the dotted form
 * `::ffff:127.0.0.1` parse to the same bytes and are judged identically.
 */
export function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase().trim();
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct); // strip zone id (fe80::1%eth0)
  if (s.length === 0 || !s.includes(':')) return null;

  // A trailing dotted-IPv4 becomes two 16-bit groups.
  let tailGroups: number[] = [];
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    tailGroups = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, v4.index).replace(/:$/, '') || '::';
    if (!s.endsWith(':')) s += ':';
    s = s.slice(0, -1);
  }

  const parts = s.split('::');
  if (parts.length > 2) return null; // more than one '::' is illegal

  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    for (const g of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = parseSide(parts[0]);
  if (head === null) return null;
  let groups: number[];
  if (parts.length === 2) {
    const tail = parseSide(parts[1]);
    if (tail === null) return null;
    const all = [...head, ...tail, ...tailGroups];
    const fill = 8 - all.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...tail, ...tailGroups];
  } else {
    groups = [...head, ...tailGroups];
    if (groups.length !== 8) return null; // no '::' → must be exactly 8 groups
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >>> 8) & 0xff, g & 0xff);
  }
  return bytes;
}

/**
 * True if an IPv6 string is non-public. Parses to 16 bytes and checks ranges
 * STRUCTURALLY — loopback/unspecified, ULA (fc00::/7), link-local (fe80::/10),
 * multicast (ff00::/8) — plus every embedded-IPv4 carrier (IPv4-mapped
 * ::ffff:0:0/96, IPv4-compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16) by
 * extracting the embedded v4 and re-checking it. A literal that does not parse
 * is treated as blocked (conservative — a real public host is never an IPv6
 * literal that fails to parse).
 */
function isPrivateIpv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (b === null) return true; // unparseable IPv6 literal → refuse

  const allZeroThrough = (end: number): boolean => b.slice(0, end).every((x) => x === 0);
  const v4 = (i: number): number => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

  // :: (unspecified) and ::1 (loopback).
  if (allZeroThrough(15) && (b[15] === 0 || b[15] === 1)) return true;
  // fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast.
  if ((b[0] & 0xfe) === 0xfc) return true;
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  if (b[0] === 0xff) return true;

  // IPv4-mapped ::ffff:a.b.c.d  → bytes 0..9 zero, 10..11 = 0xff.
  if (allZeroThrough(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(v4(12));
  // NAT64 64:ff9b::/96 (well-known prefix) → embedded v4 in the low 32 bits.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZeroThroughRange(b, 4, 12))
    return isPrivateIpv4(v4(12));
  // IPv4-compatible ::a.b.c.d (deprecated) → bytes 0..11 zero, low 32 bits a v4.
  if (allZeroThrough(12)) return isPrivateIpv4(v4(12));
  // 6to4 2002::/16 → embedded v4 is bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(v4(2));

  return false;
}

function allZeroThroughRange(b: number[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (b[i] !== 0) return false;
  return true;
}

/** Detect a bracketed or bare IPv6 literal. */
function looksLikeIpv6(host: string): boolean {
  return host.includes(':');
}

/**
 * True if a host string (IP literal or resolved address) is NOT a public
 * unicast address and must be refused.
 */
export function isBlockedHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().trim();
  if (h.length === 0) return true;

  // Obvious local names that may bypass DNS (hosts file, mDNS, search domains).
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;

  const v4 = ipv4ToInt(h);
  if (v4 !== null) return isPrivateIpv4(v4);
  if (looksLikeIpv6(h)) return isPrivateIpv6(h);

  // Numeric-but-not-canonical hosts are IP-literal bypass forms, never real
  // public hostnames: octal (010.0.0.1 / 0177.0.0.1), bare decimal-int
  // (2130706433 = 127.0.0.1), dotted forms with a wrong octet count, or hex
  // (0x7f000001). A real DNS name has at least one alphabetic label, so refuse
  // anything that is purely digits+dots, or carries a 0x label.
  if (/^[0-9.]+$/.test(h)) return true;
  if (/(^|\.)0x[0-9a-f]*/i.test(h)) return true;

  // A plain hostname — cannot judge here; dispatch-time DNS resolution decides.
  return false;
}

/**
 * Registration-time validation. Enforces scheme + obvious-literal host policy.
 * Returns the parsed URL. Throws {@link SsrfError} on any violation. Does NOT
 * resolve DNS (that happens at dispatch, where the resolved IP is re-checked).
 */
export function assertSafeWebhookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid webhook URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Webhook URL must be http(s); got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SsrfError('Webhook URL must not contain credentials');
  }
  if (isBlockedHost(url.hostname)) {
    throw new SsrfError(`Webhook host is not a public address: ${url.hostname}`);
  }
  return url;
}

/**
 * Dispatch-time DNS check. Resolves the host and refuses if ANY resolved
 * address is private/reserved — this is what defeats a public-looking hostname
 * that points at an internal IP (DNS rebinding / split-horizon). Returns the
 * list of resolved public addresses (so the caller could pin if it wanted).
 */
export async function assertResolvedHostSafe(
  hostname: string,
  lookup: (h: string) => Promise<Array<{ address: string }>> = (h) =>
    dns.lookup(h, { all: true }),
): Promise<string[]> {
  // A literal IP host re-validates without a DNS round trip.
  if (ipv4ToInt(hostname) !== null || looksLikeIpv6(hostname)) {
    if (isBlockedHost(hostname)) {
      throw new SsrfError(`Webhook host resolves to a non-public address: ${hostname}`);
    }
    return [hostname];
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname);
  } catch (err) {
    throw new SsrfError(
      `Webhook host did not resolve: ${hostname} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (records.length === 0) {
    throw new SsrfError(`Webhook host did not resolve: ${hostname}`);
  }
  for (const r of records) {
    if (isBlockedHost(r.address)) {
      throw new SsrfError(
        `Webhook host ${hostname} resolves to a non-public address: ${r.address}`,
      );
    }
  }
  return records.map((r) => r.address);
}
