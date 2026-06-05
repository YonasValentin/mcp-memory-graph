/**
 * battle-v7 L4 — the running server must drain the webhook delivery queue
 * autonomously.
 *
 * THE BUG (MEDIUM, broken feature): dispatchPendingWebhooks was only ever called
 * by the manual memory_webhook {action:'dispatch'} tool. A long-running `serve`
 * process enqueued deliveries (on memory.created/updated/superseded/forgotten…)
 * but never flushed them, so a configured webhook target never received anything
 * unless a human manually triggered a dispatch.
 *
 * THE FIX: startWebhookDispatchLoop drains the queue on an interval (gated by
 * MCP_WEBHOOKS at the call site), with an in-flight guard (no overlapping drains)
 * and a stop function for graceful shutdown. The timer is unref()'d so it never
 * keeps the process alive on its own.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startWebhookDispatchLoop } from '../../cli/serve.js';

afterEach(() => {
  vi.useRealTimers();
});

const fakeDb = () => ({}) as never;

describe('startWebhookDispatchLoop — L4', () => {
  it('dispatches on each interval and halts after the returned stop fn', async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const stop = startWebhookDispatchLoop(fakeDb, { intervalMs: 1000, dispatch });

    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatch).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(dispatch).toHaveBeenCalledTimes(3); // no further drains after stop
  });

  it('does not start an overlapping drain while one is still in flight', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const dispatch = vi.fn().mockImplementation(() => gate);
    const stop = startWebhookDispatchLoop(fakeDb, { intervalMs: 1000, dispatch });

    await vi.advanceTimersByTimeAsync(1000); // fires; now in-flight (gate unresolved)
    await vi.advanceTimersByTimeAsync(3000); // 3 more ticks — all skipped while in-flight
    expect(dispatch).toHaveBeenCalledTimes(1);

    release(); // the in-flight drain completes → guard clears
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000); // next tick can run again
    expect(dispatch).toHaveBeenCalledTimes(2);

    stop();
  });

  it('swallows a dispatch error so a flaky receiver cannot crash the server', async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn().mockRejectedValue(new Error('receiver down'));
    const stop = startWebhookDispatchLoop(fakeDb, { intervalMs: 1000, dispatch });

    // Two ticks: the rejection must not throw out of the timer or wedge the guard.
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    stop();
  });
});
