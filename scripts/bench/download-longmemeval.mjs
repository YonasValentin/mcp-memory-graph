// Downloads the LongMemEval dataset (Wu et al., ICLR 2025 — MIT licensed) into
// a local cache. The files are large (oracle ~15 MB, S ~277 MB) and are NEVER
// committed to this repo — only this downloader and the harness are.
//
// Run:  node scripts/bench/download-longmemeval.mjs [oracle|s|all]
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const CACHE_DIR = join(homedir(), '.cache', 'mcp-memory-bench');

// The "cleaned" dataset is the current official release; the original HF repo
// is deprecated. URLs verified unauthenticated 2026-06-10.
const FILES = {
  oracle: {
    name: 'longmemeval_oracle.json',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json',
    bytes: 15_388_478,
  },
  s: {
    name: 'longmemeval_s_cleaned.json',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
    bytes: 277_383_467,
  },
};

export function datasetPath(variant) {
  const f = FILES[variant];
  if (!f) throw new Error(`Unknown LongMemEval variant "${variant}" (oracle|s)`);
  return join(CACHE_DIR, f.name);
}

export async function ensureDataset(variant) {
  const f = FILES[variant];
  if (!f) throw new Error(`Unknown LongMemEval variant "${variant}" (oracle|s)`);
  const dest = datasetPath(variant);
  if (existsSync(dest) && statSync(dest).size === f.bytes) return dest;
  mkdirSync(CACHE_DIR, { recursive: true });
  console.error(`Downloading ${f.name} (${(f.bytes / 1e6).toFixed(0)} MB) → ${dest}`);
  const res = await fetch(f.url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} for ${f.url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const got = statSync(dest).size;
  if (got !== f.bytes) {
    throw new Error(`Size mismatch for ${f.name}: expected ${f.bytes}, got ${got}`);
  }
  console.error(`Done: ${dest}`);
  return dest;
}

// CLI entry: download the requested variant(s).
if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv[2] ?? 'all';
  const variants = which === 'all' ? Object.keys(FILES) : [which];
  for (const v of variants) await ensureDataset(v);
}
