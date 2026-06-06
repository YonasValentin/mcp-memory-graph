import { writeFileSync } from 'node:fs';
import { getReadOnlyDb } from '../lib/direct-access.js';
import { exportGraph, mergeGraphFiles } from '../graph/graph-export.js';
import { getVaultEgress } from '../config/loader.js';

const DEFAULT_OUT = './memory-graph.json';

/** Parses `--flag value` pairs from a raw argv slice. */
function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = args[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

/**
 * `memory export-graph [--out <path>] [--scope <s>] [--namespace <n>]`
 * Writes the committable graph artifact. The pure `exportGraph` stays
 * deterministic; the `exported_at` timestamp is stamped here at the IO layer.
 */
export function runExportGraph(argv: string[]): void {
  const flags = parseFlags(argv);
  const db = getReadOnlyDb();
  // battle-v9 CLASS 5: honour the vault egress cap when exporting the shareable
  // graph from the CLI too, so a manual share can't leak above-cap content.
  const artifact = exportGraph(db, { scope: flags.scope, namespace: flags.namespace }, getVaultEgress());
  const out = flags.out || DEFAULT_OUT;
  /* c8 ignore start — IO: file write + console output. */
  const stamped = { ...artifact, exported_at: new Date().toISOString() };
  writeFileSync(out, JSON.stringify(stamped, null, 2));
  console.error(
    `Exported graph → ${out} (${artifact.memories.length} memories, ${artifact.links.length} links, ${artifact.entities.length} entities)`,
  );
  /* c8 ignore stop */
}

/**
 * `memory merge-graphs <ours> <theirs> <out>` — the git union merge driver.
 * Configure git with `merge.memory-union.driver = ... merge-graphs %A %B %A`.
 */
export function runMergeGraphs(argv: string[]): void {
  const [ours, theirs, out] = argv;
  if (!ours || !theirs || !out) {
    /* c8 ignore start — usage error path. */
    console.error('Usage: memory merge-graphs <ours> <theirs> <out>');
    process.exitCode = 1;
    return;
    /* c8 ignore stop */
  }
  mergeGraphFiles(ours, theirs, out);
  /* c8 ignore start — console output. */
  console.error(`Merged ${ours} + ${theirs} → ${out}`);
  /* c8 ignore stop */
}

/**
 * Builds the `merge.memory-union.driver` command git runs on a merge of
 * `memory-graph.json`. The dist entry path is double-quoted so paths containing
 * spaces (e.g. `~/My Projects/...`) survive the shell git uses to invoke the
 * driver. The `%A %B %A` placeholders are git's ours/theirs/output contract.
 * Pure — no IO — so it can be unit-tested.
 */
export function buildMergeDriverCommand(distEntry: string): string {
  return `node "${distEntry}" merge-graphs %A %B %A`;
}

/* c8 ignore start — git config + filesystem wiring; the pure merge it installs is tested. */
/**
 * `memory git-setup` — installs the `.gitattributes` entry and the
 * `memory-union` git merge driver so parallel commits of `memory-graph.json`
 * auto-merge via {@link mergeGraphFiles} instead of producing conflict markers.
 */
export async function runGitSetup(): Promise<void> {
  const { existsSync, readFileSync, writeFileSync: write } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  const ATTR_LINE = 'memory-graph.json merge=memory-union';
  const ATTR_PATH = '.gitattributes';

  const existing = existsSync(ATTR_PATH) ? readFileSync(ATTR_PATH, 'utf8') : '';
  if (!existing.split('\n').some((l) => l.trim() === ATTR_LINE)) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    write(ATTR_PATH, `${existing}${sep}${ATTR_LINE}\n`);
    console.error(`Added "${ATTR_LINE}" to ${ATTR_PATH}`);
  } else {
    console.error(`${ATTR_PATH} already configured`);
  }

  // dist path of this CLI (compiled index.js) — what git invokes on merge. The
  // path is quoted by buildMergeDriverCommand so spaces in it don't break.
  const distEntry = fileURLToPath(new URL('../index.js', import.meta.url));
  const driver = buildMergeDriverCommand(distEntry);
  execFileSync('git', ['config', 'merge.memory-union.name', 'memory graph union merge']);
  execFileSync('git', ['config', 'merge.memory-union.driver', driver]);

  console.error('Configured git merge driver "memory-union":');
  console.error(`  driver = ${driver}`);
  console.error('Commit memory-graph.json — parallel commits now auto-merge.');
}
/* c8 ignore stop */
