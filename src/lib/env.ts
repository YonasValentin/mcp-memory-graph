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
