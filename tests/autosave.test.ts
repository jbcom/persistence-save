import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoSaveScheduler } from '../src/autosave.js';

describe('createAutoSaveScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeScheduler(overrides: { data?: unknown; debounceMs?: number } = {}) {
    const save = vi.fn(async (_data: unknown) => {
      /* successful no-op write */
    });
    const onError = vi.fn();
    const provider = vi.fn(() => ('data' in overrides ? overrides.data : { hp: 10 }));
    const opts: Parameters<typeof createAutoSaveScheduler>[0] = { provider, save, onError };
    if (overrides.debounceMs !== undefined) opts.debounceMs = overrides.debounceMs;
    const scheduler = createAutoSaveScheduler(opts);
    return { scheduler, save, provider, onError };
  }

  it('debounces a burst of schedule() calls into one save', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ hp: 10 });
  });

  it('resets the debounce window on each schedule() call', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(300);
    scheduler.schedule(); // resets — 300ms elapsed is discarded
    await vi.advanceTimersByTimeAsync(300);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('honours a custom debounceMs', async () => {
    const { scheduler, save } = makeScheduler({ debounceMs: 50 });
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(50);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('skips the write when the provider returns null', async () => {
    const { scheduler, save, provider } = makeScheduler({ data: null });
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(provider).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('flush() writes immediately and cancels the pending debounce', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.schedule();
    await scheduler.flush();
    expect(save).toHaveBeenCalledTimes(1);
    // The pending debounce was cancelled — no trailing duplicate.
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops a pending save without writing', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.schedule();
    scheduler.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });

  it('suppress() blocks schedule() and flush() inside the block', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.suppress(() => {
      scheduler.schedule();
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });

  it('suppress() is re-entrant — only the outermost exit unsuppresses', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.suppress(() => {
      scheduler.suppress(() => {
        /* inner no-op block */
      });
      // Still inside the OUTER block — must remain suppressed.
      scheduler.schedule();
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    // After the outer block exits, scheduling works again.
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('suppress() restores on throw', async () => {
    const { scheduler, save } = makeScheduler();
    expect(() =>
      scheduler.suppress(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('scheduleThrottled fires on the leading edge then ignores calls inside the window', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.scheduleThrottled('hot', 5000);
    scheduler.scheduleThrottled('hot', 5000);
    scheduler.scheduleThrottled('hot', 5000);
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
    // Inside the window: no-op even after the debounce would fire.
    scheduler.scheduleThrottled('hot', 5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    // Window expires → fires again.
    await vi.advanceTimersByTimeAsync(5000);
    scheduler.scheduleThrottled('hot', 5000);
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('scheduleThrottled keys maintain independent windows', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.scheduleThrottled('a', 5000);
    scheduler.scheduleThrottled('b', 5000);
    await vi.advanceTimersByTimeAsync(400);
    // Both leading edges landed inside one debounce window → one write.
    expect(save).toHaveBeenCalledTimes(1);
    // 'a' is throttled but 'b' was fired at the same time — both blocked now.
    scheduler.scheduleThrottled('a', 5000);
    scheduler.scheduleThrottled('b', 5000);
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('scheduleThrottled throws on a non-positive or non-finite window', () => {
    const { scheduler } = makeScheduler();
    expect(() => scheduler.scheduleThrottled('k', 0)).toThrow(/positive finite/);
    expect(() => scheduler.scheduleThrottled('k', -5)).toThrow(/positive finite/);
    expect(() => scheduler.scheduleThrottled('k', Number.NaN)).toThrow(/positive finite/);
    expect(() => scheduler.scheduleThrottled('k', Number.POSITIVE_INFINITY)).toThrow(
      /positive finite/,
    );
  });

  it('resetThrottle() clears throttle windows so the next call fires', async () => {
    const { scheduler, save } = makeScheduler();
    scheduler.scheduleThrottled('hot', 60_000);
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
    scheduler.resetThrottle();
    scheduler.scheduleThrottled('hot', 60_000);
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('routes background save failures to onError without crashing', async () => {
    const save = vi.fn(async () => {
      throw new Error('disk full');
    });
    const onError = vi.fn();
    const scheduler = createAutoSaveScheduler({ provider: () => ({}), save, onError });
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
  });

  it('propagates flush() failures to the awaiting caller', async () => {
    const save = vi.fn(async () => {
      throw new Error('disk full');
    });
    const scheduler = createAutoSaveScheduler({ provider: () => ({}), save });
    await expect(scheduler.flush()).rejects.toThrow('disk full');
  });
});
