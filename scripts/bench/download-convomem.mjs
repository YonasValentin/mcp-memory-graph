// Downloads the ConvoMem benchmark parity slice (Salesforce/ConvoMem on
// HuggingFace, no auth) into a local cache. Only the `1_evidence` split of the
// five categories mempalace's convomem_bench.py actually scores is fetched —
// files are listed via the HF tree API (alphabetical), then downloaded in
// order until each category covers the requested item count (~1 MB/file,
// ~89–100 items each). Never committed — only this downloader + the harness.
//
// Run:  node scripts/bench/download-convomem.mjs [itemsPerCategory=50]
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export const CACHE_DIR = join(homedir(), ".cache", "mcp-memory-bench", "convomem");

const HF_API = "https://huggingface.co/api/datasets/Salesforce/ConvoMem/tree/main";
const HF_RESOLVE = "https://huggingface.co/datasets/Salesforce/ConvoMem/resolve/main";

// mempalace CATEGORIES order, minus changing_evidence: that category has NO
// 1_evidence directory upstream, so convomem_bench.py's discover_files returns
// nothing and it silently skips it — we skip it for parity (and say so in the
// harness report note).
export const CATEGORIES = [
  "user_evidence",
  "assistant_facts_evidence",
  "abstention_evidence",
  "preference_evidence",
  "implicit_connection_evidence",
];

/** Alphabetical list of 1_evidence file paths for a category (cached). */
async function listCategoryFiles(category) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${category}_filelist.json`);
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8"));
  const url = `${HF_API}/core_benchmark/evidence_questions/${category}/1_evidence`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`File listing failed: HTTP ${res.status} for ${url}`);
  const entries = await res.json();
  const paths = entries
    .filter((e) => typeof e.path === "string" && e.path.endsWith(".json"))
    .map((e) => e.path)
    .sort();
  writeFileSync(cachePath, JSON.stringify(paths));
  return paths;
}

/** Download (or reuse) one evidence file; returns its parsed JSON. */
async function ensureFile(category, path) {
  const dir = join(CACHE_DIR, category);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(path));
  if (!existsSync(dest)) {
    const url = `${HF_RESOLVE}/${path}`;
    console.error(`Downloading ${category}/${basename(path)} → ${dest}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
    const part = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    // Parse before committing so a truncated download never poisons the cache.
    JSON.parse(readFileSync(part, "utf8"));
    const { renameSync } = await import("node:fs");
    renameSync(part, dest);
  }
  return JSON.parse(readFileSync(dest, "utf8"));
}

/**
 * Load the parity slice: for each category, accumulate evidence_items from the
 * alphabetically-first files until `limitPerCategory` is covered, then slice —
 * exactly mempalace's load_evidence_items file-then-item ordering.
 * Returns [{ category, items }] in CATEGORIES order.
 */
export async function loadConvomemItems(limitPerCategory) {
  const out = [];
  for (const category of CATEGORIES) {
    const files = await listCategoryFiles(category);
    const items = [];
    for (const path of files) {
      if (items.length >= limitPerCategory) break;
      const data = await ensureFile(category, path);
      if (data && Array.isArray(data.evidence_items)) items.push(...data.evidence_items);
    }
    out.push({ category, items: items.slice(0, limitPerCategory) });
    console.error(`  ${category}: ${Math.min(items.length, limitPerCategory)} items`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const limit = parseInt(process.argv[2] ?? "50", 10) || 50;
  await loadConvomemItems(limit);
}
