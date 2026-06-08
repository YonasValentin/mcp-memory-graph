import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ParsedVaultFile } from '../types.js';

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
const INLINE_TAG_RE = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/gm;

/**
 * Frontmatter fence matcher. Accepts:
 *   - the closing `---` followed by a newline OR end-of-string (VAULT-1: a file
 *     whose closing fence is the last line with no trailing newline);
 *   - an empty frontmatter block `---\n---` where the YAML body is absent
 *     (VAULT-2): the inner capture group is optional.
 * CRLF-tolerant. Anchored at start so a `---` inside the body is never mistaken
 * for a fence.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)?---(?:\r?\n|$)/;

/**
 * Split a raw markdown string into parsed YAML frontmatter + the remaining body.
 * Single source of truth for fence detection, shared by parseVaultFile and the
 * lossless memory-file parser. Frontmatter is prototype-pollution sanitized;
 * invalid YAML degrades to an empty frontmatter object.
 */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1] ?? '');
    if (parsed && typeof parsed === 'object') {
      frontmatter = sanitizeFrontmatter(parsed as Record<string, unknown>);
    }
  } catch {
    /* invalid YAML — fall through with empty frontmatter */
  }
  const body = raw.slice(m[0].length).trimStart();
  return { frontmatter, body };
}

/**
 * Parses a single Obsidian `.md` file into structured data,
 * extracting frontmatter, wiki-links, and inline tags.
 */
export function parseVaultFile(
  absolutePath: string,
  relativePath: string,
  mtimeMs: number,
): ParsedVaultFile {
  const raw = fs.readFileSync(absolutePath, 'utf-8');

  const { frontmatter, body } = splitFrontmatter(raw);

  const links = extractLinks(body);
  const inlineTags = extractInlineTags(body);
  const frontmatterTags = normalizeFrontmatterTags(frontmatter.tags);
  const tags = deduplicateStrings([...frontmatterTags, ...inlineTags]);
  const title = deriveTitle(frontmatter, relativePath);

  return {
    title,
    content: body,
    frontmatter,
    tags,
    links,
    relativePath,
    absolutePath,
    mtimeMs,
  };
}

/**
 * Frontmatter is untrusted YAML. yaml.parse does not pollute Object.prototype,
 * but it CAN return an object carrying an own `__proto__` (or `constructor` /
 * `prototype`) key, which a downstream merge/spread could turn into prototype
 * pollution. Return a copy with those dangerous own keys dropped; benign keys
 * pass through unchanged.
 */
const DANGEROUS_FRONTMATTER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function sanitizeFrontmatter(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_FRONTMATTER_KEYS.has(key)) continue;
    clean[key] = obj[key];
  }
  return clean;
}

function extractLinks(body: string): string[] {
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = WIKI_LINK_RE.exec(body)) !== null) {
    const target = match[1].trim();
    if (target) {
      seen.add(target);
    }
  }

  return [...seen];
}

function extractInlineTags(body: string): string[] {
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = INLINE_TAG_RE.exec(body)) !== null) {
    seen.add(match[1].toLowerCase());
  }

  return [...seen];
}

export function normalizeFrontmatterTags(raw: unknown): string[] {
  if (raw == null) return [];

  let items: string[];

  if (Array.isArray(raw)) {
    // Coerce YAML-scalar tags (numbers/booleans, e.g. `tags: [2024, true, infra]`)
    // to strings so they survive instead of being silently dropped (VAULT-3).
    items = raw
      .filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .map((v) => String(v));
  } else if (typeof raw === 'string') {
    items = raw.split(',');
  /* c8 ignore start */
  } else {
    return [];
  }
  /* c8 ignore stop */

  return items
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function deduplicateStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function deriveTitle(
  frontmatter: Record<string, unknown>,
  relativePath: string,
): string {
  if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }

  const aliases = frontmatter.aliases;
  /* c8 ignore next 3 */
  if (Array.isArray(aliases) && aliases.length > 0 && typeof aliases[0] === 'string') {
    return aliases[0];
  }

  const filename = path.basename(relativePath, '.md');
  return filename.replace(/[-_]/g, ' ');
}
