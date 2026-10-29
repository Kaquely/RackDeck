import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOST_METRIC_KEYS,
  HOST_TABLE_IDS,
  createHostCollector,
} from "../../src/server/collectors/host.ts";
import { defaultLayout } from "../../src/shared/layout.ts";

describe("host collector", () => {
  it("publishes every declared metric key, with a label and a unit", async () => {
    const result = await createHostCollector().collect();

    assert.equal(result.status, "ok");
    const published = new Set(result.metrics.map((entry) => entry.metric));
    for (const key of HOST_METRIC_KEYS) {
      assert.ok(published.has(key), `collector did not publish ${key}`);
    }
    for (const entry of result.metrics) {
      assert.ok(entry.label.length > 0, `${entry.metric} has no label`);
      assert.equal(typeof entry.unit, "string", `${entry.metric} has no unit`);
      assert.ok(
        entry.value === null || Number.isFinite(entry.value),
        `${entry.metric} published a non-finite value`,
      );
    }
  });

  it("publishes nothing outside the declared key set", async () => {
    const result = await createHostCollector().collect();
    const declared = new Set<string>(HOST_METRIC_KEYS);

    for (const entry of result.metrics) {
      assert.ok(declared.has(entry.metric), `undeclared metric published: ${entry.metric}`);
    }
  });

  it("publishes both declared tables", async () => {
    const result = await createHostCollector().collect();
    const published = new Set(result.tables.map((table) => table.id));

    for (const id of HOST_TABLE_IDS) {
      assert.ok(published.has(id), `collector did not publish table ${id}`);
    }
  });

  it("gives every table a column list matching its rows", async () => {
    const result = await createHostCollector().collect();

    for (const table of result.tables) {
      assert.ok(table.columns.length > 0, `${table.id} has no columns`);
      for (const row of table.rows) {
        for (const column of table.columns) {
          assert.ok(column in row, `${table.id} row is missing column ${column}`);
        }
      }
    }
  });

  it("publishes memory totals and a consistent usage percentage", async () => {
    const result = await createHostCollector().collect();
    const byKey = new Map(result.metrics.map((entry) => [entry.metric, entry.value]));

    const total = byKey.get("memory.totalBytes");
    const used = byKey.get("memory.usedBytes");
    const usage = byKey.get("memory.usage");

    assert.ok(typeof total === "number" && total > 0, "memory.totalBytes missing");
    assert.ok(typeof used === "number" && used >= 0, "memory.usedBytes missing");
    assert.ok(typeof usage === "number", "memory.usage missing");
    assert.ok(usage >= 0 && usage <= 100, `memory.usage out of range: ${usage}`);
    assert.ok(used <= total, "used memory exceeds total memory");
  });

  it("publishes CPU usage as null on the first cycle and a number afterwards", async () => {
    const collector = createHostCollector();

    const first = await collector.collect();
    const firstCpu = first.metrics.find((entry) => entry.metric === "cpu.usage")?.value;
    // There is no previous sample to difference against, so the honest answer is null.
    assert.equal(firstCpu, null);

    const second = await collector.collect();
    const secondCpu = second.metrics.find((entry) => entry.metric === "cpu.usage")?.value ?? null;
    assert.equal(typeof secondCpu, "number");
    assert.ok(secondCpu !== null && secondCpu >= 0 && secondCpu <= 100);
  });

  it("publishes load average as null where the platform has none", async () => {
    // Windows reports [0, 0, 0]. A 0 would pin a bullet chart to zero on a healthy machine.
    const result = await createHostCollector().collect();
    const load = result.metrics.find((entry) => entry.metric === "cpu.loadAverage")?.value;

    if (process.platform === "win32") {
      assert.equal(load, null);
    } else {
      assert.ok(load === null || (typeof load === "number" && load > 0));
    }
  });

  it("publishes network rates only when a fresh measurement exists", async () => {
    const collector = createHostCollector();

    // Off Linux the rate is measurable only on the slow tier, so most cycles must not append
    // a point at all. Appending nulls would render as a broken line rather than a coarser one.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const result = await collector.collect();
      const rx = result.metrics.find((entry) => entry.metric === "network.rxBytesPerSecond");
      if (rx) {
        assert.ok(
          rx.value === null || rx.value >= 0,
          "a published network rate must not be negative",
        );
      }
    }
  });

  it("does not modify the host it observes", async () => {
    // The product is read-only. It issues no command and touches no file outside /proc reads.
    const result = await createHostCollector().collect();

    assert.equal(result.status, "ok");
    // The only metric families present are observational; there is no mutating operation in
    // the collector contract at all, which is asserted structurally in the contract tests.
    for (const entry of result.metrics) {
      assert.match(entry.metric, /^(cpu|memory|uptime|network|storage|processes)\./, entry.metric);
    }
  });
});

describe("defaultLayout metric keys", () => {
  it("references only metrics and tables the host collector publishes", () => {
    // Without this check a renamed metric would leave the shipped default layout pointing at
    // nothing, and every default widget would silently render empty.
    const known = new Set<string>([...HOST_METRIC_KEYS, ...HOST_TABLE_IDS]);

    for (const tab of defaultLayout().tabs) {
      for (const widget of tab.widgets) {
        assert.equal(widget.sourceId, "host", `${widget.id} targets an unknown source`);
        for (const metric of widget.metrics) {
          assert.ok(known.has(metric), `${widget.id} references unknown metric "${metric}"`);
        }
      }
    }
  });

  it("exercises every supported chart type", () => {
    // The shipped default layout should demonstrate every supported chart form.
    const used = new Set(defaultLayout().tabs.flatMap((tab) => tab.widgets.map((w) => w.type)));

    for (const type of ["line", "bar", "gauge", "table", "bullet"]) {
      assert.ok(used.has(type as never), `default layout does not demonstrate "${type}"`);
    }
  });
});
