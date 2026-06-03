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
  // F4/P8: common secret keys that previously leaked in cleartext.
  'access_token', 'refresh_token', 'client_secret', 'private_key',
  'session_token', 'bearer',
]);

// Recursion is depth-capped defensively: beyond this, nested values are passed
// through untouched so a pathological structure can never hang the logger.
const MAX_DEPTH = 6;

function levelFromEnv(): LogLevel {
  const raw = (process.env.MCP_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

/**
 * Recursively redact secret-keyed values across nested objects AND arrays
 * (F4/P8). A WeakSet of already-visited containers breaks circular references,
 * and {@link MAX_DEPTH} caps depth — a logger must never throw or hang. Only
 * own-enumerable keys are walked (Object.entries skips inherited/proto keys),
 * key names and non-secret primitives are preserved, and the input is never
 * mutated.
 */
function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[REDACTED:DEPTH]';
  if (seen.has(value)) return '[REDACTED:CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase())
      ? '[REDACTED]'
      : redactValue(v, depth + 1, seen);
  }
  return out;
}

function redact(input: Record<string, unknown>): Record<string, unknown> {
  return redactValue(input, 0, new WeakSet()) as Record<string, unknown>;
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
