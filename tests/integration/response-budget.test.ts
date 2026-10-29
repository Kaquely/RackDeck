import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";
import { SnapshotStore } from "../../src/server/metrics/snapshot-store.ts";

/**
 * The page must respond in under 200 ms.
 *
 * This asserts the property that makes the budget achievable at all: the request path reads
 * a pre-populated in-memory buffer and performs no source I/O. The buffer is filled with a
 * realistic amount of data — many metrics at the maximum configured history — so the
 * measurement is not flattered by an almost-empty store.
 */

const BUDGET_MS = 200;

describe("response budget", () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });

  after(async () => {
    await harness.close();
  });

  it("answers GET /api/readings well inside the budget", async () => {
    // Warm the connection so the measurement reflects server work, not TCP setup.
    await fetch(`${harness.baseUrl}/api/readings`);

    const durations: number[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = performance.now();
      const response = await fetch(`${harness.baseUrl}/api/readings`);
      const body = (await response.json()) as { series: unknown[] };
      durations.push(performance.now() - started);

      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body.series));
    }

    const worst = Math.max(...durations);
    const median = [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] ?? 0;

    // Generous relative to the measured cost, but still a real ceiling: this endpoint must
    // never become a place where source I/O happens.
    assert.ok(
      worst < BUDGET_MS,
      `slowest response was ${worst.toFixed(1)}ms, budget is ${BUDGET_MS}ms`,
    );
    assert.ok(median < BUDGET_MS / 2, `median response was ${median.toFixed(1)}ms`);
  });

  it("serves a large populated snapshot from memory inside the budget", () => {
    // 30 metrics x 2000 samples is far more than the shipped default of 600, so this is a
    // deliberately pessimistic check of the serialisation path.
    const store = new SnapshotStore({ historyLength: 2000, intervalMs: 500 });
    store.register({ id: "host", label: "This machine", kind: "host" });

    for (let index = 0; index < 2000; index += 1) {
      store.record(
        "host",
        Array.from({ length: 30 }, (_, metric) => ({
          metric: `m${metric}`,
          label: `Metric ${metric}`,
          unit: "%",
          value: metric + index / 1000,
        })),
        [],
        1_700_000_000_000 + index,
      );
    }

    const snapshot = store.snapshot();
    const started = performance.now();
    const serialised = JSON.stringify(snapshot);
    const elapsed = performance.now() - started;

    assert.equal(snapshot.series.length, 30);
    assert.ok(serialised.length > 100_000, "expected a substantial payload");
    assert.ok(elapsed < BUDGET_MS, `serialising took ${elapsed.toFixed(1)}ms`);
  });

  it("does not grow retained samples as uptime increases", () => {
    // The structural half of the budget: 24/7 operation must not become a memory leak.
    const store = new SnapshotStore({ historyLength: 600, intervalMs: 500 });
    store.register({ id: "host", label: "This machine", kind: "host" });

    for (let index = 0; index < 50_000; index += 1) {
      store.record(
        "host",
        [
          { metric: "cpu.usage", label: "CPU", unit: "%", value: index % 100 },
          { metric: "memory.usage", label: "Memory", unit: "%", value: index % 100 },
        ],
        [],
        1_700_000_000_000 + index,
      );
    }

    assert.equal(store.retainedSampleCount(), 1200);
  });
});
