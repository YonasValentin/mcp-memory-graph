/**
 * Tests for the M6.2 compute budget governor (src/lib/compute-governor.ts).
 *
 * A token-bucket-ish governor that weights the cost of the heavy ML ops
 * (embed / rerank / nli) against a refilling budget. When the budget is
 * exhausted it emits a graceful-degradation SIGNAL — it NEVER throws — so a
 * caller can keep serving on the free path (vector + FTS RRF) instead of
 * paying for rerank / NLI.
 *
 * Modes (MCP_COMPUTE_GOVERNOR_MODE):
 *   warn      — always allow; set degrade=true once over budget (observability)
 *   throttle  — deny the heavy op once over budget (degrade=true), allow free ops
 *   block     — like throttle but also marks denied=true so the caller may 503
 *   off       — never degrade, never deny (governor disabled)
 *
 * Determinism: the clock is injected (config.now); a pure builder never reads
 * the system clock with no argument.
 */
import { describe, it, expect } from 'vitest';
import {
  ComputeGovernor,
  defaultGovernorConfig,
  OP_WEIGHTS,
  type ComputeOp,
} from '../../lib/compute-governor.js';

/** A controllable monotonic clock for deterministic refill tests. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('ComputeGovernor — under budget allows the heavy op without degrading', () => {
  it('allows a single rerank when the bucket is full', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 100, refillPerSec: 10, mode: 'throttle', now: clock.now });
    const r = gov.preflight('rerank');
    expect(r.allow).toBe(true);
    expect(r.degrade).toBe(false);
    expect(r.denied).toBe(false);
  });

  it('charges the op weight against the remaining budget', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 100, refillPerSec: 0, mode: 'throttle', now: clock.now });
    const before = gov.remaining();
    gov.preflight('embed');
    expect(gov.remaining()).toBeCloseTo(before - OP_WEIGHTS.embed, 5);
  });
});

describe('ComputeGovernor — over budget DEGRADES, never throws', () => {
  it('throttle mode: denies the heavy op (degrade=true) once budget exhausted', () => {
    const clock = fakeClock();
    // capacity 2 with no refill: one rerank (weight 3) immediately overshoots.
    const gov = new ComputeGovernor({ capacity: 2, refillPerSec: 0, mode: 'throttle', now: clock.now });
    const r = gov.preflight('rerank');
    expect(r.allow).toBe(false);
    expect(r.degrade).toBe(true);
    expect(r.denied).toBe(false); // throttle degrades but does not hard-fail
  });

  it('never throws on repeated over-budget preflights', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 1, refillPerSec: 0, mode: 'block', now: clock.now });
    expect(() => {
      for (let i = 0; i < 50; i++) gov.preflight('nli');
    }).not.toThrow();
  });

  it('warn mode: ALWAYS allows but flags degrade=true once over budget', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 2, refillPerSec: 0, mode: 'warn', now: clock.now });
    const r = gov.preflight('rerank');
    expect(r.allow).toBe(true); // warn never denies
    expect(r.degrade).toBe(true); // but signals the over-budget condition
    expect(r.denied).toBe(false);
  });

  it('block mode: denies AND marks denied=true once over budget', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 2, refillPerSec: 0, mode: 'block', now: clock.now });
    const r = gov.preflight('rerank');
    expect(r.allow).toBe(false);
    expect(r.degrade).toBe(true);
    expect(r.denied).toBe(true);
  });

  it('off mode: never degrades, never denies, never charges', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 1, refillPerSec: 0, mode: 'off', now: clock.now });
    const remainingBefore = gov.remaining();
    for (let i = 0; i < 5; i++) {
      const r = gov.preflight('rerank');
      expect(r.allow).toBe(true);
      expect(r.degrade).toBe(false);
      expect(r.denied).toBe(false);
    }
    // off mode must not mutate the bucket at all.
    expect(gov.remaining()).toBe(remainingBefore);
  });
});

describe('ComputeGovernor — budget refills over the compute window', () => {
  it('a denied op is allowed again after enough wall-clock has elapsed', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 3, refillPerSec: 3, mode: 'throttle', now: clock.now });
    // Drain: one rerank (weight 3) empties the bucket.
    expect(gov.preflight('rerank').allow).toBe(true);
    // Immediately again → over budget.
    expect(gov.preflight('rerank').allow).toBe(false);
    // Wait one full second → refills 3 tokens → enough for another rerank.
    clock.advance(1000);
    expect(gov.preflight('rerank').allow).toBe(true);
  });

  it('refill is clamped to capacity (no unbounded accumulation while idle)', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 10, refillPerSec: 5, mode: 'throttle', now: clock.now });
    gov.preflight('embed'); // weight 1 → remaining 9
    clock.advance(60_000); // a full minute idle
    expect(gov.remaining()).toBe(10); // clamped, not 9 + 300
  });
});

describe('ComputeGovernor — window observability surface', () => {
  it('exposes a compute_window snapshot for memory_stats', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 100, refillPerSec: 10, mode: 'throttle', now: clock.now });
    gov.preflight('rerank');
    const w = gov.window();
    expect(w.mode).toBe('throttle');
    expect(w.capacity).toBe(100);
    expect(w.remaining).toBeCloseTo(97, 5); // 100 - rerank weight 3
    expect(w.degraded).toBe(false);
    expect(typeof w.refill_per_sec).toBe('number');
  });

  it('window.degraded latches true after an over-budget event', () => {
    const clock = fakeClock();
    const gov = new ComputeGovernor({ capacity: 2, refillPerSec: 0, mode: 'throttle', now: clock.now });
    gov.preflight('rerank'); // over budget
    expect(gov.window().degraded).toBe(true);
  });
});

describe('defaultGovernorConfig — reads MCP_COMPUTE_GOVERNOR_* env', () => {
  const KEYS = [
    'MCP_COMPUTE_GOVERNOR_MODE',
    'MCP_COMPUTE_GOVERNOR_CAPACITY',
    'MCP_COMPUTE_GOVERNOR_REFILL_PER_SEC',
  ];
  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) saved[k] = process.env[k];
    try {
      for (const k of KEYS) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it('defaults to off (governor disabled) when unset', () => {
    withEnv({}, () => {
      expect(defaultGovernorConfig().mode).toBe('off');
    });
  });

  it('reads mode, capacity and refill from env', () => {
    withEnv(
      {
        MCP_COMPUTE_GOVERNOR_MODE: 'throttle',
        MCP_COMPUTE_GOVERNOR_CAPACITY: '500',
        MCP_COMPUTE_GOVERNOR_REFILL_PER_SEC: '25',
      },
      () => {
        const cfg = defaultGovernorConfig();
        expect(cfg.mode).toBe('throttle');
        expect(cfg.capacity).toBe(500);
        expect(cfg.refillPerSec).toBe(25);
      },
    );
  });

  it('falls back to off mode on an invalid mode string', () => {
    withEnv({ MCP_COMPUTE_GOVERNOR_MODE: 'nonsense' }, () => {
      expect(defaultGovernorConfig().mode).toBe('off');
    });
  });

  it('ignores non-positive / non-numeric capacity and refill', () => {
    withEnv(
      { MCP_COMPUTE_GOVERNOR_CAPACITY: '-5', MCP_COMPUTE_GOVERNOR_REFILL_PER_SEC: 'abc' },
      () => {
        const cfg = defaultGovernorConfig();
        expect(cfg.capacity).toBeGreaterThan(0);
        expect(cfg.refillPerSec).toBeGreaterThan(0);
      },
    );
  });
});

describe('OP_WEIGHTS — heavier ops cost more than free ops', () => {
  it('orders nli >= rerank > embed', () => {
    const ops: ComputeOp[] = ['embed', 'rerank', 'nli'];
    for (const op of ops) expect(OP_WEIGHTS[op]).toBeGreaterThan(0);
    expect(OP_WEIGHTS.rerank).toBeGreaterThan(OP_WEIGHTS.embed);
    expect(OP_WEIGHTS.nli).toBeGreaterThanOrEqual(OP_WEIGHTS.rerank);
  });
});
