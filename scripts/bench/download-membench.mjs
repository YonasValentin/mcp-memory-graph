// Downloads the MemBench FirstAgent dataset (Tan et al., ACL 2025 Findings;
// github.com/import-myself/Membench) into a local cache. Only the 10 files the
// mempalace parity slice scores are fetched (~506 MB total; RecMultiSession.json
// is excluded — mempalace's movie/roles/events topic filter matches none of its
// keys, zeroing that category). Plain raw.githubusercontent.com blobs, no auth,
// streamed to disk with progress on stderr. Never committed — only this
// downloader and the harness are.
//
// Run:  node scripts/bench/download-membench.mjs [category ...]
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const CACHE_DIR = join(homedir(), ".cache", "mcp-memory-bench", "membench");

const RAW_BASE = "https://raw.githubusercontent.com/import-myself/Membench/main/MemData/FirstAgent";

// mempalace CATEGORY_FILES order (minus RecMultiSession). `topics` is the key
// filter membench_bench.py applies with --topic movie: topic-keyed files keep
// only "movie" (food/book excluded); role-keyed files keep roles + events.
// Sizes verified unauthenticated 2026-06-11.
export const FILES = [
  { category: "simple", name: "simple.json", bytes: 60_779_676, topics: ["roles", "events"] },
  { category: "highlevel", name: "highlevel.json", bytes: 13_832_415, topics: ["movie"] },
  { category: "knowledge_update", name: "knowledge_update.json", bytes: 69_972_511, topics: ["roles", "events"] },
  { category: "comparative", name: "comparative.json", bytes: 60_389_448, topics: ["roles", "events"] },
  { category: "conditional", name: "conditional.json", bytes: 66_632_463, topics: ["roles", "events"] },
  { category: "noisy", name: "noisy.json", bytes: 66_760_891, topics: ["roles", "events"] },
  { category: "aggregative", name: "aggregative.json", bytes: 60_875_198, topics: ["roles", "events"] },
  { category: "highlevel_rec", name: "highlevel_rec.json", bytes: 25_132_429, topics: ["movie"] },
  { category: "lowlevel_rec", name: "lowlevel_rec.json", bytes: 15_343_187, topics: ["movie"] },
  { category: "post_processing", name: "post_processing.json", bytes: 66_724_583, topics: ["roles", "events"] },
];

export function datasetPath(category) {
  const f = FILES.find((x) => x.category === category);
  if (!f) throw new Error(`Unknown MemBench category "${category}"`);
  return join(CACHE_DIR, f.name);
}

/** Counts piped bytes and logs progress on stderr every ~10%. */
function progressStream(label, totalBytes) {
  let seen = 0;
  let nextMark = 0.1;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen / totalBytes >= nextMark) {
        console.error(`  ${label}: ${(seen / 1e6).toFixed(0)}/${(totalBytes / 1e6).toFixed(0)} MB`);
        nextMark += 0.1;
      }
      cb(null, chunk);
    },
  });
}

export async function ensureMembenchFile(category) {
  const f = FILES.find((x) => x.category === category);
  if (!f) throw new Error(`Unknown MemBench category "${category}"`);
  const dest = datasetPath(category);
  if (existsSync(dest) && statSync(dest).size === f.bytes) return dest;
  mkdirSync(CACHE_DIR, { recursive: true });
  const url = `${RAW_BASE}/${f.name}`;
  console.error(`Downloading ${f.name} (${(f.bytes / 1e6).toFixed(0)} MB) → ${dest}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), progressStream(f.name, f.bytes), createWriteStream(dest));
  const got = statSync(dest).size;
  if (got !== f.bytes) throw new Error(`Size mismatch for ${f.name}: expected ${f.bytes}, got ${got}`);
  console.error(`Done: ${dest}`);
  return dest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv.slice(2);
  const categories = which.length > 0 ? which : FILES.map((f) => f.category);
  for (const c of categories) await ensureMembenchFile(c);
}
