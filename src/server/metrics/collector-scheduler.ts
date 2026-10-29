import type { SnapshotStore } from "./snapshot-store.ts";
import type { Collector } from "../collectors/types.ts";

/**
 * Drives collection on a fixed interval.
 *
 * Two properties matter here and both exist to protect a small always-on node:
 *
 * - **Overlap protection.** A tick that fires while the previous cycle is still running is
 *   skipped, not queued. Queuing would let one slow source accumulate work into a backlog
 *   that only grows, converting a transient problem into permanent memory growth.
 * - **Per-collector isolation.** Every `collect()` is individually guarded, so an
 *   unreachable application degrades its own widget rather than the whole dashboard.
 */

/**
 * A cancellable interval.
 *
 * The scheduler depends only on the narrow behaviour of an interval timer, not on Node's
 * `Timeout` object. Wrapping the native handle keeps the production default honest while
 * letting a test supply a controllable stand-in with no casts, and it removes the need for a
 * separate "clear" function: cancelling is part of the timer.
 */
export interface IntervalTimer {
  cancel(): void;
}

export type SetIntervalFn = (handler: () => void, intervalMs: number) => IntervalTimer;

const defaultSetInterval: SetIntervalFn = (handler, intervalMs) => {
  const native = setInterval(handler, intervalMs);
  return {
    cancel: () => {
      clearInterval(native);
    },
  };
};

export type CollectorSchedulerOptions = {
  collectors: Collector[];
  store: SnapshotStore;
  intervalMs: number;
  /**
   * Maximum time one collector may take before it is treated as failed.
   *
   * This is not a nicety. A collector that never resolves would otherwise block the whole
   * cycle, because the cycle awaits each collector in turn, so every other source would stop
   * updating too. Defaulting well above `intervalMs` means a genuinely slow source still
   * completes, while a wedged one degrades to `unavailable` on its own.
   */
  collectTimeoutMs?: number;
  /** Injectable for tests, so the scheduler can be driven without real timers. */
  setIntervalFn?: SetIntervalFn;
};

/** Reject if `promise` has not settled within `ms`. The timer is always cleared. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not respond within ${ms}ms`));
    }, ms);
    // Deliberately NOT unref'd. The guard must keep the event loop alive while a collection
    // is genuinely in flight; an unref'd timer is skipped in a short-lived context, so the
    // cycle would never complete. It is always cleared on settle, so it cannot leak.
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class CollectorScheduler {
  #collectors: Collector[];
  #store: SnapshotStore;
  #intervalMs: number;
  #collectTimeoutMs: number;
  #setIntervalFn: SetIntervalFn;

  #timer: IntervalTimer | null = null;
  #running = false;
  #inFlight = false;
  #cycles = 0;
  #skipped = 0;

  constructor(options: CollectorSchedulerOptions) {
    this.#collectors = options.collectors;
    this.#store = options.store;
    this.#intervalMs = options.intervalMs;
    this.#collectTimeoutMs = options.collectTimeoutMs ?? 10_000;
    this.#setIntervalFn = options.setIntervalFn ?? defaultSetInterval;

    for (const collector of this.#collectors) {
      this.#store.register({
        id: collector.id,
        label: collector.label,
        kind: collector.kind,
      });
    }
  }

  /** Number of completed cycles. Exposed for tests and diagnostics. */
  get cycles(): number {
    return this.#cycles;
  }

  /** Number of ticks skipped because a cycle was still in flight. */
  get skippedTicks(): number {
    return this.#skipped;
  }

  get running(): boolean {
    return this.#running;
  }

  /**
   * Register a collector after construction, so a peer added at runtime begins reporting on
   * the next cycle without a restart.
   */
  addCollector(collector: Collector): void {
    if (this.#collectors.some((existing) => existing.id === collector.id)) {
      throw new Error(`collector "${collector.id}" is already registered`);
    }
    this.#collectors.push(collector);
    this.#store.register({
      id: collector.id,
      label: collector.label,
      kind: collector.kind,
    });
  }

  /** Remove a collector and its source. Returns false when the id was not registered. */
  removeCollector(id: string): boolean {
    const index = this.#collectors.findIndex((collector) => collector.id === id);
    if (index === -1) return false;
    this.#collectors.splice(index, 1);
    this.#store.unregister(id);
    return true;
  }

  hasCollector(id: string): boolean {
    return this.#collectors.some((collector) => collector.id === id);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;

    // Collect immediately so the dashboard has data on its first paint rather than after a
    // full interval of blank widgets.
    void this.runOnce();

    this.#timer = this.#setIntervalFn(() => {
      void this.runOnce();
    }, this.#intervalMs);
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#timer !== null) {
      this.#timer.cancel();
      this.#timer = null;
    }
  }

  /**
   * Run one collection cycle. Returns immediately if a cycle is already in flight.
   *
   * Exposed so tests can drive collection deterministically instead of waiting on timers.
   */
  async runOnce(): Promise<void> {
    if (this.#inFlight) {
      this.#skipped += 1;
      return;
    }

    this.#inFlight = true;
    try {
      const at = Date.now();
      // Snapshot the list so a peer added or removed during a cycle takes effect on the next
      // one, rather than mutating the loop that is already in progress.
      const collectors = [...this.#collectors];
      // Sequential rather than parallel: collectors are cheap and mostly read local
      // facilities, and a sequential loop keeps the cost of a cycle predictable on a
      // single small node.
      for (const collector of collectors) {
        try {
          const result = await withTimeout(
            collector.collect(),
            this.#collectTimeoutMs,
            `collector "${collector.id}"`,
          );
          this.#store.record(collector.id, result.metrics, result.tables, at);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Only this source is affected. Every other collector still runs, and the
          // dashboard keeps serving.
          this.#store.markUnavailable(collector.id, message, at);
        }
      }
      this.#cycles += 1;
    } finally {
      this.#inFlight = false;
    }
  }
}
