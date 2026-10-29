import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SnapshotStore } from "../../src/server/metrics/snapshot-store.ts";
import type { MetricSample } from "../../src/server/collectors/types.ts";

function metric(name: string, value: number | null): MetricSample {
  return { metric: name, label: name, unit: "%", value };
}

function newStore(historyLength = 5): SnapshotStore {
  const store = new SnapshotStore({ historyLength, intervalMs: 500 });
  store.register({ id: "host", label: "This machine", kind: "host" });
  return store;
}

describe("SnapshotStore", () => {
  it("registers a source before its first collection", () => {
    const store = newStore();
    const sources = store.listSources();

    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.id, "host");
    assert.equal(sources[0]?.status, "unavailable");
    assert.equal(sources[0]?.lastSampleAt, null);
  });

  it("ignores a duplicate registration", () => {
    const store = newStore();
    store.register({ id: "host", label: "Duplicate", kind: "host" });

    assert.equal(store.listSources().length, 1);
    assert.equal(store.listSources()[0]?.label, "This machine");
  });

  it("records samples and marks the source ok", () => {
    const store = newStore();
    store.record("host", [metric("cpu.usage", 42)], [], 1000);

    const snapshot = store.snapshot();
    const series = snapshot.series.find((entry) => entry.metric === "cpu.usage");

    assert.equal(snapshot.sources[0]?.status, "ok");
    assert.equal(snapshot.sources[0]?.lastSampleAt, 1000);
    assert.deepEqual(series?.samples, [{ t: 1000, v: 42 }]);
    assert.equal(series?.unit, "%");
  });

  it("caps history at the configured length", () => {
    const store = newStore(4);
    for (let index = 0; index < 20; index += 1) {
      store.record("host", [metric("cpu.usage", index)], [], 1000 + index);
    }

    const series = store.snapshot().series.find((entry) => entry.metric === "cpu.usage");
    assert.equal(series?.samples.length, 4);
  });

  it("keeps total retained samples bounded as uptime grows", () => {
    const store = newStore(10);
    for (let index = 0; index < 5_000; index += 1) {
      store.record(
        "host",
        [metric("cpu.usage", index), metric("memory.usage", index)],
        [],
        1000 + index,
      );
    }

    // Two metrics at capacity 10, regardless of the 5000 iterations.
    assert.equal(store.retainedSampleCount(), 20);
  });

  it("replaces table data instead of accumulating it", () => {
    const store = newStore();
    const table = (mount: string) => ({
      id: "storage.disks",
      columns: ["mount"],
      rows: [{ mount }],
    });

    store.record("host", [], [table("/a")], 1000);
    store.record("host", [], [table("/b")], 2000);
    store.record("host", [], [table("/c")], 3000);

    const tables = store.snapshot().tables;
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0]?.rows, [{ mount: "/c" }]);
  });

  it("marks a source unavailable without touching other sources", () => {
    const store = newStore();
    store.register({ id: "docker", label: "Docker", kind: "docker" });
    store.record("host", [metric("cpu.usage", 1)], [], 1000);
    store.record("docker", [metric("containers.running", 3)], [], 1000);

    store.markUnavailable("docker", "socket not readable", 2000);

    const sources = store.listSources();
    assert.equal(sources.find((s) => s.id === "host")?.status, "ok");
    const docker = sources.find((s) => s.id === "docker");
    assert.equal(docker?.status, "unavailable");
    assert.equal(docker?.error, "socket not readable");
  });

  it("preserves retained history when a source later fails", () => {
    const store = newStore();
    store.record("host", [metric("cpu.usage", 7)], [], 1000);

    store.markUnavailable("host", "boom", 2000);

    // A failure must not erase the data already collected; the chart keeps its history and
    // the status explains why it stopped updating.
    const series = store.snapshot().series.find((entry) => entry.metric === "cpu.usage");
    assert.deepEqual(series?.samples, [{ t: 1000, v: 7 }]);
    assert.equal(series?.status, "unavailable");
  });

  it("keeps lastSampleAt meaning the last successful collection", () => {
    const store = newStore();
    store.record("host", [metric("cpu.usage", 1)], [], 1000);

    store.markUnavailable("host", "boom", 5000);

    assert.equal(store.listSources()[0]?.lastSampleAt, 1000);
  });

  it("clears a previous error once the source recovers", () => {
    const store = newStore();
    store.markUnavailable("host", "boom", 1000);

    store.record("host", [metric("cpu.usage", 1)], [], 2000);

    const source = store.listSources()[0];
    assert.equal(source?.status, "ok");
    assert.equal(source?.error, undefined);
  });

  it("gives every series in one snapshot the same generation timestamp", () => {
    // Guards the atomic-swap design: a reader must never observe a half-updated snapshot.
    const store = newStore();
    store.register({ id: "other", label: "Other", kind: "test" });
    store.record("host", [metric("a", 1), metric("b", 2)], [], 7000);
    store.record("other", [metric("c", 3)], [], 7000);

    const snapshot = store.snapshot();
    assert.equal(snapshot.generatedAt, 7000);
    for (const series of snapshot.series) {
      for (const sample of series.samples) {
        assert.ok(sample.t <= snapshot.generatedAt, `${series.metric} sample is from the future`);
      }
    }
  });

  it("ignores a record for an unregistered source", () => {
    const store = newStore();
    store.record("ghost", [metric("x", 1)], [], 1000);

    assert.equal(store.snapshot().series.length, 0);
  });

  it("echoes the configured interval so the client can detect drift", () => {
    const store = newStore();
    assert.equal(store.snapshot().intervalMs, 500);
  });

  it("unregisters a source and drops everything it contributed", () => {
    const store = newStore();
    store.register({ id: "peer", label: "Peer", kind: "remote-node" });
    store.record("host", [metric("cpu.usage", 1)], [], 1000);
    store.record(
      "peer",
      [metric("cpu.usage", 2)],
      [{ id: "storage.disks", columns: ["mount"], rows: [{ mount: "/" }] }],
      1000,
    );

    assert.equal(store.unregister("peer"), true);
    assert.equal(store.unregister("peer"), false);

    const snapshot = store.snapshot();
    assert.deepEqual(
      snapshot.sources.map((source) => source.id),
      ["host"],
    );
    assert.equal(
      snapshot.series.some((series) => series.sourceId === "peer"),
      false,
    );
    assert.equal(snapshot.tables.length, 0);
  });
});
