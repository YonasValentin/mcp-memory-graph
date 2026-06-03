export const meta = {
  name: 'battle-personas-mcp-memory-v3',
  description: 'Battle test of mcp-memory at HEAD 39ff196 (post open-items fix wave): a brand-NEW solo user + a real multi-dev TEAM lead, 12 refreshed skeptics regression-probe F1/F1b/P11/P10-P14/P8, each major/blocker adversarially refute-verified, then a completeness critic',
  phases: [
    { title: 'Battle', detail: '14 personas drive real dist handlers vs /tmp throwaway, probe session-4 fixes + documented gotchas' },
    { title: 'Verify', detail: 'adversarial refute pass per major/blocker on a fresh instance' },
    { title: 'Critic', detail: 'completeness critic: what modality/claim/fix did we NOT test' },
  ],
}

const REPO = '/Users/yonasvalentin/Projekter/mcp-memory-server'
const SKILL = '/Users/yonasvalentin/.claude/skills/mcp-memory'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    persona: { type: 'string' },
    executed: { type: 'boolean', description: 'did you actually run real code against a local instance' },
    scenarios_run: { type: 'array', items: { type: 'string' } },
    capabilities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          worked: { type: 'boolean' },
          evidence: { type: 'string', description: 'concrete output / assertion that proves it' },
        },
        required: ['name', 'worked', 'evidence'],
      },
    },
    regression_checks: {
      type: 'array',
      description: 'session-4 fixes you re-verified still hold (F1 ns-store, F1b ns ingest/session/core, P11 migration throw, P10/P14 teardown, P8 logger redaction)',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fix: { type: 'string' },
          holds: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['fix', 'holds', 'evidence'],
      },
    },
    gotchas_verified: {
      type: 'array',
      description: 'documented gotchas you reproduced empirically',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          gotcha: { type: 'string' },
          holds: { type: 'boolean', description: 'true = behaves as the skill documents' },
          evidence: { type: 'string' },
        },
        required: ['gotcha', 'holds', 'evidence'],
      },
    },
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          repro: { type: 'string', description: 'exact steps + the script you ran, so a second engineer can re-run it' },
          evidence: { type: 'string' },
          suspected_cause: { type: 'string' },
        },
        required: ['severity', 'title', 'repro', 'evidence', 'suspected_cause'],
      },
    },
    skill_findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['missing', 'inaccurate', 'unclear', 'good'] },
          where: { type: 'string', description: 'which skill file/section' },
          detail: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
        required: ['type', 'where', 'detail', 'suggested_fix'],
      },
    },
    notes: { type: 'string', description: 'quality + competitive take; for a newcomer: could you succeed from the skill alone?' },
  },
  required: ['persona', 'executed', 'scenarios_run', 'capabilities', 'regression_checks', 'gotchas_verified', 'bugs', 'skill_findings', 'notes'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reproduced: { type: 'boolean', description: 'did the bug actually reproduce on your fresh instance' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'inconclusive'] },
    corrected_severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'not-a-bug'] },
    evidence: { type: 'string', description: 'the exact output that confirms or refutes' },
    fix_hint: { type: 'string', description: 'if confirmed: the file/function + minimal fix direction' },
  },
  required: ['reproduced', 'verdict', 'corrected_severity', 'evidence', 'fix_hint'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    coverage_gaps: {
      type: 'array',
      description: 'modalities/claims/fixes the battle did NOT test or tested weakly',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          gap: { type: 'string' },
          why_it_matters: { type: 'string' },
          how_to_test: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['gap', 'why_it_matters', 'how_to_test', 'priority'],
      },
    },
    session4_fix_coverage: {
      type: 'array',
      description: 'for each session-4 fix, was it regression-probed by at least one persona with real evidence?',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fix: { type: 'string' },
          covered: { type: 'boolean' },
          by_whom: { type: 'string' },
        },
        required: ['fix', 'covered', 'by_whom'],
      },
    },
    recommend_another_round: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['coverage_gaps', 'session4_fix_coverage', 'recommend_another_round', 'summary'],
}

const SESSION4 = `THIS BUILD (HEAD 39ff196) just closed an OPEN-ITEMS FIX WAVE — REGRESSION-PROBE these where your scenario touches them, and report any that DON'T hold as a bug:
- F1  fix(server): memory_store is now force-scoped — with env MCP_API_NAMESPACE set, a store with a different caller namespace persists under the FORCED namespace (write isolation).
- F1b fix(server): memory_ingest, memory_session_note, core_memory_get/append/replace are ALSO force-scoped now (same withForcedNs wrap). memory_import is intentionally NOT (per-item namespace; documented follow-up).
- P11 fix(migrations): a corrupt/non-numeric schema_version in schema_meta now THROWS a clear error (was: parseInt→NaN → silently applied ZERO migrations). Verify runMigrations throws on 'garbage'/'9abc'/'-1' and still migrates valid versions.
- P10/P14 fix(connection): createDatabase connections are tracked; closeAllDatabases() (wired into the process-exit handler) closes survivors so a script that forgot db.close() no longer aborts 'mutex lock failed' (exit 134). dist exports closeAllDatabases + trackedConnectionCount.
- P8 fix(logger): redact() is now RECURSIVE (nested objects + arrays), covers access_token/refresh_token/client_secret/private_key/session_token/bearer, and survives circular input (WeakSet + depth cap). A nested secret must come out '[REDACTED]'.`

const DRIVE_GUIDE = `You are a skeptical senior engineer battle-testing the mcp-memory-server product BY USING IT HANDS-ON, exactly as a real user would, guided by its skill.

STEP 1 — Read the skill you are testing (this is also a test OF the skill):
- ${SKILL}/SKILL.md
- and the references/*.md relevant to your scenario (tool-catalog, workflows, gotchas, architecture, developing, rest-and-ops).
Treat the skill as your operating manual. If following it does NOT produce the documented behavior, that is a high-value finding (skill_findings).

STEP 2 — Set up a THROWAWAY LOCAL instance. NEVER touch the production server (the mcp__mcp-memory__* tools / ~/.mcp-memory/memory.db / mcp.yonasvalentin.dk) or any real user data. This is a LIVE production homelab — writing to it is destructive. LOCAL /tmp throwaway ONLY.
- Repo: ${REPO} (already freshly built to dist/ at HEAD 39ff196 — import compiled .js from dist/, not src/). dist already includes ALL the session-4 fixes below.
- Drive the REAL compiled handlers against a temp SQLite DB you create under /tmp/persona-<you>/.
- Templates that show the exact import + setup pattern — READ ONE FIRST: scripts/battle/sim-solo.mjs (solo), scripts/battle/sim-team.mjs (git vault), scripts/battle/verify-nli.mjs (real NLI), scripts/battle/verify-scale.mjs (bulk), scripts/battle/verify-web.mjs (dashboard), scripts/bench/retrieval.mjs (quality).
- Embeddings: default to MockEmbeddingProvider (dist/testing/mock-embedder.js) for speed + determinism — fine for capability / flow / correctness / gotcha checks. Mock vectors are NOT semantically meaningful, so do NOT judge retrieval PRECISION with mock. If your scenario needs real semantics, load the real provider (dist/embeddings/transformers.js) / real NLI — models are cached offline under node_modules/@huggingface/transformers/.cache.
- createTestDb (dist/testing/test-db.js) gives a fresh in-memory schema-migrated DB; for bitemporal/persistence/file/WAL/teardown tests use a temp FILE DB path under /tmp/persona-<you>/.
- Run node with cwd = ${REPO} so node_modules + dist resolve: write your script to /tmp/persona-<you>/run.mjs then run \`cd ${REPO} && node /tmp/persona-<you>/run.mjs\`. Clean up /tmp/persona-<you>/ when done.

STEP 3 — Actually RUN it. Iterate until your script executes (fix import paths/signatures by reading the dist .d.ts or the template). Assert expected behavior. Probe edge cases like a real human deciding whether to trust this product with their memory.

STEP 4 — EMPIRICALLY verify the documented gotchas relevant to your scenario AND the session-4 regression checks below — reproduce them, do not take them on faith. If a documented gotcha is WRONG or no longer reproduces, that is a finding (skill_findings type=inaccurate).

${SESSION4}

REPORT via the structured schema. Be ruthless and specific: every bug with a REAL re-runnable repro (include the script), every skill inaccuracy with the fix, every capability that worked (with evidence) or failed, and fill regression_checks for any session-4 fix you touched. No praise-padding. If you could not execute, set executed=false and explain why in notes.

YOUR PERSONA + SCENARIO:
`

const VERIFY_GUIDE = `You are an adversarial verifier. A battle-test persona reported a bug in mcp-memory-server. Your job is to INDEPENDENTLY try to REPRODUCE it on your OWN fresh throwaway instance — and default toward REFUTING it unless it clearly reproduces. False bugs waste fix budget; be skeptical.

SETUP (same safety rules): NEVER touch production (mcp__mcp-memory__* / ~/.mcp-memory / mcp.yonasvalentin.dk). Repo ${REPO}, dist already built at HEAD 39ff196. Drive REAL compiled dist/*.js handlers against a temp DB under /tmp/verify-<n>/. Use scripts/battle/*.mjs as import templates. Run \`cd ${REPO} && node /tmp/verify-<n>/run.mjs\`.

PROCESS:
1. Re-create the reported repro from scratch (write + run your own script). Do NOT trust the persona's script blindly — re-derive it.
2. If it reproduces: verdict=confirmed, give the exact output, and a fix_hint (file/function + minimal direction).
3. If it does NOT reproduce (behaves correctly, or the persona misread output / used wrong API / mock-embedder artifact / tested non-production path): verdict=refuted with the evidence showing correct behavior.
4. If you genuinely cannot tell: verdict=inconclusive with what is missing.
Set corrected_severity honestly (downgrade theatrics; 'not-a-bug' if refuted).

THE REPORTED BUG:
`

const personas = [
  {
    label: 'P-NEW-SOLO-cold-firsttimer',
    scenario: `You are an engineer who has NEVER used this tool before. You just found the mcp-memory skill and want to capture + recall knowledge on a coding project. Drive ENTIRELY from the skill — read SKILL.md "Driver quick start" + references/workflows.md + references/tool-catalog.md and follow them literally, as a newcomer would, against a /tmp throwaway DB (do NOT run the real \`memory init\` wizard — it touches the global filesystem; instead drive the handlers directly the way the skill's quick-start describes). The TEST: can a newcomer SUCCEED using only the skill? Every place the skill misleads or omits something a first-timer needs is a HIGH-VALUE skill_finding.
DO, in order, like a real first session: (1) first memory_store of a discrete decision (with document_type + tags); (2) a few more stores (a pattern, a bug-fix); (3) first memory_search by MEANING and confirm you get them back; (4) try memory_query for a compact answer; (5) naturally hit the documented onboarding gotchas and confirm each: privacy default (an UNSCOPED search HIDES scope:'user' memories — store one as scope:'user', search unscoped, watch it NOT appear, then re-search with scope:'user'); the summary/answer field is confidence_level NOT confidence; memory_list returns {items} (not .results); memory_search rerank default ON over MCP. (6) Read what the skill says the RRF score means (NOT a confidence) and verify. Judge: is the "two tools" mental model (store/search) enough to be productive? Where did you get stuck or surprised? Report the newcomer-success verdict in notes. (Mock embedder is fine except step 3/4 semantic recall — load the real embedder for those so "search by meaning" is a fair test.)`,
  },
  {
    label: 'P-TEAM-multidev-gitvault',
    scenario: `You are a 2-3 developer team sharing memory through a git vault (Bruno model — no shared SQL server). Use scripts/battle/sim-team.mjs as your template. Drive from references/workflows.md (team section) + rest-and-ops.md. VERIFY end-to-end: (1) \`memory vault-init\` writes .gitattributes binding the union-merge driver (NOT just export_vault); (2) memory_export_vault writes .md + frontmatter for each dev; (3) two devs make CONCURRENT edits and git-merge cleanly via the union driver on .memory/graph.json (no conflict markers); (4) vault_sync reconciles by frontmatter id — NO duplicates on re-sync; (5) memory_attribution.by_agent rolls up correctly. REGRESSION-CHECK 9ffbc9d (prior session): set a non-default agent_id AND access_level on a memory, export to vault, re-run vault_sync, and confirm BOTH survive the round-trip (was: sync hardcoded access_level='internal' + dropped agent_id). REGRESSION-CHECK F1/F1b (this session): with MCP_API_NAMESPACE set to a forced team namespace, confirm memory_store AND memory_ingest AND memory_session_note all persist under the FORCED namespace even when a dev passes a different namespace (shared-endpoint write isolation). Concurrency: a few parallel writers against one FILE db (WAL) — no corruption, no SQLITE_BUSY crash. EMPIRICALLY verify the 'vault .md round-trip resets confidence/access/stability but PRESERVES importance_score/created_at/updated_at' gotcha.`,
  },
  {
    label: 'P1-solo-lifecycle',
    scenario: `Solo developer lifecycle. memory_store several decisions/patterns/fixes with tags + document_type; memory_search to recall; memory_update one (verify versioning + re-embed); store a CONTRADICTING fact with on_conflict='supersede' and verify bi-temporal invalidation (REAL NLI — load it like verify-nli.mjs, or clearly note if stubbed); memory_versions + diff + restore; memory_history. EMPIRICALLY VERIFY the privacy-default gotcha. REGRESSION: soft-forget (memory_forget hard:false) → leaves default search → memory_restore → reinstated + valid_to/tx_expired cleared (un-tombstone); restore returns {reinstated:true, uncondensed:false} for a never-condensed memory.`,
  },
  {
    label: 'P2-enterprise-legal',
    scenario: `Enterprise/legal. memory_ingest a multi-section document and verify chunking (parent_id children, chunk_index); department-scoped memory_search; memory_query_structured exact filter. Governance: memory_forget hard:true → returns a portability export FIRST then row gone (cascades FTS/vec); memory_forget hard:false → excluded from default search but returned by as_of + recoverable → memory_restore returns it to default recall. EMPIRICALLY VERIFY 'as_of reconstructs validity not content'. REGRESSION F1b: ingest under a forced MCP_API_NAMESPACE persists chunks in the forced namespace (not the caller's).`,
  },
  {
    label: 'P4-obsidian-power-user',
    scenario: `Obsidian power user. vault_sync a small temp vault of .md notes IN (frontmatter/tags/wikilinks extracted); memory_canvas OUT → valid JSON Canvas 1.0 (nodes+edges, deterministic grid); memory_unlinked_mentions (real embeddings or note); memory_template for decision + incident (section scaffolds); memory_session_note twice for one session_id → appends to SAME memory. Verify 'two vaults same basename collide' namespace gotcha. REGRESSION F1b: session_note under a forced namespace lands in the forced namespace.`,
  },
  {
    label: 'P5-knowledge-graph-alias',
    scenario: `Knowledge-graph + alias expansion. Store memories about related entities; memory_extract_entities to persist entities + relationships WITH aliases (PostgreSQL←[PG,Postgres]; Kubernetes←k8s). VERIFY: (a) memory_graph lookup by ALIAS resolves canonical; (b) hybridSearch use_graph:true with an alias-only query seeds the canonical entity's memories (import linkQueryEntities from dist/search/hybrid.js, assert canonical id for alias query; then a use_graph search surfaces the entity's memory though the query never names the canonical); (c) CONFIRM memory_query does NOT alias-expand (documented). memory_graph depth 1-3; memory_communities; memory_related. Verify normalizeName merge ('Node.js'/'nodejs'/'node js' → ONE). Verify idf_strength non-constant.`,
  },
  {
    label: 'P6-maintenance-ops',
    scenario: `Maintenance / librarian. Corpus with deliberate near-duplicates + an expired memory; memory_consolidate dry_run:true (PREVIEW) then apply (merges/prunes). EMPIRICALLY VERIFY the 'dry_run UNDER-counts merges' gotcha — does apply merge MORE than preview? (the skill SOFTENED this — not reproduced in 18 runs — so try hard and report either way). memory_condense then memory_restore (original preserved + {uncondensed:true}). COMBINED: soft-forget AND condense the same memory, single memory_restore → {reinstated:true, uncondensed:true}. memory_tiers; memory_questions. VERIFY stats gotchas (excludes retired/expired rows; file-db size non-zero). memory_export→memory_import round-trip symmetric (null fields, timestamps, agent_id, importance_score; live+top-level only; paginated).`,
  },
  {
    label: 'P7-bitemporal-scale-teardown',
    scenario: `Bitemporal + SQLite-persistence + TEARDOWN. Use a FILE-backed temp DB opened via createDatabase (dist/db/connection.js). Store memories, invalidate one, VERIFY invalidate-don't-delete: row exists with valid_to stamped, default search/list exclude it, as_of BEFORE returns it / AFTER does not. VERIFY as_of VECTOR-mode RECONSTRUCTS the retired fact (vec row retained). expires_at expiry + ISO-Z collation (same-day-expired rows do NOT leak into search). Re-open the DB file in a fresh process: persistence + idempotent migrations. REGRESSION P10/P14 (the headline teardown fix): (a) import { createDatabase, closeAllDatabases, trackedConnectionCount } from dist/db/connection.js — open several createDatabase connections, call closeAllDatabases(), assert all .open===false and trackedConnectionCount()===0; (b) open a createDatabase FILE db, do NOT close it, and process.exit(0) — confirm the process exits code 0 (not 134 'mutex lock failed'); run it a few times. Report any 134 abort or leak as a bug.`,
  },
  {
    label: 'P8-adversary-redteam',
    scenario: `Adversary / red-team. Try to BREAK confinement, tenancy, sanitization, secret-hygiene. Probe: (1) path traversal — vault/export path with ../ escaping root (confineToVault blocks?); (2) FTS injection — query with FTS5 metacharacters/quotes (sanitizeFtsQuery, no crash); (3) prototype pollution — vault .md frontmatter with __proto__/constructor (top-level stripped; nested meta.__proto__ survives but is it weaponizable?); (4) tenancy — set MCP_API_NAMESPACE: confirm by-id read of a foreign-namespace memory → not-found AND (REGRESSION F1/F1b) a WRITE (store/ingest/session_note/core_memory_append) with a foreign caller namespace is FORCED into the configured namespace (the write-isolation fix — try to write cross-namespace and prove you can't); (5) output sanitization — ANSI/control/zero-width/BiDi (sanitizeDeep strips, but PRESERVES ZWJ/ZWNJ + CJK); (6) REGRESSION P8 logger — import the logger from dist/lib/logger.js, log an object with a secret NESTED inside another object and inside an array-of-objects, and a key named access_token/client_secret, capturing stderr — confirm every secret comes out '[REDACTED]' and a CIRCULAR object does not throw; (7) oversized query (100k chars) accepted, not exploitable. Report any FAILURE to defend as a bug by impact.`,
  },
  {
    label: 'P9-concurrency-atomicity',
    scenario: `Concurrency / atomicity. FILE-backed temp DB with WAL (open via createDatabase). (1) Several concurrent writers (Promise.all of handleStore or multiple workers on the same file db) — no corruption, all rows land, no SQLITE_BUSY crash (check busy_timeout/WAL in dist/db/connection.js). (2) Atomicity: wrap a multi-step write in db.transaction and THROW mid-transaction — full rollback (no partial rows, no orphaned FTS/vec). (3) Concurrent store + consolidate prune on the same db — no half-deleted row (FTS/vec residue). (4) Re-open after a simulated crash (close without checkpoint) — WAL recovers. REGRESSION P10/P14: after your concurrent run, call closeAllDatabases() and confirm clean teardown (no 134). Report races/partial writes/index residue.`,
  },
  {
    label: 'P10-rest-tenancy-writepath',
    scenario: `HTTP/REST multi-namespace tenancy — FOCUS on the write path (F1/F1b). Boot the REST app: import buildApp from dist (see scripts/battle/verify-web.mjs) on an ephemeral port with raw node:http, env MCP_API_NAMESPACE set to a forced namespace. Then: (1) the only write-over-HTTP is POST /mcp (MCP-over-HTTP) — drive a memory_store / memory_ingest / memory_session_note / core_memory_append through it with a DIFFERENT caller namespace and confirm the persisted row is in the FORCED namespace (REGRESSION F1/F1b — this is the headline isolation fix; prove a tenant cannot write into another tenant's namespace); (2) by-id GET of a memory in a DIFFERENT namespace → 404; (3) many concurrent reads across would-be namespaces → NO cross-namespace leakage; (4) the REST /api/search rerank-off default (documented divergence vs MCP); (5) confirm there is NO POST /api/store create route (write is MCP-only) and that PATCH/DELETE guard via idIsInForcedNamespace. Report any tenancy leak as a blocker.`,
  },
  {
    label: 'P11-migration-corruptversion',
    scenario: `Migration / upgrade-path — FOCUS on the corrupt-version fix (P11/F2). (1) Create a FILE db, initializeSchema, then FORCE schema_version back to an early value (0 or 4) and run runMigrations — VERIFY it climbs to CURRENT_SCHEMA_VERSION (9) WITHOUT data loss for pre-migration rows. (2) Idempotency: run runMigrations AGAIN → no-op (no errors, no dup columns/indexes, version unchanged). (3) getReadOnlyDb on a BELOW-current db must THROW (assert-don't-migrate). (4) REGRESSION F2 (headline): set schema_meta.schema_version to 'garbage' (and separately '9abc' and '-1') and confirm runMigrations now THROWS a clear error naming schema_version/the bad value — NOT a silent no-op (pre-fix it applied ZERO migrations silently). Confirm a valid numeric version still migrates and that migrateDatabase's '0' seed path still works. Report any silent-skip, data loss, double-apply, or read-only migrate.`,
  },
  {
    label: 'P12-i18n-unicode',
    scenario: `i18n / unicode-at-scale. Store content in many scripts: CJK (中文/日本語/한국어), emoji incl. ZWJ sequences (👨‍👩‍👧), RTL (Arabic/Hebrew), combining diacritics, very long multibyte strings. VERIFY: (1) FTS5 keyword search finds CJK/emoji (or document the tokenizer limitation honestly); (2) vector store+retrieve round-trips exact bytes (no mojibake, no mid-codepoint truncation); (3) memory_export→memory_import preserves every codepoint; (4) normalizeName on unicode is sane (symbol-only djb2 fallback fires for '++'/'#'); (5) output sanitization strips control/BiDi but PRESERVES ZWJ/ZWNJ (the prior fa435fc fix) + CJK/emoji — does sanitizeDeep over-strip? Report corruption/over-stripping.`,
  },
  {
    label: 'P13-realmodel-quality',
    scenario: `Real-model retrieval-QUALITY (REAL embedder + reranker — the only way to judge precision). Use dist/embeddings/transformers.js (cached offline). Build a realistic corpus (~500-1500 memories; reuse/extend scripts/bench/retrieval.mjs or sim-solo.mjs) with a gold set. Measure P@1/P@3/MRR rerank OFF (REST/handleSearch) vs rerank ON (MCP) and report the lift. Compare to the skill's documented numbers (solo P@1 ~56% no-rerank / ~81% rerank, MRR ~0.70/0.87) — still hold? Also store + search latency at this N. Flag MATERIAL regression vs documented quality; else confirm with evidence. Keep N modest enough to finish in a few minutes.`,
  },
  {
    label: 'P14-dashboard-web',
    scenario: `Dashboard / web-E2E. Use scripts/battle/verify-web.mjs as template (boots server, drives dashboard). VERIFY: (1) all dashboard REST endpoints return 200 with real data (/api/search, /api/memories, /api/graph, /api/stats, etc.); (2) SPA deep-link fallback — refresh on /browse,/search,/graph,/memory/:id serves index.html (Express5 dotfiles fix); (3) Search limit capped at 100 (the 500→100 fix — a limit>100 clamped/rejected, not a 400 that kills type-ahead); (4) graph view renders nodes/edges from real data. If no headless browser, fall back to driving REST with node:http and say so. Report any 4xx/5xx on a valid route or broken deep-link.`,
  },
]

phase('Battle')

// Pipeline: each persona battles, then EVERY major/blocker bug it reports is
// independently refute-verified on a fresh instance — verification for an early
// persona starts while later personas are still battling (no barrier).
const results = await pipeline(
  personas,
  (p) => agent(DRIVE_GUIDE + p.scenario, { label: p.label, phase: 'Battle', schema: SCHEMA }),
  (report, p) => {
    if (!report) return { persona: p.label, report: null, verified: [] }
    const toVerify = (report.bugs || []).filter((b) => b.severity !== 'minor')
    if (toVerify.length === 0) return { persona: p.label, report, verified: [] }
    return parallel(
      toVerify.map((b) => () =>
        agent(VERIFY_GUIDE + JSON.stringify(b, null, 2), {
          label: `verify:${p.label}:${String(b.title).slice(0, 24)}`,
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
        }).then((v) => ({ bug: b, verdict: v })),
      ),
    ).then((verified) => ({ persona: p.label, report, verified }))
  },
)

// Compact rollup: confirmed bugs first, then skill findings + regression status.
const rollup = results.filter(Boolean).map((r) => ({
  persona: r.persona,
  executed: r.report?.executed ?? false,
  confirmed_bugs: (r.verified || [])
    .filter((v) => v.verdict && v.verdict.verdict === 'confirmed')
    .map((v) => ({ severity: v.verdict.corrected_severity, title: v.bug.title, fix_hint: v.verdict.fix_hint })),
  refuted_bugs: (r.verified || [])
    .filter((v) => v.verdict && v.verdict.verdict !== 'confirmed')
    .map((v) => ({ title: v.bug.title, verdict: v.verdict.verdict })),
  minor_bugs: (r.report?.bugs || []).filter((b) => b.severity === 'minor').map((b) => b.title),
  regression_checks: r.report?.regression_checks || [],
  skill_findings: (r.report?.skill_findings || []).filter((f) => f.type !== 'good'),
  failed_capabilities: (r.report?.capabilities || []).filter((c) => !c.worked).map((c) => c.name),
  notes: r.report?.notes,
}))

// Completeness critic: what did we NOT test? Did every session-4 fix get probed?
phase('Critic')
const critic = await agent(
  `You are a completeness critic for a battle test of mcp-memory-server (HEAD 39ff196). Below is the full rollup of 14 personas (a brand-new solo user, a multi-dev team, and 12 skeptics). Judge what the battle did NOT cover.\n\nROLLUP:\n${JSON.stringify(rollup, null, 2)}\n\nAssess: (1) coverage_gaps — modalities/claims/surfaces not exercised or only weakly (think: tool-catalog has 41 tools — which were never driven? which gotchas unprobed? which real-model claims rested on mock?). (2) session4_fix_coverage — for EACH of F1 (ns store), F1b (ns ingest/session/core), P11 (migration throw), P10/P14 (teardown closeAllDatabases), P8 (recursive logger redaction): was it regression-probed by at least one persona with REAL evidence (set covered + by_whom)? (3) recommend_another_round if a high-priority gap or an unprobed session-4 fix remains. Be specific and actionable.`,
  { label: 'completeness-critic', phase: 'Critic', schema: CRITIC_SCHEMA },
)

return { rollup, critic }
