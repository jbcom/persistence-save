/**
 * Autosave scheduler — debounce + leading-edge throttle + re-entrant
 * suppression for high-frequency save callers. Ported from kings-road's
 * `src/db/autosave.ts` (the best-engineered debounce/lifecycle story in the
 * fleet per the persistence-save tournament) and instanced: no module-level
 * singletons, so multiple stores / tests compose cleanly.
 *
 * Layered ON TOP of `createPersistence` — the facade's synchronous per-write
 * flush doesn't need debouncing for infrequent explicit saves, but a
 * per-tick autosave caller still does.
 */

/** Scheduler facade returned by {@link createAutoSaveScheduler}. */
export interface AutoSaveScheduler {
  /**
   * Queue a debounced background save. Coalesces rapid calls into one write
   * `debounceMs` after the burst ends. No-op when suppressed or when the
   * provider returns null (game not in a save-worthy state).
   */
  schedule(): void;
  /**
   * Leading-edge throttled scheduler — fires (via `schedule()`) on the first
   * call, then ignores calls under the same `key` until `windowMs` elapses.
   * Use for per-frame / high-rate mutators where the debounce would be reset
   * forever and never actually fire. `key` namespaces independent hot loops
   * (e.g. `'player.health'` vs `'env.timeOfDay'`). Throws on a non-positive
   * or non-finite `windowMs` — a 0ms window would silently reintroduce the
   * per-frame footgun this wrapper exists to prevent.
   */
  scheduleThrottled(key: string, windowMs: number): void;
  /**
   * Immediately save without debouncing (cancels any pending debounce so the
   * flushed write can't be trailed by a stale duplicate). Awaitable — use
   * for lifecycle events (`visibilitychange`/`pagehide`) and tests.
   */
  flush(): Promise<void>;
  /**
   * Run `fn` with autosaves suppressed. Re-entrant: nested blocks maintain
   * suppression until every block has exited (counter, not boolean). Wrap
   * state-restore paths so rebuilding state on load doesn't immediately
   * re-serialize it.
   */
  suppress(fn: () => void): void;
  /** Cancel any pending debounced save without writing. */
  cancel(): void;
  /**
   * Reset all throttle windows. Call on session reset so a late-session
   * throttle entry can't swallow an autosave in the first seconds of the
   * next session.
   */
  resetThrottle(): void;
}

/** Options for {@link createAutoSaveScheduler}. */
export interface AutoSaveSchedulerOptions<TData> {
  /**
   * Snapshot provider. Returns the data to write, or `null` when the game
   * isn't in a save-worthy state (menu, mid-load) — the flush is skipped.
   */
  provider: () => TData | null;
  /** The actual write (e.g. `(data) => persistence.save('AutoSave', data)`). */
  save: (data: TData) => Promise<void>;
  /** Debounce window for coalescing back-to-back mutations. Default 400ms. */
  debounceMs?: number;
  /**
   * Called when a background (debounced) save rejects. Persistence failures
   * should surface but never crash gameplay. Default: `console.error`.
   * Awaited `flush()` rejections propagate to the caller instead.
   */
  onError?: (err: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 400;

/** Create an instanced autosave scheduler. */
export function createAutoSaveScheduler<TData>(
  options: AutoSaveSchedulerOptions<TData>,
): AutoSaveScheduler {
  const {
    provider,
    save,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    onError = (err: unknown) => console.error('[autosave] failed:', err),
  } = options;

  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // Throttle state: key → last-fired timestamp (ms since epoch). Distinct
  // from the debounced pendingTimer because throttled callers come from
  // per-frame systems that would otherwise reset the debounce indefinitely.
  const throttleLastFiredAt = new Map<string, number>();
  // Counter rather than boolean so nested suppress() calls compose —
  // only the outermost exit unsuppresses.
  let suppressCount = 0;

  async function flushNow(): Promise<void> {
    if (suppressCount > 0) return;
    const data = provider();
    if (data === null) return;
    await save(data);
  }

  function cancel(): void {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  const scheduler: AutoSaveScheduler = {
    schedule(): void {
      if (suppressCount > 0) return;
      cancel();
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        flushNow().catch(onError);
      }, debounceMs);
    },

    scheduleThrottled(key: string, windowMs: number): void {
      if (!Number.isFinite(windowMs) || windowMs <= 0) {
        throw new Error(
          `scheduleThrottled: windowMs must be a positive finite number, got ${windowMs}`,
        );
      }
      if (suppressCount > 0) return;
      const now = Date.now();
      const last = throttleLastFiredAt.get(key);
      if (last !== undefined && now - last < windowMs) return;
      throttleLastFiredAt.set(key, now);
      scheduler.schedule();
    },

    async flush(): Promise<void> {
      cancel();
      await flushNow();
    },

    suppress(fn: () => void): void {
      suppressCount++;
      try {
        fn();
      } finally {
        suppressCount--;
      }
    },

    cancel,

    resetThrottle(): void {
      throttleLastFiredAt.clear();
    },
  };

  return scheduler;
}
