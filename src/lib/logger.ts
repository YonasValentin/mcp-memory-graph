/**
 * Tiny dependency-free structured JSON logger. Writes one JSON object per
 * line to stderr (so it doesn't interfere with stdout-bound MCP transports).
 *
 * Levels: debug | info | warn | error. Each call accepts an `event` string
 * and an arbitrary record — fields are spread into the line. Authorization
 * headers and a small set of common secret keys are redacted automatically.
 *
 * Example:
 *   logger.info({ event: 'http_request', requestId, route: '/api/stats', status: 200, duration_ms: 12 });
 *
 * Output:
 *   {"ts":"2026-04-28T22:10:01.234Z","level":"info","event":"http_request","requestId":"...","route":"/api/stats","status":200,"duration_ms":12}
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEYS = new Set([
  'authorization', 'auth', 'token', 'mcp_auth_token', 'password', 'secret',
  'api_key', 'apikey', 'cookie', 'set-cookie',
]);

function levelFromEnv(): LogLevel {
  const raw = (process.env.MCP_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function redact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface LogFields {
  event: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, fields: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[levelFromEnv()]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    ...redact(fields as Record<string, unknown>),
  };
  // stderr keeps the stdio MCP transport on stdout free of log noise.
  process.stderr.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug(fields: LogFields): void { emit('debug', fields); },
  info(fields: LogFields): void { emit('info', fields); },
  warn(fields: LogFields): void { emit('warn', fields); },
  error(fields: LogFields): void { emit('error', fields); },
};
