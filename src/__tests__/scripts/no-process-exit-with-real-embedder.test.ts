/**
 * P14-lint-guard (battle-v3 P14 follow-up — regression tripwire).
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * Several battle/verification scripts load the REAL Transformers (ONNX) embedder
 * IN-PROCESS (e.g. `new TransformersEmbeddingProvider()` + `.initialize()`, or the
 * `getEmbedder()` direct-access loader). onnxruntime-node spins up native worker
 * threads. If such a process is torn down by an abrupt `process.exit()` while the
 * ORT runtime is live, libc++ aborts with `std::system_error: mutex lock failed`
 * and the process dies with exit code 134 — REGARDLESS of whether the script's
 * own checks passed. The P14 fix removed the trailing `setTimeout(process.exit)`
 * from verify-web.mjs: set `process.exitCode` and let the event loop drain
 * naturally so ORT unwinds cleanly. A future script that re-adds a trailing
 * `process.exit()` after the embedder is live would silently reintroduce the
 * exit-134 masking bug, so this static tripwire forbids it.
 *
 * WHAT IT CHECKS
 * --------------
 * For every `scripts/**\/*.mjs` that loads the real embedder IN-PROCESS, assert
 * the script contains no executable `process.exit(` call — UNLESS that call
 * carries an explicit, auditable opt-out marker. Natural drain via
 * `process.exitCode` is the required pattern.
 *
 * IN-PROCESS PREDICATE (tuned to avoid false positives)
 * -----------------------------------------------------
 *   - references `TransformersEmbeddingProvider`, OR
 *   - calls `getEmbedder` (the dist/lib/direct-access in-process loader), OR
 *   - imports from a path containing `embeddings/transformers`.
 * It deliberately does NOT flag:
 *   - mock-only scripts (`MockEmbeddingProvider`, no ORT threads — probe-lossless), or
 *   - scripts whose only real embedder runs in a SPAWNED CHILD (smoke-mcp boots
 *     `dist/index.js` over stdio MCP; a parent `process.exit` can't abort a
 *     child's ORT runtime).
 *
 * OPT-OUT MARKER
 * --------------
 * A `process.exit(` is allowed when `mcp-memory:allow-process-exit` appears on the
 * SAME line, or anywhere in the contiguous comment block immediately ABOVE it.
 * Reserved for exits that provably cannot abort a live ORT runtime: a pre-model
 * precondition exit, or an error path taken when the embedder/model FAILED to
 * load. A naive trailing `process.exit(0)` on the happy path has no marker and
 * trips the wire.
 *
 * COMMENT STRIPPING
 * -----------------
 * The earlier draft of this guard stripped block comments with a single regex
 * BEFORE line comments, so a `//` line comment containing a `/*` substring (e.g.
 * the path `dist/hooks/*.js` in verify-hooks.mjs:5) spuriously opened a block
 * comment that swallowed every line up to the next `*​/` — hiding a real
 * `process.exit()` from the scan. `stripComments` below is a single-pass,
 * string-aware scanner that tracks line/block-comment and string state so
 * comment delimiters inside `//` comments or string literals can never open a
 * span. Line numbers are preserved 1:1 (newlines are kept; everything else in a
 * comment/string is blanked) so failure messages point at the right line.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OPT_OUT = 'mcp-memory:allow-process-exit';

/** Every `*.mjs` under scripts/ and scripts/battle/ (the dirs that hold harnesses). */
function scriptFiles(): string[] {
  const dirs = [join(REPO, 'scripts'), join(REPO, 'scripts', 'battle')];
  const out: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (f.endsWith('.mjs')) out.push(join(d, f));
    }
  }
  return out;
}

/**
 * True when `src` loads the REAL embedder in-process. Comments are NOT stripped
 * here on purpose: these tokens appear in real import/usage lines in the
 * harnesses, and a comment merely mentioning the embedder still implies the
 * script deals with it — erring toward flagging is the safe (tripwire) bias.
 */
function loadsRealEmbedderInProcess(src: string): boolean {
  return (
    /\bTransformersEmbeddingProvider\b/.test(src) ||
    /\bgetEmbedder\b/.test(src) ||
    /embeddings\/transformers/.test(src)
  );
}

/**
 * Single-pass, string-aware comment stripper. Blanks the INTERIOR of line
 * comments, block comments, and string literals (single/double/template) with
 * spaces, preserving newlines so every output line index matches the input.
 * Because it is stateful, a `/*` or `//` appearing inside a `//` comment or a
 * string literal can never open a comment span — fixing the false-negative the
 * single-regex stripper had on `// … dist/hooks/*.js`.
 */
function stripComments(src: string): string {
  let out = '';
  type S = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let state: S = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i++; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i++; continue; }
      if (c === "'") { state = 'sq'; out += c; continue; }
      if (c === '"') { state = 'dq'; out += c; continue; }
      if (c === '`') { state = 'tpl'; out += c; continue; }
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; continue; }
      out += ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    // string states: blank the interior; a backslash escapes the next char
    if (c === '\\') { out += '  '; i++; continue; }
    if (c === '\n') { state = 'code'; out += '\n'; continue; } // defensive: unterminated string
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
      out += c;
      continue;
    }
    out += ' ';
  }
  return out;
}

/**
 * Is the opt-out marker on `rawLines[idx]`, or anywhere in the contiguous block
 * of comment/blank lines DIRECTLY ABOVE it? The upward scan stops at the first
 * real (non-comment, non-blank) line, so the marker can never leak from an
 * unrelated earlier comment separated by code.
 */
function markedAtOrAbove(rawLines: string[], idx: number): boolean {
  if (rawLines[idx]?.includes(OPT_OUT)) return true;
  for (let j = idx - 1; j >= 0; j--) {
    const line = rawLines[j].trim();
    const isComment = line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
    if (line !== '' && !isComment) break; // hit real code → stop
    if (rawLines[j].includes(OPT_OUT)) return true;
  }
  return false;
}

/**
 * 1-based line numbers of UNMARKED `process.exit(` calls. Detection runs on the
 * comment/string-stripped source so a `process.exit(` inside a comment or string
 * never counts; the marker is checked against the ORIGINAL lines (it lives in a
 * comment).
 */
function unmarkedProcessExits(src: string): number[] {
  const rawLines = src.split('\n');
  const codeLines = stripComments(src).split('\n');
  const offenders: number[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    if (!/process\.exit\s*\(/.test(codeLines[i])) continue;
    if (markedAtOrAbove(rawLines, i)) continue;
    offenders.push(i + 1);
  }
  return offenders;
}

describe('P14-lint-guard — real-embedder scripts must drain naturally (no abrupt process.exit)', () => {
  const files = scriptFiles();

  it('discovers the battle harness scripts (sanity: the glob is not empty)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('verify-web.mjs'))).toBe(true);
  });

  it('classifies in-process real-embedder vs mock/child-process scripts correctly', () => {
    const rel = (p: string) => p.slice(REPO.length + 1);
    const real = files.filter((f) => loadsRealEmbedderInProcess(readFileSync(f, 'utf8'))).map(rel).sort();
    // probe-lossless uses MockEmbeddingProvider; smoke-mcp only spawns a child —
    // neither is an in-process real-embedder script.
    expect(real).not.toContain('scripts/battle/probe-lossless.mjs');
    expect(real).not.toContain('scripts/smoke-mcp.mjs');
    for (const expected of [
      'scripts/battle/verify-web.mjs',
      'scripts/battle/verify-nli.mjs',
      'scripts/battle/verify-hooks.mjs',
      'scripts/battle/sim-solo.mjs',
      'scripts/battle/sim-team.mjs',
      'scripts/battle/verify-scale.mjs',
      'scripts/battle/probe-embedder.mjs',
    ]) {
      expect(real).toContain(expected);
    }
  });

  it.each(scriptFiles().map((f) => [f.slice(REPO.length + 1), f] as const))(
    '%s — no unmarked process.exit() when the real embedder is loaded in-process',
    (rel, abs) => {
      const src = readFileSync(abs, 'utf8');
      if (!loadsRealEmbedderInProcess(src)) return; // not enforced for mock/child scripts
      const offenders = unmarkedProcessExits(src);
      expect(
        offenders,
        `${rel} loads the real embedder in-process but calls process.exit() at line(s) ` +
          `${offenders.join(', ')} without the "${OPT_OUT}" opt-out marker. A hard process.exit() while ` +
          `the onnxruntime worker threads are live aborts with "mutex lock failed" (exit 134), masking ` +
          `pass/fail. Use process.exitCode + natural drain instead, or — only if the exit provably fires ` +
          `before the embedder loads or after it failed to load — add a "${OPT_OUT}" comment on that line.`,
      ).toEqual([]);
    },
  );
});

/**
 * Robustness unit tests — prove the scanner is not vacuous and that the
 * reviewer-found false-negative (a `//`-embedded `/*` swallowing later code) is
 * actually fixed, so the guard cannot silently stop seeing real exits.
 */
describe('P14-lint-guard — comment-stripper robustness', () => {
  it('does NOT let a // comment containing /* open a block comment (the verify-hooks:5 bug)', () => {
    // Mirrors verify-hooks.mjs: a `//` comment mentions a glob path `hooks/*.js`,
    // then a JSDoc block closes far below. The single-regex stripper blanked
    // everything between, hiding the exit. The scanner must still SEE it.
    const src = [
      '// build the compiled hooks under dist/hooks/*.js before running',
      '/** unrelated jsdoc block',
      ' * spanning a few lines',
      ' */',
      'if (broken) process.exit(7);',
    ].join('\n');
    expect(unmarkedProcessExits(src)).toEqual([5]);
  });

  it('does NOT flag process.exit() mentioned inside a // line comment or /* block */', () => {
    const src = [
      '// do not call process.exit() here',
      '/* the old code used process.exit(0) on success */',
      'const ok = true;',
    ].join('\n');
    expect(unmarkedProcessExits(src)).toEqual([]);
  });

  it('does NOT flag process.exit( inside a string literal', () => {
    const src = 'const msg = "never write process.exit(0) in a real-embedder script";';
    expect(unmarkedProcessExits(src)).toEqual([]);
  });

  it('does NOT treat // inside a string (e.g. a URL) as a comment', () => {
    const src = [
      'const url = "https://example.com/x"; process.exit(3);',
    ].join('\n');
    // The `//` in the URL is inside a string, so the trailing exit stays visible.
    expect(unmarkedProcessExits(src)).toEqual([1]);
  });

  it('honors the opt-out marker on the same line and in the comment block above', () => {
    const sameLine = 'process.exit(2); // mcp-memory:allow-process-exit pre-model guard';
    expect(unmarkedProcessExits(sameLine)).toEqual([]);

    const blockAbove = [
      'console.error("bad args");',
      '// mcp-memory:allow-process-exit — fires before the embedder loads',
      'process.exit(2);',
    ].join('\n');
    expect(unmarkedProcessExits(blockAbove)).toEqual([]);
  });

  it('does NOT let a marker leak from an earlier comment separated by code', () => {
    const src = [
      '// mcp-memory:allow-process-exit — justifies the exit two lines down? no.',
      'doRealWork();',
      'process.exit(0);',
    ].join('\n');
    // A real code line sits between the marker comment and the exit → not covered.
    expect(unmarkedProcessExits(src)).toEqual([3]);
  });
});
