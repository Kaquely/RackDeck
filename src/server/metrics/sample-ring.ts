import type { Sample } from "../../shared/observations.ts";

/**
 * A fixed-capacity circular buffer of samples, oldest first on read.
 *
 * Fixed capacity is the point. It is allocated once at construction, so the memory a metric
 * will ever occupy is known before any data arrives, and appending is O(1) with no
 * allocation. That is what makes "history is bounded by configuration, not by uptime" a
 * structural property rather than an aspiration, which matters for a process that must stay
 * under 300 MB running continuously.
 *
 * A plain array with `shift()` was rejected: trimming is O(n) and reallocates on every
 * append, which at 30 metrics and 2 Hz is permanent churn for the life of the process.
 */
export class SampleRing {
  readonly capacity: number;

  #slots: (Sample | undefined)[];
  /** Index of the oldest retained sample. */
  #start = 0;
  #size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`SampleRing capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#slots = new Array<Sample | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(sample: Sample): void {
    if (this.#size < this.capacity) {
      this.#slots[(this.#start + this.#size) % this.capacity] = sample;
      this.#size += 1;
      return;
    }

    // Full: overwrite the oldest slot and advance the window.
    this.#slots[this.#start] = sample;
    this.#start = (this.#start + 1) % this.capacity;
  }

  /** Retained samples, oldest first. */
  toArray(): Sample[] {
    const out: Sample[] = [];
    for (let index = 0; index < this.#size; index += 1) {
      const sample = this.#slots[(this.#start + index) % this.capacity];
      if (sample !== undefined) out.push(sample);
    }
    return out;
  }

  /** Most recent sample, or null when empty. */
  latest(): Sample | null {
    if (this.#size === 0) return null;
    const index = (this.#start + this.#size - 1) % this.capacity;
    return this.#slots[index] ?? null;
  }

  clear(): void {
    this.#slots = new Array<Sample | undefined>(this.capacity);
    this.#start = 0;
    this.#size = 0;
  }
}
