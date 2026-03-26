import path from 'node:path';
import fs from 'node:fs';

/**
 * Validates and sanitizes a file path.
 * Rejects null bytes, non-printable characters.
 * Resolves to absolute path.
 * Optionally validates the path is under an allowed base directory.
 */
export function sanitizePath(
  input: string,
  options?: { allowedBase?: string; mustExist?: boolean },
): string | null {
  if (!input || typeof input !== 'string') return null;

  // Reject null bytes and non-printable characters
  if (/[\x00-\x1f]/.test(input)) return null;

  const resolved = path.resolve(input);

  // If allowedBase specified, ensure resolved path is under it
  if (options?.allowedBase) {
    const base = path.resolve(options.allowedBase);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return null;
    }
  }

  // Optionally check existence
  if (options?.mustExist && !fs.existsSync(resolved)) {
    return null;
  }

  return resolved;
}
