import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CollectorScheduler } from "../../src/server/metrics/collector-scheduler.ts";
import type { SetIntervalFn } from "../../src/server/metrics/collector-scheduler.ts";
import { SnapshotStore } from "../../src/server/metrics/snapshot-store.ts";
import type {
  Collector,
  CollectorResult,
  MetricSample,
} from "../../src/server/collectors/types.ts";

function metric(name: string, value: number | null): MetricSample {
  return { metric: name, label: name, unit: "", value };
}

function okCollector(id: string): Collector {
  return {
    id,
    label: id,
    kind: "test",
    // `Promise.resolve` rather than an `async` function: the contract is async, but this stub
    // has nothing to await, and an async arrow with no await is a lint error for good reason.
    collect: () => Promise.resolve({ status: "ok", metrics: [], tables: [] }),
  };
}

function okResult(metrics: MetricSample[]): Promise<CollectorResult> {
  return Promise.resolve({ status: "ok", metrics, tables: [] });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A controllable interval.
 *
 * The scheduler accepts injected timer functions precisely so its scheduling behaviour can be
 * tested without sleeping. Real-timer tests of a 500 ms product cadence would be both slow
 * and flaky, and would say nothing more than these do.
 */
function fakeInterval(): {
  setIntervalFn: SetIntervalFn;
  fire: () => Promise<void>;
  cancelCount: () => number;
} {
  let handler: (() => void) | null = null;
  let cancels = 0;

  return {
    setIntervalFn: (registered, _intervalMs) => {
      handler = registered;
      return {
        cancel: () => {
          cancels += 1;
          handler = null;
        },
      };
    },
    fire: async () => {
      handler?.();
      // Let the async cycle settle before the caller inspects counters.
      await new Promise((resolve) => setImmediate(resolve));
    },
    cancelCount: () => cancels,
  };
}

function newStore(historyLength = 10, intervalMs = 100): SnapshotStore {
  return new SnapshotStore({ historyLength, intervalMs });
}

describe("CollectorScheduler", () => {
  it("registers every collector with the store on construction", () => {
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [okCollector("a")],
      store,
      intervalMs: 100,
    });

    assert.deepEqual(
      store.listSources().map((source) => source.id),
      ["a"],
    );
    assert.equal(scheduler.running, false);
  });

  it("registers a collector added after construction", () => {
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [],
      store,
      intervalMs: 100,
    });

    scheduler.addCollector(okCollector("late"));

    assert.deepEqual(
      store.listSources().map((source) => source.id),
      ["late"],
    );
    assert.equal(scheduler.hasCollector("late"), true);
  });

  it("rejects a duplicate collector id", () => {
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [okCollector("a")],
      store,
      intervalMs: 100,
    });

    assert.throws(() => scheduler.addCollector(okCollector("a")), /already registered/);
  });

  it("removes a collector and unregisters its source", () => {
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [okCollector("a"), okCollector("b")],
      store,
      intervalMs: 100,
    });

    assert.equal(scheduler.removeCollector("a"), true);
    assert.equal(scheduler.removeCollector("a"), false);
    assert.deepEqual(
      store.listSources().map((source) => source.id),
      ["b"],
    );
    assert.equal(scheduler.hasCollector("a"), false);
  });

  it("picks up a collector added during a cycle on the next cycle", async () => {
    const store = newStore();
    let added = false;
    const holder: { scheduler: CollectorScheduler | null } = { scheduler: null };

    const first: Collector = {
      id: "first",
      label: "first",
      kind: "test",
      collect: () => {
        if (!added) {
          added = true;
          holder.scheduler?.addCollector(okCollector("late"));
        }
        return okResult([metric("x", 1)]);
      },
    };

    const scheduler = new CollectorScheduler({ collectors: [first], store, intervalMs: 100 });
    holder.scheduler = scheduler;

    await scheduler.runOnce();

    // The cycle iterates a snapshot, so the new collector is registered but has not run yet.
    assert.deepEqual(
      store.listSources().map((source) => source.id),
      ["first", "late"],
    );
    assert.equal(store.listSources().find((source) => source.id === "late")?.status, "unavailable");

    await scheduler.runOnce();
    assert.equal(store.listSources().find((source) => source.id === "late")?.status, "ok");
  });

  it("records a successful collection", async () => {
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [
        {
          id: "a",
          label: "a",
          kind: "test",
          collect: () => okResult([metric("x", 5)]),
        },
      ],
      store,
      intervalMs: 100,
    });

    await scheduler.runOnce();

    assert.equal(scheduler.cycles, 1);
    assert.equal(store.snapshot().series[0]?.samples[0]?.v, 5);
    assert.equal(store.listSources()[0]?.status, "ok");
  });

  it("isolates a failing collector from the others", async () => {
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [
        {
          id: "bad",
          label: "bad",
          kind: "test",
          collect: () => Promise.reject(new Error("socket not readable")),
        },
        {
          id: "good",
          label: "good",
          kind: "test",
          collect: () => okResult([metric("x", 1)]),
        },
      ],
      store,
      intervalMs: 100,
    });

    await scheduler.runOnce();

    const sources = store.listSources();
    assert.equal(sources.find((s) => s.id === "bad")?.status, "unavailable");
    assert.equal(sources.find((s) => s.id === "bad")?.error, "socket not readable");
    // The healthy source is completely unaffected: this is what keeps one unreachable
    // application from blanking the whole dashboard.
    assert.equal(sources.find((s) => s.id === "good")?.status, "ok");
    assert.equal(store.snapshot().series.find((s) => s.metric === "x")?.samples.length, 1);
  });

  it("handles a collector that rejects with a non-Error value", async () => {
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [
        {
          id: "bad",
          label: "bad",
          kind: "test",
          // Rejecting with a non-Error is exactly what this test exists to cover: a
          // collector written by someone else must not be able to crash the scheduler.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          collect: () => Promise.reject("plain string"),
        },
      ],
      store,
      intervalMs: 100,
    });

    await scheduler.runOnce();

    assert.equal(store.listSources()[0]?.error, "plain string");
  });

  it("skips a tick while the previous cycle is still running", async () => {
    const store = newStore(10, 50);
    let started = 0;

    const scheduler = new CollectorScheduler({
      collectors: [
        {
          id: "slow",
          label: "slow",
          kind: "test",
          collect: async () => {
            started += 1;
            await delay(300);
            return { status: "ok" as const, metrics: [], tables: [] };
          },
        },
      ],
      store,
      intervalMs: 50,
      collectTimeoutMs: 5_000,
    });

    // Overlapping requests: only one may run, the rest must be skipped, not queued.
    await Promise.all([
      scheduler.runOnce(),
      scheduler.runOnce(),
      scheduler.runOnce(),
      scheduler.runOnce(),
      scheduler.runOnce(),
    ]);

    assert.equal(started, 1);
    assert.equal(scheduler.skippedTicks, 4);
  });

  it("collects immediately on start so the first paint is not blank", async () => {
    const store = newStore();
    const timers = fakeInterval();
    const scheduler = new CollectorScheduler({
      collectors: [okCollector("a")],
      store,
      intervalMs: 500,
      setIntervalFn: timers.setIntervalFn,
    });

    scheduler.start();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(scheduler.cycles >= 1, "expected an immediate first collection");
  });

  it("collects once per interval tick", async () => {
    const store = newStore();
    const timers = fakeInterval();
    const scheduler = new CollectorScheduler({
      collectors: [okCollector("a")],
      store,
      intervalMs: 500,
      setIntervalFn: timers.setIntervalFn,
    });

    scheduler.start();
    await new Promise((resolve) => setImmediate(resolve));
    const afterStart = scheduler.cycles;

    await timers.fire();
    await timers.fire();
    await timers.fire();

    assert.equal(scheduler.cycles, afterStart + 3);
  });

  it("stops collecting after stop()", async () => {
    const store = newStore();
    const timers = fakeInterval();
    const scheduler = new CollectorScheduler({
      collectors: [okCollector("a")],
      store,
      intervalMs: 500,
      setIntervalFn: timers.setIntervalFn,
    });

    scheduler.start();
    await new Promise((resolve) => setImmediate(resolve));
    scheduler.stop();
    assert.equal(scheduler.running, false);

    const afterStop = scheduler.cycles;
    // The handler is detached, so firing it must have no effect.
    await timers.fire();

    assert.equal(scheduler.cycles, afterStop, "no cycles may run after stop()");
    assert.equal(timers.cancelCount(), 1, "the interval must be cancelled exactly once");
  });

  it("is idempotent on repeated start and stop", async () => {
    const store = newStore();
    const timers = fakeInterval();
    const scheduler = new CollectorScheduler({
      collectors: [okCollector("a")],
      store,
      intervalMs: 500,
      setIntervalFn: timers.setIntervalFn,
    });

    scheduler.start();
    scheduler.start();
    await new Promise((resolve) => setImmediate(resolve));
    const afterStart = scheduler.cycles;

    await timers.fire();
    // A second start must not have installed a second interval.
    assert.equal(scheduler.cycles, afterStart + 1);

    scheduler.stop();
    scheduler.stop();

    assert.equal(scheduler.running, false);
    assert.equal(timers.cancelCount(), 1);
  });

  it("drives a real interval when none is injected", async () => {
    // One test with real timers, to prove the production wiring actually fires. Kept short
    // and with a loose bound so it cannot become a flaky gate.
    const store = newStore(50, 30);
    const scheduler = new CollectorScheduler({
      collectors: [okCollector("a")],
      store,
      intervalMs: 30,
    });

    scheduler.start();
    try {
      await delay(200);
      assert.ok(scheduler.cycles >= 2, `expected repeated cycles, got ${scheduler.cycles}`);
    } finally {
      scheduler.stop();
    }
  });

  it("abandons a collector that never responds", async () => {
    const store = newStore();
    let started = 0;

    const scheduler = new CollectorScheduler({
      collectors: [
        {
          id: "hung",
          label: "hung",
          kind: "test",
          collect: () => {
            started += 1;
            return new Promise<CollectorResult>(() => {});
          },
        },
      ],
      store,
      intervalMs: 10,
      collectTimeoutMs: 60,
    });

    // Must terminate: the timeout is what makes the cycle settle.
    await scheduler.runOnce();

    assert.equal(started, 1, "a hung collector must not be re-entered");
    const source = store.listSources()[0];
    assert.equal(source?.status, "unavailable");
    assert.match(source?.error ?? "", /did not respond within 60ms/);
  });

  it("a hung collector does not stop a healthy one from publishing", async () => {
    // The point of the timeout: without it the cycle never completes and the dashboard
    // silently freezes while still looking healthy.
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [
        {
          id: "hung",
          label: "hung",
          kind: "test",
          collect: () => new Promise<CollectorResult>(() => {}),
        },
        {
          id: "healthy",
          label: "healthy",
          kind: "test",
          collect: () => okResult([metric("x", 42)]),
        },
      ],
      store,
      intervalMs: 10,
      collectTimeoutMs: 60,
    });

    await scheduler.runOnce();

    assert.equal(store.listSources().find((s) => s.id === "hung")?.status, "unavailable");
    assert.equal(store.listSources().find((s) => s.id === "healthy")?.status, "ok");
    assert.equal(store.snapshot().series.find((s) => s.metric === "x")?.samples[0]?.v, 42);
  });

  it("lets a slow but responsive collector complete", async () => {
    const store = newStore();
    const scheduler = new CollectorScheduler({
      collectors: [
        {
          id: "slow",
          label: "slow",
          kind: "test",
          // Slower than the collection interval, but well inside the timeout.
          collect: async () => {
            await delay(40);
            return { status: "ok" as const, metrics: [metric("x", 1)], tables: [] };
          },
        },
      ],
      store,
      intervalMs: 5,
      collectTimeoutMs: 2_000,
    });

    await scheduler.runOnce();

    assert.equal(store.listSources()[0]?.status, "ok");
    assert.equal(store.snapshot().series[0]?.samples.length, 1);
  });
});
