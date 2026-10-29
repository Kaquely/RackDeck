import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { registerDom } from "../helpers/dom.ts";
import type { Layout, WidgetConfig } from "../../src/shared/layout.ts";
import type { ReadingsSnapshot, Series, TableData } from "../../src/shared/observations.ts";
import { indexReadings } from "../../src/web/api.ts";
import {
  buildSummary,
  humaniseColumn,
  renderChart,
  resolveWidget,
} from "../../src/web/charts/render.ts";

registerDom();

function series(
  metric: string,
  values: (number | null)[],
  unit = "%",
  status: Series["status"] = "ok",
  label = metric,
): Series {
  return {
    sourceId: "host",
    metric,
    label,
    unit,
    status,
    samples: values.map((v, index) => ({ t: 1_700_000_000_000 + index * 500, v })),
  };
}

const DISKS: TableData = {
  id: "storage.disks",
  columns: ["mount", "type", "sizeBytes", "usedBytes", "availableBytes", "usedPercent"],
  rows: [
    {
      mount: "/",
      type: "ext4",
      sizeBytes: 1024 ** 3,
      usedBytes: 512 * 1024 ** 2,
      availableBytes: 512 * 1024 ** 2,
      usedPercent: 50,
    },
  ],
};

function snapshot(overrides: Partial<ReadingsSnapshot> = {}): ReadingsSnapshot {
  return {
    generatedAt: 1_700_000_000_000,
    intervalMs: 500,
    sources: [{ id: "host", label: "This machine", kind: "host", status: "ok", lastSampleAt: 1 }],
    series: [series("cpu.usage", [10, 20, 30], "%", "ok", "CPU usage")],
    tables: [DISKS],
    ...overrides,
  };
}

function widget(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    id: "w1",
    type: "line",
    title: "CPU",
    sourceId: "host",
    metrics: ["cpu.usage"],
    span: 2,
    unit: "%",
    ...overrides,
  };
}

function render(config: Partial<WidgetConfig> = {}, data = snapshot()) {
  const resolved = resolveWidget(widget(config), indexReadings(data));
  return { resolved, node: renderChart(resolved) };
}

describe("resolveWidget", () => {
  it("resolves a published metric", () => {
    const resolved = resolveWidget(widget(), indexReadings(snapshot()));

    assert.equal(resolved.series.length, 1);
    assert.deepEqual(resolved.missing, []);
  });

  it("resolves a table id", () => {
    const resolved = resolveWidget(
      widget({ type: "table", metrics: ["storage.disks"] }),
      indexReadings(snapshot()),
    );

    assert.ok(resolved.table);
    assert.equal(resolved.missing.length, 0);
  });

  it("reports a metric the source does not publish", () => {
    const resolved = resolveWidget(
      widget({ metrics: ["does.not.exist"] }),
      indexReadings(snapshot()),
    );

    assert.deepEqual(resolved.missing, ["does.not.exist"]);
  });

  it("separates a source's series from another source's", () => {
    const data = snapshot({
      series: [series("cpu.usage", [1]), { ...series("cpu.usage", [2]), sourceId: "docker" }],
    });

    const resolved = resolveWidget(widget(), indexReadings(data));

    assert.equal(resolved.series.length, 1);
    assert.equal(resolved.series[0]?.sourceId, "host");
  });
});

describe("line renderer", () => {
  it("produces an SVG with a path", () => {
    const { node } = render();

    assert.equal(node.tagName.toLowerCase(), "svg");
    assert.ok(node.querySelector("path"), "expected a rendered path");
  });

  it("renders one path per series for a multi-series widget", () => {
    const data = snapshot({
      series: [
        series("network.rxBytesPerSecond", [10, 20], "B/s"),
        series("network.txBytesPerSecond", [5, 15], "B/s"),
      ],
    });

    const { node } = render(
      { metrics: ["network.rxBytesPerSecond", "network.txBytesPerSecond"] },
      data,
    );

    const paths = node.querySelectorAll("path");
    assert.ok(paths.length >= 2, `expected at least two paths, got ${paths.length}`);
  });

  it("distinguishes series by dash pattern as well as colour", () => {
    // Colour alone would fail for a colour-blind reader or a greyscale print.
    const data = snapshot({
      series: [
        series("network.rxBytesPerSecond", [10, 20], "B/s"),
        series("network.txBytesPerSecond", [5, 15], "B/s"),
      ],
    });

    const { node } = render(
      { metrics: ["network.rxBytesPerSecond", "network.txBytesPerSecond"] },
      data,
    );

    const dashes = [...node.querySelectorAll("path")].map((path) =>
      path.getAttribute("stroke-dasharray"),
    );
    assert.ok(new Set(dashes).size > 1, "series must differ by dash pattern");
  });

  it("marks each line and area with its series index", () => {
    const data = snapshot({
      series: [
        series("network.rxBytesPerSecond", [10, 20], "B/s"),
        series("network.txBytesPerSecond", [5, 15], "B/s"),
      ],
    });

    const { node } = render(
      { metrics: ["network.rxBytesPerSecond", "network.txBytesPerSecond"] },
      data,
    );

    const indexes = (selector: string) =>
      [...node.querySelectorAll(selector)].map((path) => path.getAttribute("data-series-index"));

    assert.deepEqual(indexes(".chart__line"), ["1", "2"]);
    assert.deepEqual(indexes(".chart__area"), ["1", "2"]);
  });

  it("renders an axis with tick labels", () => {
    const { node } = render();

    assert.ok(node.querySelectorAll("text").length > 0, "expected axis labels");
  });

  it("uses the measured widget width as the view box", () => {
    // A fixed 320-unit view box stretched to a wider widget made every label wider too.
    const resolved = resolveWidget(widget(), indexReadings(snapshot()));

    const node = renderChart(resolved, { width: 640 });

    assert.equal(node.getAttribute("viewBox"), "0 0 640 140");
    assert.notEqual(node.getAttribute("preserveAspectRatio"), "none");
  });

  it("falls back to the default width when the container is not measurable", () => {
    const resolved = resolveWidget(widget(), indexReadings(snapshot()));

    const node = renderChart(resolved, { width: 0 });

    assert.equal(node.getAttribute("viewBox"), "0 0 320 140");
  });
});

describe("bar renderer", () => {
  it("produces one bar per sample", () => {
    const { node } = render({ type: "bar" });

    assert.equal(node.querySelectorAll("rect").length, 3);
  });

  it("produces no bar for a null sample", () => {
    const data = snapshot({ series: [series("cpu.usage", [10, null, 30])] });

    const { node } = render({ type: "bar" }, data);

    assert.equal(node.querySelectorAll("rect").length, 2);
  });

  it("keeps the series index on grouped bars when a sample is skipped", () => {
    const data = snapshot({
      series: [
        series("cpu.usage", [null, 20], "%", "ok", "CPU usage"),
        series("memory.usage", [10, 40], "%", "ok", "Memory usage"),
      ],
    });

    const { node } = render({ type: "bar", metrics: ["cpu.usage", "memory.usage"] }, data);

    const bars = [...node.querySelectorAll("rect.chart__bar")];
    assert.deepEqual(
      bars.map((bar) => bar.getAttribute("data-series-index")),
      ["2", "1", "2"],
    );
    assert.deepEqual(
      bars.map((bar) => bar.getAttribute("data-series")),
      ["Memory usage", "CPU usage", "Memory usage"],
    );
  });
});

describe("gauge renderer", () => {
  it("draws a track and a value arc", () => {
    const data = snapshot({ series: [series("memory.usage", [42])] });

    const { node } = render({ type: "gauge", metrics: ["memory.usage"], min: 0, max: 100 }, data);

    assert.ok(node.querySelector(".chart__track"), "expected a track");
    assert.ok(node.querySelector(".chart__gauge"), "expected a value arc");
  });

  it("shows the numeric value inside the dial", () => {
    const data = snapshot({ series: [series("memory.usage", [42])] });

    const { node } = render({ type: "gauge", metrics: ["memory.usage"], min: 0, max: 100 }, data);

    const value = node.querySelector(".chart__gauge-value");
    assert.equal(value?.textContent, "42.0%");
  });

  it("clamps the arc but still shows the true value", () => {
    // An arc that overflows its track is unreadable, but the number must not be hidden.
    const data = snapshot({ series: [series("memory.usage", [150])] });

    const { node } = render({ type: "gauge", metrics: ["memory.usage"], min: 0, max: 100 }, data);

    assert.ok(node.querySelector(".chart__gauge"), "expected a clamped arc");
    assert.equal(node.querySelector(".chart__gauge-value")?.textContent, "150.0%");
  });
});

describe("bullet renderer", () => {
  it("draws qualitative bands and a value marker", () => {
    const data = snapshot({ series: [series("cpu.loadAverage", [1.5], "")] });

    const { node } = render({ type: "bullet", metrics: ["cpu.loadAverage"], min: 0, max: 8 }, data);

    assert.ok(node.querySelectorAll(".chart__band").length > 0, "expected bands");
    assert.ok(node.querySelector(".chart__marker"), "expected a value marker");
  });

  it("states that there is no data yet, rather than drawing an empty track", () => {
    // The spec requires an all-null series to report absence for every chart type. A bullet
    // showing only its bands would imply a measurement of zero.
    const data = snapshot({ series: [series("cpu.loadAverage", [null], "")] });

    const { node } = render({ type: "bullet", metrics: ["cpu.loadAverage"], min: 0, max: 8 }, data);

    assert.match(node.textContent ?? "", /No data available/);
    assert.equal(node.querySelectorAll(".chart__band").length, 0);
  });
});

describe("table renderer", () => {
  it("renders a header and a row per entry", () => {
    const { node } = render({ type: "table", metrics: ["storage.disks"] });

    assert.equal(node.tagName.toLowerCase(), "div");
    const table = node.querySelector("table");
    assert.ok(table, "expected a table element");
    assert.equal(table?.querySelectorAll("thead th").length, DISKS.columns.length);
    assert.equal(table?.querySelectorAll("tbody tr").length, DISKS.rows.length);
  });

  it("formats byte columns for reading rather than showing raw integers", () => {
    const { node } = render({ type: "table", metrics: ["storage.disks"] });

    const cells = [...(node.querySelectorAll("tbody td") ?? [])].map((cell) => cell.textContent);
    assert.ok(cells.includes("1.0 GiB"), `expected a formatted size, got ${JSON.stringify(cells)}`);
  });

  it("humanises column names", () => {
    assert.equal(humaniseColumn("usedBytes"), "Used bytes");
    assert.equal(humaniseColumn("mount"), "Mount");
    assert.equal(humaniseColumn("usedPercent"), "Used percent");
  });

  it("says so when there is no table data", () => {
    const data = snapshot({ tables: [] });

    const { node } = render({ type: "table", metrics: ["storage.disks"] }, data);

    assert.match(node.textContent ?? "", /No table data/);
  });
});

describe("honest states", () => {
  it("reports an unavailable metric rather than drawing nothing", () => {
    const { resolved, node } = render({ metrics: ["nope.missing"] });

    assert.deepEqual(resolved.missing, ["nope.missing"]);
    assert.match(node.textContent ?? "", /No data available/);
  });

  it("renders an all-null series as absent, not as zero", () => {
    // A flat line at zero would read as a healthy measurement that was never taken.
    const data = snapshot({ series: [series("cpu.usage", [null, null, null])] });

    const { node } = render({}, data);

    assert.match(node.textContent ?? "", /No data available/);
    assert.equal(node.querySelector("path"), null);
  });

  it("still draws a table whose rows are empty", () => {
    const data = snapshot({ tables: [{ ...DISKS, rows: [] }] });

    const { node } = render({ type: "table", metrics: ["storage.disks"] }, data);

    assert.equal(node.querySelectorAll("tbody tr").length, 0);
  });
});

describe("buildSummary", () => {
  it("names the metric and its latest value", () => {
    const summary = buildSummary(resolveWidget(widget(), indexReadings(snapshot())));

    assert.match(summary, /CPU usage/);
    assert.match(summary, /30\.0%/);
  });

  it("names a missing metric", () => {
    const summary = buildSummary(
      resolveWidget(widget({ metrics: ["gone"] }), indexReadings(snapshot())),
    );

    assert.match(summary, /Metric not available: gone/);
  });

  it("summarises a table by shape", () => {
    const summary = buildSummary(
      resolveWidget(
        widget({ type: "table", metrics: ["storage.disks"] }),
        indexReadings(snapshot()),
      ),
    );

    assert.match(summary, /1 rows of 6 columns/);
  });

  it("reports how much history is retained", () => {
    const summary = buildSummary(resolveWidget(widget(), indexReadings(snapshot())));

    assert.match(summary, /3 samples retained/);
  });

  it("distinguishes a missing value from a real zero", () => {
    const missing = buildSummary(
      resolveWidget(widget(), indexReadings(snapshot({ series: [series("cpu.usage", [null])] }))),
    );
    const zero = buildSummary(
      resolveWidget(widget(), indexReadings(snapshot({ series: [series("cpu.usage", [0])] }))),
    );

    assert.match(missing, /—/);
    assert.match(zero, /0\.0%/);
  });
});

describe("accessibility", () => {
  it("marks charts as decorative so the summary carries the meaning", () => {
    const { node } = render();

    assert.equal(node.getAttribute("role"), "presentation");
    assert.equal(node.getAttribute("aria-hidden") ?? "true", "true");
  });

  it("gives every widget a text summary", () => {
    const layout: Layout = {
      version: 1,
      activeTabId: "a",
      tabs: [{ id: "a", name: "A", widgets: [widget()] }],
    };
    assert.equal(layout.tabs[0]?.widgets.length, 1);

    for (const type of ["line", "bar", "gauge", "bullet", "table"] as const) {
      const data =
        type === "table"
          ? snapshot()
          : snapshot({ series: [series("cpu.usage", [10, 20]), series("memory.usage", [30, 40])] });
      const metrics = type === "table" ? ["storage.disks"] : ["cpu.usage", "memory.usage"];
      const summary = buildSummary(resolveWidget(widget({ type, metrics }), indexReadings(data)));
      assert.ok(summary.length > 0, `${type} produced no summary`);
    }
  });
});

before(() => {
  registerDom();
});
