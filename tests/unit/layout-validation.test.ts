import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LAYOUT_LIMITS,
  LAYOUT_VERSION,
  defaultLayout,
  isGridSpan,
  isWidgetType,
  validateLayout,
} from "../../src/shared/layout.ts";
import type { Layout } from "../../src/shared/layout.ts";

function validDocument(): Layout {
  return {
    version: LAYOUT_VERSION,
    activeTabId: "tab-a",
    tabs: [
      {
        id: "tab-a",
        name: "A",
        widgets: [
          {
            id: "w1",
            type: "line",
            title: "CPU",
            sourceId: "host",
            metrics: ["cpu.usage"],
            span: 2,
          },
        ],
      },
      { id: "tab-b", name: "B", widgets: [] },
    ],
  };
}

function mutate(change: (document: Layout) => void): unknown {
  const document = validDocument();
  change(document);
  return JSON.parse(JSON.stringify(document)) as unknown;
}

describe("validateLayout", () => {
  it("accepts a well-formed document", () => {
    const result = validateLayout(validDocument());

    assert.equal(result.ok, true);
  });

  it("accepts a document sent as plain JSON", () => {
    const result = validateLayout(JSON.parse(JSON.stringify(validDocument())) as unknown);

    assert.equal(result.ok, true);
  });

  it("rejects a non-object body", () => {
    for (const body of [null, "layout", 42, [], true]) {
      const result = validateLayout(body);
      assert.equal(result.ok, false, `expected ${JSON.stringify(body)} to be rejected`);
    }
  });

  it("rejects an unsupported widget type", () => {
    const result = validateLayout(
      mutate((document) => {
        document.tabs[0]!.widgets[0]!.type = "pie" as never;
      }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes("widgets[0].type")));
    }
  });

  it("rejects an out-of-range span", () => {
    const result = validateLayout(
      mutate((document) => {
        document.tabs[0]!.widgets[0]!.span = 7 as never;
      }),
    );

    assert.equal(result.ok, false);
  });

  it("rejects a widget with no metrics", () => {
    const result = validateLayout(
      mutate((document) => {
        document.tabs[0]!.widgets[0]!.metrics = [];
      }),
    );

    assert.equal(result.ok, false);
  });

  it("rejects an activeTabId that references no tab", () => {
    const result = validateLayout(
      mutate((document) => {
        document.activeTabId = "missing";
      }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes("activeTabId")));
    }
  });

  it("rejects duplicate tab ids", () => {
    const result = validateLayout(
      mutate((document) => {
        document.tabs[1]!.id = "tab-a";
        document.activeTabId = "tab-a";
      }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes("duplicate tab id")));
    }
  });

  it("rejects duplicate widget ids within a tab", () => {
    const result = validateLayout(
      mutate((document) => {
        document.tabs[0]!.widgets.push({ ...document.tabs[0]!.widgets[0]! });
      }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes("duplicate widget id")));
    }
  });

  it("rejects an empty tab list", () => {
    const result = validateLayout({ version: LAYOUT_VERSION, activeTabId: "x", tabs: [] });

    assert.equal(result.ok, false);
  });

  it("rejects a version other than the supported one", () => {
    const result = validateLayout({ ...validDocument(), version: 99 });

    assert.equal(result.ok, false);
  });

  it("enforces the tab limit", () => {
    const tabs = Array.from({ length: LAYOUT_LIMITS.maxTabs + 1 }, (_, index) => ({
      id: `tab-${index}`,
      name: `Tab ${index}`,
      widgets: [],
    }));

    const result = validateLayout({
      version: LAYOUT_VERSION,
      activeTabId: "tab-0",
      tabs,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes("at most")));
    }
  });

  it("enforces the widgets-per-tab limit", () => {
    const base = validDocument().tabs[0]!.widgets[0]!;
    const widgets = Array.from({ length: LAYOUT_LIMITS.maxWidgetsPerTab + 1 }, (_, index) => ({
      ...base,
      id: `w-${index}`,
    }));

    const result = validateLayout({
      version: LAYOUT_VERSION,
      activeTabId: "tab-a",
      tabs: [{ id: "tab-a", name: "A", widgets }],
    });

    assert.equal(result.ok, false);
  });

  it("enforces the metrics-per-widget limit", () => {
    const result = validateLayout(
      mutate((document) => {
        document.tabs[0]!.widgets[0]!.metrics = Array.from(
          { length: LAYOUT_LIMITS.maxMetricsPerWidget + 1 },
          (_, index) => `metric.${index}`,
        );
      }),
    );

    assert.equal(result.ok, false);
  });

  it("enforces the identifier length limit", () => {
    const result = validateLayout(
      mutate((document) => {
        document.tabs[0]!.id = "t".repeat(LAYOUT_LIMITS.idMaxLength + 1);
      }),
    );

    assert.equal(result.ok, false);
  });

  it("rejects a non-finite bound", () => {
    for (const bound of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateLayout(
        mutate((document) => {
          document.tabs[0]!.widgets[0]!.max = bound;
        }),
      );
      assert.equal(result.ok, false, `expected ${String(bound)} to be rejected`);
    }
  });

  it("rejects min greater than or equal to max", () => {
    const result = validateLayout(
      mutate((document) => {
        document.tabs[0]!.widgets[0]!.min = 100;
        document.tabs[0]!.widgets[0]!.max = 100;
      }),
    );

    assert.equal(result.ok, false);
  });

  it("drops unknown properties instead of persisting them", () => {
    const polluted = mutate((document) => {
      (document.tabs[0]!.widgets[0] as unknown as Record<string, unknown>).injected = "value";
    });

    const result = validateLayout(polluted);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal("injected" in (result.value.tabs[0]!.widgets[0] as object), false);
    }
  });
});

describe("defaultLayout", () => {
  it("is itself valid", () => {
    const result = validateLayout(defaultLayout());

    assert.equal(result.ok, true);
  });

  it("references an existing active tab", () => {
    const layout = defaultLayout();

    assert.ok(layout.tabs.some((tab) => tab.id === layout.activeTabId));
  });

  it("uses only supported widget types", () => {
    for (const tab of defaultLayout().tabs) {
      for (const widget of tab.widgets) {
        assert.ok(isWidgetType(widget.type), `unsupported type ${widget.type}`);
        assert.ok(isGridSpan(widget.span));
      }
    }
  });
});
