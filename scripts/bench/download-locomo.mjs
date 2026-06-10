// Downloads the LOCOMO dataset (Maharana et al., ACL 2024; snap-research/locomo)
// into a local cache. Never committed — only this downloader + the harness are.
//
// Run:  node scripts/bench/download-locomo.mjs
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const CACHE_DIR = join(homedir(), ".cache", "mcp-memory-bench");

const FILE = {
  name: "locomo10.json",
  url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  bytes: 2_805_274,
};

export function datasetPath() {
  return join(CACHE_DIR, FILE.name);
}

export async function ensureLocomo() {
  const dest = datasetPath();
  if (existsSync(dest) && statSync(dest).size === FILE.bytes) return dest;
  mkdirSync(CACHE_DIR, { recursive: true });
  console.error(`Downloading ${FILE.name} (${(FILE.bytes / 1e6).toFixed(1)} MB) → ${dest}`);
  const res = await fetch(FILE.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${FILE.url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const got = statSync(dest).size;
  if (got !== FILE.bytes) throw new Error(`Size mismatch for ${FILE.name}: expected ${FILE.bytes}, got ${got}`);
  console.error(`Done: ${dest}`);
  return dest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureLocomo();
}
