import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ParsedVaultFile } from '../types.js';

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
const INLINE_TAG_RE = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/gm;

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

  let frontmatter: Record<string, unknown> = {};
  let body: string;

  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const lineBreak = raw.startsWith('---\r\n') ? '\r\n' : '\n';
    const closingIndex = raw.indexOf(`${lineBreak}---${lineBreak}`, lineBreak.length + 3);

    if (closingIndex !== -1) {
      const yamlStr = raw.slice(lineBreak.length + 3, closingIndex);
      try {
        const parsed = parseYaml(yamlStr);
        if (parsed && typeof parsed === 'object') {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch /* c8 ignore start */ {
        // Invalid YAML -- fall through with empty frontmatter
      }
      /* c8 ignore stop */
      body = raw.slice(closingIndex + lineBreak.length + 3 + lineBreak.length).trimStart();
    } else {
      body = raw;
    }
  } else {
    body = raw;
  }

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

function normalizeFrontmatterTags(raw: unknown): string[] {
  if (raw == null) return [];

  let items: string[];

  if (Array.isArray(raw)) {
    items = raw.filter((v): v is string => typeof v === 'string');
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
