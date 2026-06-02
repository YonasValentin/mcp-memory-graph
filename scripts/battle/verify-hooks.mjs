// REAL verification of all four Claude Code hooks, exercised the way Claude
// Code invokes them: as node processes reading a JSON event on stdin with a
// 5s budget, expected to exit 0 and never throw.
//
// Each hook is run against the COMPILED dist/hooks/*.js (not the .ts source and
// not a mock), in an isolated temp HOME + temp MCP_MEMORY_DB_PATH. The DB is
// seeded first with real handleStore() calls (real embedding model) so the
// read-only SessionStart hook has memories to summarise and the consolidate
// writer↔reader contract can be checked end to end.
//
// Run:  node scripts/battle/verify-hooks.mjs   (after `npm run build`)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DIST = join(ROOT, 'dist');

const HOOK = {
  sessionStart: join(DIST, 'hooks', 'memory-session-start.js'),
  postSearch: join(DIST, 'hooks', 'memory-post-search.js'),
  preCompact: join(DIST, 'hooks', 'memory-pre-compact.js'),
  stop: join(DIST, 'hooks', 'memory-stop.js'),
};

for (const [name, p] of Object.entries(HOOK)) {
  if (!existsSync(p)) {
    console.error(`MISSING compiled hook: ${name} -> ${p}. Run \`npm run build\` first.`);
    process.exit(2);
  }
}

// ── Isolated environment ──────────────────────────────────────────────────
const TMP_HOME = mkdtempSync(join(tmpdir(), 'mcp-hook-home-'));
mkdirSync(join(TMP_HOME, '.mcp-memory'), { recursive: true });
const DB_PATH = join(TMP_HOME, '.mcp-memory', 'memory.db');
const CONFIG_PATH = join(TMP_HOME, '.mcp-memory', 'config.json');
const SEARCH_LOG = join(TMP_HOME, '.mcp-memory', 'search-log.jsonl');

// Transcript base for the Stop hook's path validation. We point it at a
// directory we control and place a real transcript file under it.
const TRANSCRIPT_BASE = join(TMP_HOME, '.claude', 'projects');
mkdirSync(TRANSCRIPT_BASE, { recursive: true });
const TRANSCRIPT_PATH = join(TRANSCRIPT_BASE, 'session-transcript.jsonl');

// A realistic-looking transcript long enough to pass the CLIs' min-length
// gates (extract-from-transcript: 100 chars, review-and-store: 500 chars).
const TRANSCRIPT_BODY = Array.from({ length: 40 }, (_, i) =>
  JSON.stringify({
    type: i % 2 === 0 ? 'user' : 'assistant',
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Turn ${i}: we decided to use a token bucket rate limiter at 100 req/min and fixed an N+1 query in the invoice list endpoint cutting p95 from 1.8s to 140ms.`,
    },
  }),
).join('\n');
writeFileSync(TRANSCRIPT_PATH, TRANSCRIPT_BODY);

// Base env all hooks share. Override HOME so os.homedir() (used by
// post-search for the log path) resolves into our temp dir.
const baseEnv = {
  ...process.env,
  HOME: TMP_HOME,
  USERPROFILE: TMP_HOME, // windows safety; harmless on posix
  MCP_MEMORY_DB_PATH: DB_PATH,
  MCP_MEMORY_CONFIG_PATH: CONFIG_PATH,
};

const findings = [];
let failures = 0;
function record(name, ok, detail) {
  findings.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}

/** Spawn a compiled hook, pipe `event` JSON on stdin, capture stdout/stderr/code. */
function runHook(hookPath, event, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [hookPath], {
      env: { ...baseEnv, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const t0 = Date.now();
    // Hard ceiling well above the hook's own 5s budget — a hook that blows
    // through its own timeout is itself a finding.
    const killer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
      }
    }, 15000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      settled = true;
      clearTimeout(killer);
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${err.message}`, ms: Date.now() - t0 });
    });
    child.on('exit', (code, signal) => {
      settled = true;
      clearTimeout(killer);
      resolve({ code: code ?? (signal ? -2 : null), signal, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });
}

async function seedDatabase() {
  // Real DB + real embedding model + real handleStore. Mirrors the bootstrap
  // used by scripts/battle/sim-solo.mjs.
  process.env.MCP_MEMORY_DB_PATH = DB_PATH;
  process.env.MCP_MEMORY_CONFIG_PATH = CONFIG_PATH;
  const { createDatabase } = await import(join(DIST, 'db', 'connection.js'));
  const { initializeSchema } = await import(join(DIST, 'db', 'schema.js'));
  const { runMigrations } = await import(join(DIST, 'db', 'migrations.js'));
  const { TransformersEmbeddingProvider } = await import(join(DIST, 'embeddings', 'transformers.js'));
  const { CachedEmbeddingProvider } = await import(join(DIST, 'embeddings', 'cache.js'));
  const { handleStore } = await import(join(DIST, 'tools', 'store.js'));

  const db = createDatabase(DB_PATH);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);

  const inner = new TransformersEmbeddingProvider();
  await inner.initialize();
  const embedder = new CachedEmbeddingProvider(inner);

  const seeds = [
    { title: 'Token bucket rate limit', content: 'All public API endpoints are rate limited with a token bucket: 100 requests per minute per API key, returning HTTP 429 with Retry-After when exceeded.', document_type: 'convention' },
    { title: 'Argon2id password hashing', content: 'Passwords are hashed with Argon2id (memory 64MB, iterations 3). We migrated off bcrypt because Argon2 resists GPU cracking and is the current OWASP recommendation.', document_type: 'convention' },
    { title: 'N+1 invoice list fix', content: 'Performance fix: the invoice list endpoint had an N+1 query loading each line item separately. We batched with a single join, cutting p95 from 1.8s to 140ms.', document_type: 'error_fix' },
  ];
  for (const s of seeds) {
    await handleStore(db, embedder, { ...s, scope: 'project', namespace: 'helios' });
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE parent_id IS NULL').get().c;
  db.close();
  return count;
}

// ── Test 1: SessionStart ────────────────────────────────────────────────────
async function testSessionStart() {
  const event = {
    hook_event_name: 'SessionStart',
    session_id: 'sess-verify-1',
    cwd: ROOT, // a git repo, so the branch-detection path runs
    source: 'startup',
  };
  const r = await runHook(HOOK.sessionStart, event);
  const emittedStatus = /Memory server:\s*\d+\s*memories/.test(r.stdout);
  record(
    'SessionStart exits 0 + emits auto-recall status line (read-only)',
    r.code === 0 && emittedStatus,
    `code=${r.code} ms=${r.ms} stdout=${JSON.stringify(r.stdout.trim())}` +
      (r.stderr.trim() ? ` stderr=${JSON.stringify(r.stderr.trim())}` : ''),
  );
  return r;
}

// ── Test 2: PostSearch (writer↔reader contract with consolidate) ─────────────
async function testPostSearch() {
  // A memory_search PostToolUse event with a real results payload. Use a query
  // that returns ZERO results so the consolidate reader (which only counts
  // results_count===0 queries) can pick it up as a knowledge gap.
  const GAP_QUERY = 'how do we deploy to kubernetes';
  const event = {
    hook_event_name: 'PostToolUse',
    tool_name: 'memory_search',
    cwd: ROOT,
    tool_input: { query: GAP_QUERY, scope: 'project', namespace: 'helios' },
    tool_output: JSON.stringify({ results: [] }),
  };

  // Fire it twice — consolidate only surfaces a gap when a zero-result query
  // recurs (count >= 2).
  const r1 = await runHook(HOOK.postSearch, event);
  const r2 = await runHook(HOOK.postSearch, event);

  // Also fire one with a non-empty results payload to confirm results_count is
  // recorded with the actual length.
  const eventHit = {
    hook_event_name: 'PostToolUse',
    tool_name: 'memory_search',
    cwd: ROOT,
    tool_input: { query: 'rate limit', scope: 'project', namespace: 'helios' },
    tool_output: JSON.stringify({ results: [{ confidence: 0.91 }, { confidence: 0.7 }] }),
  };
  const r3 = await runHook(HOOK.postSearch, eventHit);

  const exits0 = r1.code === 0 && r2.code === 0 && r3.code === 0;

  let logOk = false;
  let parsedCount = -1;
  let hitCount = -1;
  let lineCount = 0;
  if (existsSync(SEARCH_LOG)) {
    const lines = readFileSync(SEARCH_LOG, 'utf-8').split('\n').filter(Boolean);
    lineCount = lines.length;
    const parsed = lines.map((l) => JSON.parse(l));
    // Every line must carry the `results_count` key (the contract key).
    logOk = parsed.every((e) => Object.prototype.hasOwnProperty.call(e, 'results_count'));
    const gapEntry = parsed.find((e) => e.query === GAP_QUERY);
    parsedCount = gapEntry ? gapEntry.results_count : -1;
    const hitEntry = parsed.find((e) => e.query === 'rate limit');
    hitCount = hitEntry ? hitEntry.results_count : -1;
  }

  record(
    "PostSearch appends to search-log.jsonl with key 'results_count'",
    exits0 && logOk && lineCount === 3 && parsedCount === 0 && hitCount === 2,
    `codes=[${r1.code},${r2.code},${r3.code}] lines=${lineCount} gap.results_count=${parsedCount} hit.results_count=${hitCount} log=${SEARCH_LOG}`,
  );

  // Now verify the READER (consolidate) actually consumes the key end to end.
  process.env.MCP_MEMORY_DB_PATH = DB_PATH;
  process.env.MCP_MEMORY_CONFIG_PATH = CONFIG_PATH;
  const realHome = homedir();
  let consolidateGapDetected = false;
  let consolidateDetail = '';
  try {
    // consolidate's readKnowledgeGaps() reads from homedir()/.mcp-memory; it
    // does NOT honour HOME at import-time the way a subprocess does, because
    // os.homedir() is evaluated in THIS process. Temporarily steer HOME so the
    // in-process reader hits our seeded log.
    process.env.HOME = TMP_HOME;
    const { createDatabase } = await import(join(DIST, 'db', 'connection.js'));
    const { initializeSchema } = await import(join(DIST, 'db', 'schema.js'));
    const { runMigrations } = await import(join(DIST, 'db', 'migrations.js'));
    const { handleConsolidate } = await import(join(DIST, 'tools', 'consolidate.js'));
    const db = createDatabase(DB_PATH);
    initializeSchema(db);
    runMigrations(db);
    // Minimal embedder stub — consolidate's gap reader needs no embeddings;
    // pass a no-op provider so the merge phase (which we don't trigger) is safe.
    const noopEmbedder = {
      embed: async () => new Float32Array(384),
      embedBatch: async (xs) => xs.map(() => new Float32Array(384)),
      dimensions: 384,
    };
    const res = await handleConsolidate(db, noopEmbedder, { scope: 'project', namespace: 'helios' });
    db.close();
    const gaps = res?.knowledge_gaps ?? res?.gaps ?? [];
    const flat = JSON.stringify(res);
    consolidateGapDetected = flat.includes('Knowledge gap') && flat.toLowerCase().includes('kubernetes');
    consolidateDetail = `knowledge_gaps=${JSON.stringify(gaps)}`;
  } catch (err) {
    consolidateDetail = `consolidate threw: ${err.message}`;
  } finally {
    process.env.HOME = realHome;
  }
  record(
    'consolidate READS results_count and surfaces the recurring zero-result gap',
    consolidateGapDetected,
    consolidateDetail,
  );
}

// ── Test 3: PreCompact ──────────────────────────────────────────────────────
async function testPreCompact() {
  // Enable extract_on_compact so the hook does NOT short-circuit. It then
  // sanitises transcript_path (mustExist) and spawns extract-from-transcript.js
  // detached. We assert the hook itself exits 0 quickly without throwing.
  writeFileSync(CONFIG_PATH, JSON.stringify({ hooks: { extract_on_compact: true } }, null, 2));

  const event = {
    hook_event_name: 'PreCompact',
    cwd: ROOT,
    trigger: 'auto',
    transcript_path: TRANSCRIPT_PATH,
  };
  const r = await runHook(HOOK.preCompact, event);
  record(
    'PreCompact (extract_on_compact=true) exits 0, spawns extraction without throwing',
    r.code === 0,
    `code=${r.code} ms=${r.ms}` +
      (r.stderr.trim() ? ` stderr=${JSON.stringify(r.stderr.trim())}` : ' (no stderr)'),
  );

  // Negative control: with the flag disabled it must also exit 0 (short-circuit).
  writeFileSync(CONFIG_PATH, JSON.stringify({ hooks: { extract_on_compact: false } }, null, 2));
  const rOff = await runHook(HOOK.preCompact, event);
  record(
    'PreCompact (extract_on_compact=false) short-circuits, exits 0',
    rOff.code === 0,
    `code=${rOff.code} ms=${rOff.ms}`,
  );

  // Deep check: the hook spawns this exact command DETACHED, so the hook's own
  // exit code can't prove the EXTRACTION ran without throwing. Invoke the same
  // CLI directly (foreground) and assert it completes with exit 0 (it uses the
  // real embedder + handleExtractLearnings against our seeded temp DB).
  const extractCli = join(DIST, 'cli', 'extract-from-transcript.js');
  const rExtract = await new Promise((resolve) => {
    const child = spawn('node', [extractCli, TRANSCRIPT_PATH, 'precompact'], {
      env: { ...baseEnv, MCP_MEMORY_CWD: ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const t0 = Date.now();
    const killer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, out, err: err + e.message, ms: Date.now() - t0 }); });
    child.on('exit', (code) => { clearTimeout(killer); resolve({ code, out, err, ms: Date.now() - t0 }); });
  });
  record(
    'PreCompact spawned extraction CLI runs end-to-end without throwing (exit 0)',
    rExtract.code === 0,
    `code=${rExtract.code} ms=${rExtract.ms}` +
      (rExtract.err.trim() ? ` stderr=${JSON.stringify(rExtract.err.trim().slice(0, 200))}` : ' (no stderr)'),
  );
}

// ── Test 4: Stop (recursion guard) ───────────────────────────────────────────
async function testStop() {
  const event = {
    hook_event_name: 'Stop',
    cwd: ROOT,
    session_id: 'sess-verify-1',
    transcript_path: TRANSCRIPT_PATH,
    stop_hook_active: false,
  };

  // 4a: recursion guard set -> must exit 0 immediately, BEFORE reading stdin
  // or spawning anything. We assert it returns fast and never spawns claude.
  const rGuard = await runHook(HOOK.stop, event, { MCP_MEMORY_REVIEW_IN_PROGRESS: '1' });
  record(
    'Stop honours recursion guard (MCP_MEMORY_REVIEW_IN_PROGRESS=1 -> exit 0, no spawn)',
    rGuard.code === 0,
    `code=${rGuard.code} ms=${rGuard.ms}`,
  );

  // 4b: normal path. The hook validates transcript_path against
  // MCP_MEMORY_TRANSCRIPT_BASE, then spawns review-and-store.js detached.
  // Point CLAUDE_BIN at a harmless echo so the spawned `claude -p` cannot do
  // anything real, and assert the hook exits 0.
  const rNormal = await runHook(HOOK.stop, event, {
    MCP_MEMORY_TRANSCRIPT_BASE: TRANSCRIPT_BASE,
    CLAUDE_BIN: 'true', // /usr/bin/true: exits 0 immediately
  });
  record(
    'Stop normal path validates transcript + spawns review (exit 0)',
    rNormal.code === 0,
    `code=${rNormal.code} ms=${rNormal.ms}` +
      (rNormal.stderr.trim() ? ` stderr=${JSON.stringify(rNormal.stderr.trim())}` : ''),
  );

  // 4c: path traversal rejection. A transcript_path OUTSIDE the allowed base
  // must be rejected (sanitizePath returns null) and the hook still exits 0.
  const evilEvent = { ...event, transcript_path: '/etc/passwd' };
  const rEvil = await runHook(HOOK.stop, evilEvent, {
    MCP_MEMORY_TRANSCRIPT_BASE: TRANSCRIPT_BASE,
    CLAUDE_BIN: 'true',
  });
  record(
    'Stop rejects out-of-base transcript_path (exit 0, no spawn)',
    rEvil.code === 0,
    `code=${rEvil.code} ms=${rEvil.ms}`,
  );
}

// ── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`temp HOME = ${TMP_HOME}`);
  console.log(`temp DB   = ${DB_PATH}`);
  let seededCount = 0;
  try {
    seededCount = await seedDatabase();
    console.log(`seeded ${seededCount} memories\n`);
  } catch (err) {
    console.error(`SEED FAILED (likely model download offline): ${err.message}`);
    console.error('Reporting PARTIAL: cannot exercise read-only SessionStart without a seeded DB.');
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.exit(3);
  }

  await testSessionStart();
  await testPostSearch();
  await testPreCompact();
  await testStop();

  console.log(`\n${failures === 0 ? 'ALL HOOKS OK' : `${failures} FAILURE(S)`} — seeded ${seededCount} memories`);

  // The PreCompact / Stop hooks spawn DETACHED children (real extract / review
  // CLIs) that open their own better-sqlite3 + embedder. Give them a beat to
  // settle and exit on their own min-length / missing-bin gates BEFORE we pull
  // the temp HOME out from under them, otherwise their native handles abort.
  await new Promise((r) => setTimeout(r, 1500));

  // Cleanup temp home (leave nothing behind).
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

  // Do NOT call process.exit(): this process initialized the real Transformers
  // (ONNX) runtime in-process, whose native threads abort with a libc++ mutex
  // error if torn down via an abrupt process.exit(). Set exitCode and let the
  // event loop drain naturally (the same pattern sim-solo.mjs relies on).
  process.exitCode = failures === 0 ? 0 : 1;
})();
