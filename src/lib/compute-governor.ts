/**
 * M6.2 — Compute budget / governor with graceful degradation.
 *
 * A token-bucket-ish governor (mirrors src/api/rate-limit.ts in spirit — single
 * process, dependency-free, injectable clock) for the heavy ML ops the server
 * runs PER REQUEST: query/document embedding, cross-encoder reranking, and NLI
 * contradiction classification. Those ops dominate CPU and, on the homelab box,
 * are the thing worth shedding first under pressure.
 *
 * The governor weights each op by its relative cost and charges it against a
 * budget that refills at `refillPerSec` up to `capacity`. The window is the
 * sliding interval `capacity / refillPerSec` seconds — the "compute window"
 * surfaced in memory_stats.
 *
 * KEY CONTRACT: preflight() NEVER throws. When the budget is exhausted it
 * returns a graceful-degradation SIGNAL the caller acts on:
 *   - search.ts skips reranking → falls back to the FREE vector + FTS RRF path
 *   - store.ts skips the NLI contradiction gate (the overlap heuristic still runs)
 * Degradation is a downgrade in answer QUALITY, never an error.
 *
 * Modes (MCP_COMPUTE_GOVERNOR_MODE):
 *   off       — disabled: always allow, never degrade, never charge (default)
 *   warn      — always allow, but flag degrade=true once over budget (purely
 *               observational — lets you watch headroom before enforcing)
 *   throttle  — deny the heavy op once over budget (degrade=true); the caller
 *               drops to the free path. Does NOT hard-fail.
 *   block     — like throttle but also sets denied=true, so a caller MAY choose
 *               to surface a 503 / refuse the heavy op outright.
 *
 * Determinism: the clock is injected via `config.now`. No pure/builder fn reads
 * the system clock with no argument — the only default is the bucket field
 * `now ?? Date.now`, mirroring RateLimiter.
 *
 * Tunables (env):
 *   MCP_COMPUTE_GOVERNOR_MODE           default off
 *   MCP_COMPUTE_GOVERNOR_CAPACITY       default 600   burst budget (token units)
 *   MCP_COMPUTE_GOVERNOR_REFILL_PER_SEC default 60    sustained refill
 */

/**
 * The heavy ops the governor weights. The free path (vector + FTS) is unmetered.
 * NOTE: `embed` carries a weight for completeness, but the live wiring only
 * preflights `rerank` (search.ts) and `nli` (store.ts) — the two ops that have a
 * FREE fallback to shed to. Embedding is MANDATORY on every store/search with no
 * cheaper alternative, so it is deliberately NOT preflighted (shedding it would
 * just error, which the governor's whole contract forbids). It remains a defined
 * op so a future budget-accounting view can still account for it.
 */
export type ComputeOp = 'embed' | 'rerank' | 'nli';

/** Governor enforcement strength. */
export type GovernorMode = 'off' | 'warn' | 'throttle' | 'block';

/**
 * Relative cost weights (token units charged per op). Reranking runs a
 * cross-encoder over the candidate set and NLI runs an entailment model over
 * each near-neighbor, so both cost materially more than a single embedding.
 * Tuned so the defaults give a meaningful number of ops per window while
 * keeping the ordering nli >= rerank > embed.
 */
export const OP_WEIGHTS: Readonly<Record<ComputeOp, number>> = {
  embed: 1,
  rerank: 3,
  nli: 4,
};

export interface GovernorConfig {
  /** Burst budget in token units. */
  capacity: number;
  /** Sustained refill rate, token units per second. */
  refillPerSec: number;
  /** Enforcement strength. */
  mode: GovernorMode;
  /** Optional clock injection for tests. */
  now?: () => number;
}

/** The result of a preflight check — a degradation SIGNAL, never an exception. */
export interface PreflightResult {
  /** Whether the caller should run the heavy op. False ⇒ take the free path. */
  allow: boolean;
  /** True when the budget is/was exhausted for this op (over-budget condition). */
  degrade: boolean;
  /** True only in `block` mode when over budget — caller MAY hard-fail (503). */
  denied: boolean;
  /** The op that was checked. */
  op: ComputeOp;
  /** Budget remaining (token units) after this preflight. */
  remaining: number;
  /** Active mode (echoed for callers/metrics). */
  mode: GovernorMode;
}

/** Snapshot of the compute window for memory_stats. */
export interface ComputeWindow {
  mode: GovernorMode;
  capacity: number;
  refill_per_sec: number;
  /** Current remaining budget (token units). */
  remaining: number;
  /** Length of the refill window in seconds (capacity / refillPerSec). */
  window_seconds: number;
  /** Latched true once any preflight has gone over budget. */
  degraded: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseMode(raw: string | undefined): GovernorMode {
  switch (raw) {
    case 'warn':
    case 'throttle':
    case 'block':
    case 'off':
      return raw;
    default:
      // Unset or unrecognized ⇒ disabled. The governor is opt-in.
      return 'off';
  }
}

/** Build the default config from MCP_COMPUTE_GOVERNOR_* env. */
export function defaultGovernorConfig(): GovernorConfig {
  return {
    mode: parseMode(process.env.MCP_COMPUTE_GOVERNOR_MODE),
    capacity: envInt('MCP_COMPUTE_GOVERNOR_CAPACITY', 600),
    refillPerSec: envInt('MCP_COMPUTE_GOVERNOR_REFILL_PER_SEC', 60),
  };
}

/**
 * Stateful single-bucket compute governor. One bucket for the whole process —
 * unlike RateLimiter (which keys per client) the compute budget is a shared box
 * resource, so there is nothing to key on and nothing to evict.
 */
export class ComputeGovernor {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly mode: GovernorMode;
  private readonly now: () => number;

  private tokens: number;
  private lastRefillMs: number;
  /** Latched once any preflight goes over budget; reset() clears it. */
  private degraded = false;

  constructor(config: GovernorConfig) {
    this.capacity = config.capacity;
    this.refillPerSec = config.refillPerSec;
    this.mode = config.mode;
    this.now = config.now ?? Date.now;
    this.tokens = config.capacity;
    this.lastRefillMs = this.now();
  }

  /** Refill the bucket based on elapsed wall-clock, clamped to capacity. */
  private refill(nowMs: number): void {
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefillMs = nowMs;
    }
  }

  /**
   * Check whether the heavy `op` may run, charging its weight against the
   * budget. NEVER throws — returns a degradation signal.
   *
   * `off` mode is a pure pass-through: it neither refills, charges, nor mutates
   * any state, so wiring the governor in with the default config is a true no-op.
   */
  preflight(op: ComputeOp): PreflightResult {
    if (this.mode === 'off') {
      return {
        allow: true,
        degrade: false,
        denied: false,
        op,
        remaining: this.capacity,
        mode: this.mode,
      };
    }

    const nowMs = this.now();
    this.refill(nowMs);

    const cost = OP_WEIGHTS[op];
    const overBudget = this.tokens < cost;

    // warn never withholds the op; throttle/block withhold once over budget.
    const allow = this.mode === 'warn' ? true : !overBudget;
    const denied = this.mode === 'block' && overBudget;

    if (overBudget) {
      this.degraded = true;
    }

    // Charge only when the op actually runs (allow=true). A withheld op took the
    // free path and burned no budget, so don't drive the bucket further negative.
    if (allow) {
      this.tokens = Math.max(0, this.tokens - cost);
    }

    return {
      allow,
      degrade: overBudget,
      denied,
      op,
      remaining: this.tokens,
      mode: this.mode,
    };
  }

  /** Current remaining budget (token units), after refilling to `now`. */
  remaining(): number {
    if (this.mode === 'off') return this.capacity;
    this.refill(this.now());
    return this.tokens;
  }

  /** Snapshot of the compute window for memory_stats / observability. */
  window(): ComputeWindow {
    return {
      mode: this.mode,
      capacity: this.capacity,
      refill_per_sec: this.refillPerSec,
      remaining: this.remaining(),
      window_seconds: this.refillPerSec > 0 ? this.capacity / this.refillPerSec : 0,
      degraded: this.degraded,
    };
  }

  /** Test/maintenance helper — refill to full and clear the degraded latch. */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
    this.degraded = false;
  }
}

/**
 * Process-wide singleton governor (lazy). Call sites (search.ts, store.ts) use
 * this so they share one budget; tests construct their own ComputeGovernor with
 * an injected clock and never touch the singleton.
 */
let singleton: ComputeGovernor | null = null;
export function getComputeGovernor(): ComputeGovernor {
  if (!singleton) {
    singleton = new ComputeGovernor(defaultGovernorConfig());
  }
  return singleton;
}

/**
 * Drop the singleton so the next {@link getComputeGovernor} rebuilds it from the
 * current MCP_COMPUTE_GOVERNOR_* env. The lazy singleton freezes its config at
 * first use, so without this an env change (or a test switching modes) is
 * silently ignored. Mirrors disposeEmbedder() in direct-access.ts.
 */
export function resetComputeGovernor(): void {
  singleton = null;
}
