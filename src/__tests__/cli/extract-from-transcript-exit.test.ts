/**
 * Regression: extract-from-transcript must EXIT PROMPTLY with code 0 on the
 * success path.
 *
 * Pre-fix (scripts/battle/verify-hooks.mjs finding): the module-level safety
 * timer `setTimeout(() => process.exit(1), 5*60*1000)` was neither `.unref()`'d
 * nor cleared, so after main() resolved successfully the timer kept the event
 * loop alive for the FULL 5 minutes — the process lingered holding the loaded
 * ONNX model + an open DB handle, then finally exited with code 1 even though
 * extraction had completed (1 learning was stored). The PreCompact hook spawns
 * this CLI detached, so every compaction left a zombie process for 5 minutes.
 *
 * Post-fix: the timer is unref'd and main() clears it + process.exit(0) on
 * success, so the process exits within seconds with code 0.
 *
 * This is a process-lifecycle bug, so it is verified by spawning the COMPILED
 * dist CLI exactly as the hook does. It is gated on the compiled dist + the
 * cached embedding model being present (CI heavyweight lane / dev), and skipped
 * otherwise so the default unit suite stays fast and green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const CLI = join(ROOT, 'dist', 'cli', 'extract-from-transcript.js');
const MODEL_CACHE = join(ROOT, 'node_modules', '@huggingface', 'transformers', '.cache', 'Xenova', 'all-MiniLM-L6-v2');

// Only meaningful against the compiled CLI with the real (cached) model.
const RUNNABLE = existsSync(CLI) && existsSync(MODEL_CACHE);

let home: string;
let transcriptPath: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'mcp-extract-exit-'));
  mkdirSync(join(home, '.mcp-memory'), { recursive: true });
  transcriptPath = join(home, 'transcript.jsonl');
  // ≥100 chars so main() runs the full extraction path (not the short-circuit).
  const body = Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({
      type: i % 2 ? 'assistant' : 'user',
      message: {
        role: i % 2 ? 'assistant' : 'user',
        content: `Turn ${i}: we decided to use a token bucket rate limiter at 100 req/min and fixed an N+1 query in the invoice list endpoint.`,
      },
    }),
  ).join('\n');
  writeFileSync(transcriptPath, body);
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('extract-from-transcript exits promptly on success', () => {
  it.skipIf(!RUNNABLE)(
    'completes and exits 0 within seconds (no 5-minute lingering safety timer)',
    async () => {
      const start = Date.now();
      const result = await new Promise<{ code: number | null; ms: number }>((resolve) => {
        const child = spawn('node', [CLI, transcriptPath, 'precompact'], {
          env: {
            ...process.env,
            HOME: home,
            MCP_MEMORY_DB_PATH: join(home, '.mcp-memory', 'memory.db'),
            MCP_MEMORY_CONFIG_PATH: join(home, '.mcp-memory', 'config.json'),
            MCP_MEMORY_CWD: ROOT,
          },
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        // Generous ceiling but far below the 5-min runaway timer. Pre-fix this
        // ALWAYS times out (process lingers 5 min); post-fix it returns in ~2s.
        const killer = setTimeout(() => child.kill('SIGKILL'), 50_000);
        child.on('exit', (code) => {
          clearTimeout(killer);
          resolve({ code, ms: Date.now() - start });
        });
      });
      expect(result.code).toBe(0);
      expect(result.ms).toBeLessThan(50_000);
    },
    60_000,
  );
});
