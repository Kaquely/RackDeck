import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeTab,
  addTab,
  addWidget,
  dataSignature,
  emptyLayout,
  moveWidget,
  removeTab,
  removeWidget,
  renameTab,
  setActiveTab,
  setWidgetMetric,
  setWidgetMetrics,
  setWidgetSpan,
  setWidgetTitle,
  setWidgetType,
  updateWidget,
} from "../../src/web/layout-ops.ts";
import { LAYOUT_LIMITS, LAYOUT_VERSION, validateLayout } from "../../src/shared/layout.ts";
import type { Layout, WidgetConfig } from "../../src/shared/layout.ts";

function widget(id: string, overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    id,
    type: "line",
    title: id.toUpperCase(),
    sourceId: "host",
    metrics: ["cpu.usage"],
    span: 2,
    ...overrides,
  };
}

function layoutWith(...tabSpecs: { id: string; name: string; widgets?: WidgetConfig[] }[]): Layout {
  return {
    version: LAYOUT_VERSION,
    activeTabId: tabSpecs[0]?.id ?? "tab",
    tabs: tabSpecs.map((spec) => ({
      id: spec.id,
      name: spec.name,
      widgets: spec.widgets ?? [],
    })),
  };
}

describe("activeTab", () => {
  it("returns the selected tab", () => {
    const layout = layoutWith({ id: "a", name: "A" }, { id: "b", name: "B" });

    assert.equal(activeTab({ ...layout, activeTabId: "b" }).id, "b");
  });

  it("falls back to the first tab when the selection is inconsistent", () => {
    // A document from disk could be inconsistent even though it validated; the dashboard must
    // always have something to render.
    const layout = layoutWith({ id: "a", name: "A" });

    assert.equal(activeTab({ ...layout, activeTabId: "missing" }).id, "a");
  });

  it("never returns undefined for an empty document", () => {
    assert.ok(activeTab({ version: 1, activeTabId: "", tabs: [] }));
  });
});

describe("setActiveTab", () => {
  it("switches to an existing tab", () => {
    const layout = layoutWith({ id: "a", name: "A" }, { id: "b", name: "B" });

    assert.equal(setActiveTab(layout, "b").activeTabId, "b");
  });

  it("ignores an unknown tab", () => {
    const layout = layoutWith({ id: "a", name: "A" });

    assert.equal(setActiveTab(layout, "nope").activeTabId, "a");
  });

  it("returns the same document when nothing changes", () => {
    const layout = layoutWith({ id: "a", name: "A" });

    assert.equal(setActiveTab(layout, "a"), layout);
  });
});

describe("addTab", () => {
  it("adds and activates a tab", () => {
    const next = addTab(layoutWith({ id: "a", name: "A" }), "Storage");

    assert.equal(next.tabs.length, 2);
    assert.equal(next.activeTabId, next.tabs[1]?.id);
    assert.equal(next.tabs[1]?.name, "Storage");
  });

  it("derives a readable id from the name", () => {
    const next = addTab(layoutWith({ id: "a", name: "A" }), "Network Health");

    assert.equal(next.tabs[1]?.id, "tab-network-health");
  });

  it("gives a duplicate name a distinct id", () => {
    const first = addTab(layoutWith({ id: "a", name: "A" }), "Storage");
    const second = addTab(first, "Storage");

    assert.notEqual(second.tabs[1]?.id, second.tabs[2]?.id);
  });

  it("refuses to exceed the tab limit", () => {
    let layout = layoutWith({ id: "a", name: "A" });
    for (let index = 1; index < LAYOUT_LIMITS.maxTabs; index += 1) {
      layout = addTab(layout, `Tab ${index}`);
    }
    assert.equal(layout.tabs.length, LAYOUT_LIMITS.maxTabs);

    assert.equal(addTab(layout, "One too many"), layout);
  });

  it("produces a document that still validates", () => {
    const next = addTab(layoutWith({ id: "a", name: "A" }), "Storage");

    assert.equal(validateLayout(next).ok, true);
  });
});

describe("renameTab", () => {
  it("renames a tab", () => {
    const next = renameTab(layoutWith({ id: "a", name: "System" }), "a", "Overview");

    assert.equal(next.tabs[0]?.name, "Overview");
  });

  it("trims and truncates the name", () => {
    const next = renameTab(
      layoutWith({ id: "a", name: "System" }),
      "a",
      `  ${"x".repeat(LAYOUT_LIMITS.tabNameMaxLength + 20)}  `,
    );

    assert.equal(next.tabs[0]?.name?.length, LAYOUT_LIMITS.tabNameMaxLength);
  });

  it("ignores an empty name", () => {
    const layout = layoutWith({ id: "a", name: "System" });

    assert.equal(renameTab(layout, "a", "   "), layout);
  });
});

describe("removeTab", () => {
  it("removes a tab", () => {
    const next = removeTab(layoutWith({ id: "a", name: "A" }, { id: "b", name: "B" }), "b");

    assert.equal(next.tabs.length, 1);
    assert.equal(next.tabs[0]?.id, "a");
  });

  it("activates the neighbour when the active tab is deleted", () => {
    const layout = {
      ...layoutWith({ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }),
      activeTabId: "b",
    };

    const next = removeTab(layout, "b");

    // The tab that took its place, so the dashboard is never left showing nothing.
    assert.equal(next.activeTabId, "c");
  });

  it("falls back to the previous tab when the last one is deleted", () => {
    const layout = layoutWith({ id: "a", name: "A" }, { id: "b", name: "B" });

    assert.equal(removeTab(layout, "b").activeTabId, "a");
  });

  it("never removes the final tab", () => {
    const layout = layoutWith({ id: "a", name: "A" });

    assert.equal(removeTab(layout, "a"), layout);
  });

  it("leaves the selection alone when a different tab is deleted", () => {
    const layout = {
      ...layoutWith({ id: "a", name: "A" }, { id: "b", name: "B" }),
      activeTabId: "b",
    };

    assert.equal(removeTab(layout, "a").activeTabId, "b");
  });
});

describe("widget management", () => {
  it("adds a widget with a generated id", () => {
    const next = addWidget(layoutWith({ id: "a", name: "A" }), "a", {
      type: "line",
      title: "CPU",
      sourceId: "host",
      metrics: ["cpu.usage"],
      span: 2,
    });

    assert.equal(next.tabs[0]?.widgets.length, 1);
    assert.equal(next.tabs[0]?.widgets[0]?.title, "CPU");
  });

  it("gives duplicate widget ids distinct values", () => {
    let layout = layoutWith({ id: "a", name: "A" });
    const spec = {
      type: "line" as const,
      title: "CPU",
      sourceId: "host",
      metrics: ["cpu.usage"],
      span: 2 as const,
    };

    layout = addWidget(layout, "a", spec);
    layout = addWidget(layout, "a", spec);

    assert.notEqual(layout.tabs[0]?.widgets[0]?.id, layout.tabs[0]?.widgets[1]?.id);
  });

  it("refuses to exceed the widgets-per-tab limit", () => {
    let layout = layoutWith({ id: "a", name: "A", widgets: [] });
    for (let index = 0; index < LAYOUT_LIMITS.maxWidgetsPerTab; index += 1) {
      layout = addWidget(layout, "a", {
        type: "line",
        title: `W${index}`,
        sourceId: "host",
        metrics: ["cpu.usage"],
        span: 1,
      });
    }
    assert.equal(layout.tabs[0]?.widgets.length, LAYOUT_LIMITS.maxWidgetsPerTab);

    const overflow = addWidget(layout, "a", {
      type: "line",
      title: "Extra",
      sourceId: "host",
      metrics: ["cpu.usage"],
      span: 1,
    });

    assert.equal(overflow, layout);
  });

  it("updates a widget", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    const next = updateWidget(layout, "a", "w1", { title: "Renamed" });

    assert.equal(next.tabs[0]?.widgets[0]?.title, "Renamed");
  });

  it("removes a widget", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1"), widget("w2")] });

    const next = removeWidget(layout, "a", "w1");

    assert.deepEqual(
      next.tabs[0]?.widgets.map((entry) => entry.id),
      ["w2"],
    );
  });

  it("ignores an unknown widget", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    assert.equal(removeWidget(layout, "a", "ghost"), layout);
  });

  it("moves a widget earlier", () => {
    const layout = layoutWith({
      id: "a",
      name: "A",
      widgets: [widget("w1"), widget("w2"), widget("w3")],
    });

    const next = moveWidget(layout, "a", "w3", -1);

    assert.deepEqual(
      next.tabs[0]?.widgets.map((entry) => entry.id),
      ["w1", "w3", "w2"],
    );
  });

  it("moves a widget later", () => {
    const layout = layoutWith({
      id: "a",
      name: "A",
      widgets: [widget("w1"), widget("w2"), widget("w3")],
    });

    const next = moveWidget(layout, "a", "w1", 1);

    assert.deepEqual(
      next.tabs[0]?.widgets.map((entry) => entry.id),
      ["w2", "w1", "w3"],
    );
  });

  it("ignores a move past either end", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1"), widget("w2")] });

    assert.equal(moveWidget(layout, "a", "w1", -1), layout);
    assert.equal(moveWidget(layout, "a", "w2", 1), layout);
  });

  it("changes the span", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    assert.equal(setWidgetSpan(layout, "a", "w1", 4).tabs[0]?.widgets[0]?.span, 4);
  });

  it("changes the chart type", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    assert.equal(setWidgetType(layout, "a", "w1", "gauge").tabs[0]?.widgets[0]?.type, "gauge");
  });

  it("drops comparison metrics for single-series chart types", () => {
    const layout = layoutWith({
      id: "a",
      name: "A",
      widgets: [
        widget("w1", {
          metrics: ["memory.usedBytes", "memory.totalBytes"],
        }),
      ],
    });

    for (const type of ["gauge", "bullet", "table"] as const) {
      const next = setWidgetType(layout, "a", "w1", type);
      assert.deepEqual(next.tabs[0]?.widgets[0]?.metrics, ["memory.usedBytes"]);
    }
  });

  it("keeps comparison metrics for line and bar charts", () => {
    const layout = layoutWith({
      id: "a",
      name: "A",
      widgets: [
        widget("w1", {
          metrics: ["memory.usedBytes", "memory.totalBytes"],
        }),
      ],
    });

    for (const type of ["line", "bar"] as const) {
      const next = setWidgetType(layout, "a", "w1", type);
      assert.deepEqual(next.tabs[0]?.widgets[0]?.metrics, [
        "memory.usedBytes",
        "memory.totalBytes",
      ]);
    }
  });

  it("replaces the metric list, dropping duplicates", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    const next = setWidgetMetrics(layout, "a", "w1", ["cpu.usage", "cpu.usage", "memory.usage"]);

    assert.deepEqual(next.tabs[0]?.widgets[0]?.metrics, ["cpu.usage", "memory.usage"]);
  });

  it("enforces the metrics-per-widget limit", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });
    const many = Array.from({ length: LAYOUT_LIMITS.maxMetricsPerWidget + 5 }, (_, i) => `m${i}`);

    const next = setWidgetMetrics(layout, "a", "w1", many);

    assert.equal(next.tabs[0]?.widgets[0]?.metrics.length, LAYOUT_LIMITS.maxMetricsPerWidget);
  });

  it("refuses to clear the metric list", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    assert.equal(setWidgetMetrics(layout, "a", "w1", []), layout);
  });

  it("selects a source, metric and display metadata together", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    const next = setWidgetMetric(layout, "a", "w1", "node-peer", "network.rxBytesPerSecond", {
      unit: "B/s",
    });
    const changed = next.tabs[0]?.widgets[0];

    assert.equal(changed?.sourceId, "node-peer");
    assert.deepEqual(changed?.metrics, ["network.rxBytesPerSecond"]);
    assert.equal(changed?.unit, "B/s");
  });

  it("removes bounds that do not belong to the new metric", () => {
    const layout = layoutWith({
      id: "a",
      name: "A",
      widgets: [widget("w1", { unit: "%", min: 0, max: 100 })],
    });

    const next = setWidgetMetric(layout, "a", "w1", "node-peer", "uptime.seconds", {
      unit: "s",
    });
    const changed = next.tabs[0]?.widgets[0];

    assert.equal(changed?.unit, "s");
    assert.equal(changed?.min, undefined);
    assert.equal(changed?.max, undefined);
  });

  it("ignores an empty metric selection", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    assert.equal(setWidgetMetric(layout, "a", "w1", "host", ""), layout);
  });
});

describe("setWidgetTitle", () => {
  it("renames a widget without changing its identity or metrics", () => {
    const layout = layoutWith({
      id: "a",
      name: "A",
      widgets: [
        widget("w1", {
          metrics: ["memory.usedBytes", "memory.totalBytes"],
        }),
      ],
    });

    const next = setWidgetTitle(layout, "a", "w1", "  Memory used vs total  ");
    const changed = next.tabs[0]?.widgets[0];

    assert.equal(changed?.title, "Memory used vs total");
    assert.equal(changed?.id, "w1");
    assert.deepEqual(changed?.metrics, ["memory.usedBytes", "memory.totalBytes"]);
  });

  it("trims and truncates the title", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    const next = setWidgetTitle(
      layout,
      "a",
      "w1",
      `  ${"x".repeat(LAYOUT_LIMITS.titleMaxLength + 20)}  `,
    );

    assert.equal(next.tabs[0]?.widgets[0]?.title?.length, LAYOUT_LIMITS.titleMaxLength);
  });

  it("ignores an empty title", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    assert.equal(setWidgetTitle(layout, "a", "w1", "   "), layout);
  });

  it("returns the same document when the title is unchanged", () => {
    const layout = layoutWith({
      id: "a",
      name: "A",
      widgets: [widget("w1", { title: "CPU" })],
    });

    assert.equal(setWidgetTitle(layout, "a", "w1", "  CPU  "), layout);
  });

  it("ignores an unknown widget", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    assert.equal(setWidgetTitle(layout, "a", "ghost", "Renamed"), layout);
  });
});

describe("mutations do not edit in place", () => {
  it("leaves the original document untouched", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });
    const snapshot = JSON.stringify(layout);

    addWidget(layout, "a", {
      type: "gauge",
      title: "New",
      sourceId: "host",
      metrics: ["memory.usage"],
      span: 1,
    });
    renameTab(layout, "a", "Changed");
    setWidgetTitle(layout, "a", "w1", "Changed");
    removeWidget(layout, "a", "w1");
    setActiveTab(layout, "a");

    assert.equal(JSON.stringify(layout), snapshot);
  });

  it("deep-copies widgets, so mutating a result cannot leak back", () => {
    const layout = layoutWith({ id: "a", name: "A", widgets: [widget("w1")] });

    const next = updateWidget(layout, "a", "w1", { title: "Changed" });
    next.tabs[0]?.widgets[0]?.metrics.push("injected");

    assert.deepEqual(layout.tabs[0]?.widgets[0]?.metrics, ["cpu.usage"]);
  });
});

describe("results stay valid", () => {
  it("survives a full round of tab and widget edits", () => {
    let layout = layoutWith({ id: "a", name: "A" });

    layout = addTab(layout, "Storage");
    layout = addWidget(layout, layout.activeTabId, {
      type: "bar",
      title: "Disks",
      sourceId: "host",
      metrics: ["storage.usedPercent"],
      span: 2,
    });
    layout = renameTab(layout, layout.activeTabId, "Storage and disks");
    layout = moveWidget(layout, layout.activeTabId, layout.tabs[1]?.widgets[0]?.id ?? "", 1);

    const result = validateLayout(layout);
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
  });

  it("emptyLayout is itself valid", () => {
    assert.equal(validateLayout(emptyLayout()).ok, true);
  });
});

describe("dataSignature", () => {
  it("is stable for identical values", () => {
    assert.equal(dataSignature([1, 2, 3], "ok"), dataSignature([1, 2, 3], "ok"));
  });

  it("changes when a value changes", () => {
    // This is what suppresses a redraw when nothing moved.
    assert.notEqual(dataSignature([1, 2, 3], "ok"), dataSignature([1, 2, 4], "ok"));
  });

  it("changes when the status changes", () => {
    assert.notEqual(dataSignature([1], "ok"), dataSignature([1], "unavailable"));
  });

  it("distinguishes null from zero", () => {
    // Conflating them would hide a gap in a chart behind a healthy-looking flat line.
    assert.notEqual(dataSignature([null], "ok"), dataSignature([0], "ok"));
  });

  it("distinguishes position, so a shifted series is not treated as unchanged", () => {
    assert.notEqual(dataSignature([1, 2], "ok"), dataSignature([2, 1], "ok"));
  });
});
