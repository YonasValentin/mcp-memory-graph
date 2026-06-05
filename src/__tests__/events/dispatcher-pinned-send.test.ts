/**
 * battle-v7 M3 — the SSRF-pinned webhook sender must actually connect on Node 22+.
 *
 * THE BUG (MEDIUM, broken delivery): sendPinned forces the socket to the
 * validated IP via a custom node:http `lookup` callback that returned the SCALAR
 * form `cb(null, address, family)`. Node 22's connect path passes `options.all =
 * true` and expects the ARRAY form `cb(null, [{address, family}])`; given the
 * scalar form it reads `address = undefined` and throws
 * "Invalid IP address: undefined" — so EVERY outbound webhook to a public host
 * failed (the SSRF pin is always used in production). Tests inject fetchImpl, so
 * the pinned path was never exercised.
 *
 * THE FIX: honor options.all — return the array form when asked, scalar otherwise.
 * This test drives the real sendPinned against a loopback server (sendPinned
 * connects to the given IP without re-resolving, so the SSRF guard — which blocks
 * loopback — is not in the way here).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sendPinned } from '../../events/dispatcher.js';

let server: http.Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe('sendPinned — M3: connects to the pinned IP on Node 22+', () => {
  it('delivers to a DNS-named host pinned to the validated IP (no "Invalid IP address: undefined")', async () => {
    let received = '';
    let gotHostHeader = '';
    server = http.createServer((req, res) => {
      gotHostHeader = req.headers.host ?? '';
      req.on('data', (c) => (received += c));
      req.on('end', () => {
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as AddressInfo).port;

    // The URL carries a DNS NAME (not an IP) — exactly the production case the
    // custom-lookup pin broke on Node 22. Pin it to the loopback receiver.
    const res = await sendPinned(
      new URL(`http://webhook.example.test:${port}/hook`),
      { 'content-type': 'application/json' },
      JSON.stringify({ event: 'memory.created' }),
      '127.0.0.1',
      2000,
    );

    expect(res.status).toBe(200);
    expect(received).toContain('memory.created');
    // The Host header must still carry the original hostname (virtual-hosting).
    expect(gotHostHeader).toContain('webhook.example.test');
  });

  // battle-v8 A2: an oversized (>64KB) response must SETTLE, not hang. res.destroy()
  // at the byte cap emits neither 'end' nor 'error', so the promise used to hang
  // forever and wedge the autonomous dispatch loop.
  it('settles on an oversized response body instead of hanging', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      res.write(chunk); res.write(chunk); res.write(chunk); // 192KB > cap; never end()
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as AddressInfo).port;

    const res = await Promise.race([
      sendPinned(new URL(`http://host.test:${port}/x`), {}, 'b', '127.0.0.1', 3000),
      new Promise<{ status: number }>((_, rej) => setTimeout(() => rej(new Error('HANG')), 1500)),
    ]);
    expect(res.status).toBe(200);
  });
});
