/**
 * Per-interval rates from upstream cumulative counters.
 *
 * Pi-hole reports totals for the current day. That is the wrong granularity for a dashboard:
 * a chart of a cumulative counter is a curve whose useful quantity is its slope, and an operator
 * should not have to do that arithmetic. So the slope is computed here.
 *
 * Three things make this more than subtraction, and each is the kind of detail that produces a
 * chart full of confident nonsense if handled naively:
 *
 * - **No predecessor.** On the first reading there is nothing to difference against. The rate is
 *   `null` — not measurable — rather than a fabricated zero, which would look like a dead DNS
 *   server.
 * - **The midnight reset.** Pi-hole zeroes its counters at midnight. A raw difference is then a
 *   large negative number followed by a garbage spike. A decrease is therefore read as a reset:
 *   the rate is not measurable for that cycle, and accumulation resumes from the new baseline.
 * - **Gaps.** Each counter carries the timestamp of its own baseline rather than the deriver
 *   carrying one clock for everything. If an application stops reporting a counter for a second,
 *   the next reading differences against the last *real* reading and divides by the whole elapsed
 *   window. Dividing by only the time since the last attempt would overstate the rate by
 *   however long the gap was — an outage in reporting would look like a burst of traffic.
 *
 * State is one number and one timestamp per counter, so memory cannot grow with uptime — the
 * same property the product's history buffer relies on.
 */

type Baseline = {
  value: number;
  /** Epoch milliseconds at which this value was observed. */
  at: number;
};

export class RateDeriver {
  #baselines = new Map<string, Baseline>();

  /**
   * Number of counters retained. Exposed so a test can assert it stays bounded after many
   * cycles, which is the property that keeps this from becoming a leak.
   */
  get retainedCount(): number {
    return this.#baselines.size;
  }

  /** Forget the baselines. Used between tests; not part of normal operation. */
  reset(): void {
    this.#baselines.clear();
  }

  /**
   * Compute per-second rates for `counters` observed at `atMs`.
   *
   * Returns one entry per counter, in iteration order, so a caller can map results straight
   * onto metrics without a second lookup.
   */
  compute(counters: ReadonlyMap<string, number | null>, atMs: number): Map<string, number | null> {
    const rates = new Map<string, number | null>();

    for (const [key, value] of counters) {
      // An unmeasurable counter yields no rate and leaves the baseline untouched, so the next
      // real reading differences across the whole gap rather than against a hole.
      if (value === null) {
        rates.set(key, null);
        continue;
      }

      const previous = this.#baselines.get(key);
      this.#baselines.set(key, { value, at: atMs });

      if (previous === undefined) {
        rates.set(key, null);
        continue;
      }

      const elapsedSeconds = (atMs - previous.at) / 1000;

      // A clock that has not advanced, or has stepped backwards, gives no usable denominator.
      if (!(elapsedSeconds > 0)) {
        rates.set(key, null);
        continue;
      }

      // A decrease is a reset, not a negative rate.
      if (value < previous.value) {
        rates.set(key, null);
        continue;
      }

      rates.set(key, (value - previous.value) / elapsedSeconds);
    }

    return rates;
  }
}
