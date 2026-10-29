import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SampleRing } from "../../src/server/metrics/sample-ring.ts";

describe("SampleRing", () => {
  it("rejects a non-positive capacity", () => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new SampleRing(capacity), RangeError, `capacity ${capacity}`);
    }
  });

  it("starts empty", () => {
    const ring = new SampleRing(5);

    assert.equal(ring.size, 0);
    assert.deepEqual(ring.toArray(), []);
    assert.equal(ring.latest(), null);
  });

  it("returns samples oldest first", () => {
    const ring = new SampleRing(10);
    ring.push({ t: 1, v: 1 });
    ring.push({ t: 2, v: 2 });
    ring.push({ t: 3, v: 3 });

    assert.deepEqual(ring.toArray(), [
      { t: 1, v: 1 },
      { t: 2, v: 2 },
      { t: 3, v: 3 },
    ]);
  });

  it("caps at capacity and discards the oldest", () => {
    const ring = new SampleRing(10);
    for (let index = 1; index <= 25; index += 1) ring.push({ t: index, v: index });

    assert.equal(ring.size, 10);
    // The 10 most recent, still oldest-first.
    assert.deepEqual(
      ring.toArray().map((sample) => sample.t),
      [16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
    );
  });

  it("keeps retained size constant under sustained load", () => {
    // This is the guarantee behind "memory is bounded by configuration, not by uptime".
    const ring = new SampleRing(1000);
    for (let index = 0; index < 100_000; index += 1) ring.push({ t: index, v: index });

    assert.equal(ring.size, 1000);
    assert.equal(ring.toArray().length, 1000);
    assert.equal(ring.latest()?.t, 99_999);
  });

  it("handles a capacity of one", () => {
    const ring = new SampleRing(1);
    ring.push({ t: 1, v: 1 });
    ring.push({ t: 2, v: 2 });

    assert.deepEqual(ring.toArray(), [{ t: 2, v: 2 }]);
  });

  it("preserves null values rather than dropping them", () => {
    // null means "measured, not measurable" and must survive the ring, because dropping it
    // would silently close a gap in a chart.
    const ring = new SampleRing(3);
    ring.push({ t: 1, v: null });
    ring.push({ t: 2, v: 5 });

    assert.deepEqual(ring.toArray(), [
      { t: 1, v: null },
      { t: 2, v: 5 },
    ]);
  });

  it("wraps correctly when the window slides many times", () => {
    const ring = new SampleRing(3);
    for (let index = 1; index <= 10; index += 1) ring.push({ t: index, v: index });

    assert.deepEqual(
      ring.toArray().map((sample) => sample.t),
      [8, 9, 10],
    );
  });

  it("clears back to empty", () => {
    const ring = new SampleRing(4);
    ring.push({ t: 1, v: 1 });
    ring.push({ t: 2, v: 2 });

    ring.clear();

    assert.equal(ring.size, 0);
    assert.deepEqual(ring.toArray(), []);
  });
});
