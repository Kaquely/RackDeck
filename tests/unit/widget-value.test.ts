import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeWidgetValue } from "../../src/web/widget-value.ts";
import type { WidgetConfig } from "../../src/shared/layout.ts";
import type { TableData } from "../../src/shared/observations.ts";

function widget(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    id: "w1",
    type: "line",
    title: "Metric",
    sourceId: "host",
    metrics: ["cpu.usage"],
    span: 2,
    unit: "%",
    ...overrides,
  };
}

function table(rows: number): TableData {
  return {
    id: "storage.disks",
    columns: ["mount"],
    rows: Array.from({ length: rows }, (_, index) => ({ mount: `/dev/sd${index}` })),
  };
}

describe("describeWidgetValue", () => {
  it("shows a single formatted value", () => {
    const text = describeWidgetValue({
      widget: widget(),
      values: [42],
      series: [],
      table: null,
    });

    assert.equal(text, "42.0%");
  });

  it("shows a dash for a single missing value", () => {
    const text = describeWidgetValue({
      widget: widget(),
      values: [null],
      series: [],
      table: null,
    });

    assert.equal(text, "—");
  });

  it("counts how many series are reporting", () => {
    const text = describeWidgetValue({
      widget: widget({ unit: "" }),
      values: [10, null, 30],
      series: [],
      table: null,
    });

    assert.equal(text, "2/3 reporting");
  });

  it("counts a table by rows rather than by series", () => {
    // A table carries no series, so the series count would read "0/0 reporting" above a
    // fully populated table, which looks like a fault rather than a label.
    const text = describeWidgetValue({
      widget: widget({ type: "table", metrics: ["storage.disks"] }),
      values: [],
      series: [],
      table: table(1),
    });

    assert.equal(text, "1 row");
  });

  it("pluralises a multi-row table", () => {
    const text = describeWidgetValue({
      widget: widget({ type: "table" }),
      values: [],
      series: [],
      table: table(4),
    });

    assert.equal(text, "4 rows");
  });

  it("reports an empty table as zero rows rather than as missing", () => {
    const text = describeWidgetValue({
      widget: widget({ type: "table" }),
      values: [],
      series: [],
      table: table(0),
    });

    assert.equal(text, "0 rows");
  });

  it("shows a dash when there is no table yet", () => {
    const text = describeWidgetValue({
      widget: widget({ type: "table" }),
      values: [],
      series: [],
      table: null,
    });

    assert.equal(text, "—");
  });

  it("shows a dash when no metric resolved at all", () => {
    const text = describeWidgetValue({ widget: widget(), values: [], series: [], table: null });

    assert.equal(text, "—");
  });

  it("falls back to the series unit when the widget declares none", () => {
    const text = describeWidgetValue({
      widget: widget({ unit: undefined }),
      values: [2048],
      series: [
        {
          sourceId: "host",
          metric: "memory.usedBytes",
          label: "Memory",
          unit: "bytes",
          status: "ok",
          samples: [{ t: 1, v: 2048 }],
        },
      ],
      table: null,
    });

    assert.equal(text, "2.0 KiB");
  });
});
