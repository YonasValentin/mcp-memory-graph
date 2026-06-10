/**
 * Reads a positive-integer environment variable, returning `fallback` when the
 * var is unset, non-numeric, non-finite, or not greater than zero.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Reads a boolean opt-in environment variable: `1` or `true` (any case) is
 * true; unset or anything else is false.
 */
export function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v === '1' || v === 'true';
}
