import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { VaultFileEntry } from '../types.js';
import { sanitizePath } from '../lib/path-validation.js';

export interface ScanOptions {
  includePatterns?: string[];
  excludePatterns?: string[];
}

/**
 * Scans an Obsidian vault directory for `.md` files,
 * respecting include/exclude glob patterns.
 */
export function scanVault(
  vaultPath: string,
  options?: ScanOptions,
): VaultFileEntry[] {
  const sanitized = sanitizePath(vaultPath);
  /* c8 ignore next 3 */
  if (!sanitized) {
    throw new Error(`Invalid vault path: ${vaultPath}`);
  }
  const resolvedPath = sanitized;

  const stat = fs.lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${resolvedPath}`);
  }

  const entries: VaultFileEntry[] = [];
  walkDirectory(resolvedPath, resolvedPath, entries);

  const includeMatcher = options?.includePatterns?.length
    ? picomatch(options.includePatterns)
    : null;

  const excludeMatcher = options?.excludePatterns?.length
    ? picomatch(options.excludePatterns)
    : null;

  const filtered = entries.filter((entry) => {
    if (includeMatcher && !includeMatcher(entry.relativePath)) {
      return false;
    }
    if (excludeMatcher && excludeMatcher(entry.relativePath)) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return filtered;
}

function walkDirectory(
  dir: string,
  vaultRoot: string,
  entries: VaultFileEntry[],
): void {
  const dirents = fs.readdirSync(dir, { withFileTypes: true });

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    if (dirent.isSymbolicLink()) continue;

    const fullPath = path.join(dir, dirent.name);

    if (dirent.isDirectory()) {
      walkDirectory(fullPath, vaultRoot, entries);
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
      const relativePath = path.relative(vaultRoot, fullPath).replace(/\\/g, '/');
      const stat = fs.statSync(fullPath);
      entries.push({ absolutePath: fullPath, relativePath, mtimeMs: stat.mtimeMs });
    }
  }
}
