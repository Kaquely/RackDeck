import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateDeriver } from "../../src/server/integrations/rate-deriver.ts";

/**
 * The rate derivation is the part of the integration most able to produce confident nonsense, so
 * it is tested against hand-built sequences rather than against whatever Pi-hole happened to
 * return.
 */

function counters(total: number | null, blocked: number | null = null): Map<string, number | null> {
  return new Map([
    ["dns.queriesTotal", total],
    ["dns.queriesBlocked", blocked],
  ]);
}

describe("RateDeriver", () => {
  it("reports no rate on the first reading", () => {
    const deriver = new RateDeriver();

    const rates = deriver.compute(counters(1_000), 0);

    assert.equal(rates.get("dns.queriesTotal"), null);
  });

  it("derives a per-second rate from two readings", () => {
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000), 0);
    const rates = deriver.compute(counters(1_500), 500);

    assert.equal(rates.get("dns.queriesTotal"), 1_000);
  });

  it("derives a fractional rate without rounding to a lie", () => {
    const deriver = new RateDeriver();

    deriver.compute(counters(1), 0);
    const rates = deriver.compute(counters(3), 4_000);

    assert.equal(rates.get("dns.queriesTotal"), 0.5);
  });

  it("reports zero when the counter genuinely has not moved", () => {
    // Distinct from "not measurable": a real zero means the number really is zero.
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000), 0);
    const rates = deriver.compute(counters(1_000), 500);

    assert.equal(rates.get("dns.queriesTotal"), 0);
  });

  it("treats a counter decrease as a reset rather than a negative rate", () => {
    // Pi-hole zeroes its daily counters at midnight. A raw difference here is a large negative
    // number followed by a garbage spike.
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000_000), 0);
    const afterReset = deriver.compute(counters(5), 500);

    assert.equal(afterReset.get("dns.queriesTotal"), null);
  });

  it("resumes accumulating from the new baseline after a reset", () => {
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000_000), 0);
    deriver.compute(counters(5), 500);
    const afterReset = deriver.compute(counters(105), 1_000);

    assert.equal(afterReset.get("dns.queriesTotal"), 200);
  });

  it("never reports a negative rate", () => {
    const deriver = new RateDeriver();
    const sequence = [1_000, 900, 800, 1_200];

    deriver.compute(counters(sequence[0] ?? 0), 0);
    for (let index = 1; index < sequence.length; index += 1) {
      const previous = deriver.compute(counters(sequence[index] ?? 0), index * 500);
      const value = previous.get("dns.queriesTotal") ?? null;
      if (value !== null) assert.ok(value >= 0, `produced a negative rate: ${value}`);
    }
  });

  it("does not overwrite the baseline when a counter is briefly absent", () => {
    // If the application stops reporting for two cycles, the next real reading differences
    // against the last real one rather than against a hole.
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000, 100), 0);
    deriver.compute(counters(null, null), 500);
    deriver.compute(counters(null, null), 1_000);
    const rates = deriver.compute(counters(1_200, 100), 1_500);

    // 200 queries over the whole 1.5 s window, not over the 0.5 s since the last attempt.
    assert.equal(rates.get("dns.queriesTotal"), (1_200 - 1_000) / 1.5);
  });

  it("reports an absent counter as no rate, not zero", () => {
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000), 0);
    const rates = deriver.compute(counters(null), 500);

    assert.equal(rates.get("dns.queriesTotal"), null);
  });

  it("reports no rate when two readings share a timestamp", () => {
    // A division by zero would otherwise be Infinity, which a chart would draw as a spike.
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000), 0);
    const rates = deriver.compute(counters(2_000), 0);

    assert.equal(rates.get("dns.queriesTotal"), null);
  });

  it("tolerates a clock that steps backwards", () => {
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000), 10_000);
    const rates = deriver.compute(counters(2_000), 5_000);

    assert.equal(rates.get("dns.queriesTotal"), null);
  });

  it("derives each counter independently", () => {
    const deriver = new RateDeriver();

    deriver.compute(counters(1_000, 100), 0);
    const rates = deriver.compute(counters(1_500, 100), 500);

    assert.equal(rates.get("dns.queriesTotal"), 1_000);
    // Blocked did not move, which is a real zero rather than a gap.
    assert.equal(rates.get("dns.queriesBlocked"), 0);
  });

  it("retains state bounded by the counter count, not the reading count", () => {
    const deriver = new RateDeriver();

    for (let index = 0; index < 10_000; index += 1) {
      deriver.compute(counters(index, index * 2), index * 500);
    }

    assert.equal(deriver.retainedCount, 2);
  });

  it("forgets a counter that stops being reported only after being reset", () => {
    const deriver = new RateDeriver();
    deriver.compute(counters(1_000), 0);

    assert.equal(deriver.retainedCount, 1);
    deriver.reset();
    assert.equal(deriver.retainedCount, 0);
  });

  it("returns one entry per counter, in order", () => {
    const deriver = new RateDeriver();

    const rates = deriver.compute(counters(1_000, 100), 0);

    assert.deepEqual([...rates.keys()], ["dns.queriesTotal", "dns.queriesBlocked"]);
  });
});
