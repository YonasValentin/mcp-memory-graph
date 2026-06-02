/**
 * Security headers middleware. Zero dependencies, opinionated defaults.
 *
 * Applied to every response (including /health, /live, /metrics, static
 * files, and the SPA index). Headers chosen to harden the React web UI
 * served from the same origin as the API.
 *
 * Tunables (env):
 *   MCP_HSTS_DISABLED        default 0  set 1 to skip HSTS (e.g. plain HTTP test rigs)
 *   MCP_HSTS_MAX_AGE         default 15552000 (180 days)
 *   MCP_CSP_DISABLED         default 0  set 1 to skip CSP (debug only)
 *   MCP_CSP_EXTRA_CONNECT    extra space-separated origins for connect-src (e.g. "https://api.example.com")
 *
 * HSTS is only emitted when the server is NOT bound to loopback — on
 * loopback the connection is plain HTTP and HSTS would be ignored by
 * browsers anyway, but we omit it to avoid noise in dev.
 */
import type { Request, Response, NextFunction } from 'express';

export interface SecurityHeadersConfig {
  /** True when this server is NOT bound to loopback (i.e. behind a TLS proxy). */
  isRemote: boolean;
}

function envFlag(name: string): boolean {
  return process.env[name] === '1';
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the Content-Security-Policy header value.
 *
 * The web UI is a Vite-built React SPA that ships with hashed assets and
 * inlines no scripts at runtime. We allow `'self'` for scripts/styles plus
 * `data:` for images (favicons/icons). `'unsafe-inline'` is allowed only
 * for styles because Tailwind v4's runtime emits a small style block.
 */
export function buildCsp(): string {
  const extraConnect = (process.env.MCP_CSP_EXTRA_CONNECT ?? '').trim();
  const connectSrc = ["'self'", extraConnect].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export function securityHeadersMiddleware(config: SecurityHeadersConfig) {
  const cspValue = buildCsp();
  const hstsMaxAge = envInt('MCP_HSTS_MAX_AGE', 15_552_000);
  const cspDisabled = envFlag('MCP_CSP_DISABLED');
  const hstsDisabled = envFlag('MCP_HSTS_DISABLED');

  return function securityHeadersMw(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    if (!cspDisabled) {
      res.setHeader('Content-Security-Policy', cspValue);
    }

    // Only meaningful behind TLS — and our default is loopback HTTP.
    if (config.isRemote && !hstsDisabled) {
      res.setHeader(
        'Strict-Transport-Security',
        `max-age=${hstsMaxAge}; includeSubDomains`,
      );
    }

    next();
  };
}
