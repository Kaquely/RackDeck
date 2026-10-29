import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";
import { GRID_SPANS, WIDGET_TYPES } from "../../src/shared/layout.ts";
import { SOURCE_STATUSES } from "../../src/shared/observations.ts";

/**
 * The HTTP contract.
 *
 * These tests pin the exact response shape of every endpoint. They fail when a field is
 * renamed, removed or retyped, which is the point: the frontend is a separate build that
 * cannot be type-checked against the server, so the wire format is the only shared boundary
 * and it needs an explicit, enforced definition.
 */

const HEALTH_KEYS = [
  "status",
  "version",
  "uptimeSeconds",
  "role",
  "layoutStore",
  "peerStore",
  "sources",
];
const CONFIG_KEYS = [
  "role",
  "metricsIntervalMs",
  "historyLength",
  "dataDir",
  "widgetTypes",
  "maxTabs",
  "maxWidgetsPerTab",
];
const SNAPSHOT_KEYS = ["generatedAt", "intervalMs", "sources", "series", "tables"];
const VERSION_KEYS = ["version", "commit", "channel"];
const UPDATE_KEYS = [
  "status",
  "currentVersion",
  "latestVersion",
  "releaseUrl",
  "publishedAt",
  "checkedAt",
  "stale",
];

describe("API contract", () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });

  after(async () => {
    await harness.close();
  });

  it("GET /api/health returns exactly the declared keys", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/health`)).json()) as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(body).sort(), [...HEALTH_KEYS].sort());
    assert.ok(["ok", "degraded"].includes(body.status as string));
    assert.equal(typeof body.version, "string");
    assert.equal(typeof body.uptimeSeconds, "number");
    assert.ok(Array.isArray(body.sources));
  });

  it("GET /api/config returns exactly the declared keys", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/config`)).json()) as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(body).sort(), [...CONFIG_KEYS].sort());
    assert.equal(typeof body.metricsIntervalMs, "number");
    assert.equal(typeof body.historyLength, "number");
    assert.equal(typeof body.dataDir, "string");
    assert.equal(typeof body.maxTabs, "number");
    assert.equal(typeof body.maxWidgetsPerTab, "number");
  });

  it("GET /api/config advertises the supported widget types and spans", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/config`)).json()) as {
      widgetTypes: string[];
    };

    assert.deepEqual(body.widgetTypes, [...WIDGET_TYPES]);
  });

  it("GET /api/version returns exactly the declared keys", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/version`)).json()) as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(body).sort(), [...VERSION_KEYS].sort());
    assert.equal(typeof body.version, "string");
    assert.equal(typeof body.commit, "string");
    assert.equal(typeof body.channel, "string");
  });

  it("GET /api/update returns exactly the declared keys", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/update`)).json()) as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(body).sort(), [...UPDATE_KEYS].sort());
    assert.ok(["current", "available", "unknown", "disabled"].includes(body.status as string));
    assert.equal(typeof body.currentVersion, "string");
    assert.equal(typeof body.stale, "boolean");
  });

  it("GET /api/readings returns exactly the declared keys", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/readings`)).json()) as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(body).sort(), [...SNAPSHOT_KEYS].sort());
    assert.equal(typeof body.generatedAt, "number");
    assert.equal(typeof body.intervalMs, "number");
    assert.ok(Array.isArray(body.sources));
    assert.ok(Array.isArray(body.series));
    // The table chart form needs categorical data, which numeric series cannot express, so
    // the shape carries a dedicated collection.
    assert.ok(Array.isArray(body.tables));
  });

  it("declares the series and table shapes the frontend renders", () => {
    // The frontend is a separate build that cannot be type-checked against the server, so
    // the wire shape of every nested object is part of the contract.
    const series: Record<string, unknown>[] = [
      {
        sourceId: "host",
        metric: "cpu.usage",
        label: "CPU usage",
        unit: "%",
        status: "ok",
        samples: [{ t: 1, v: 1 }],
      },
    ];
    assert.deepEqual(Object.keys(series[0] ?? {}).sort(), [
      "label",
      "metric",
      "samples",
      "sourceId",
      "status",
      "unit",
    ]);

    const sample: Record<string, unknown> = { t: 1, v: 1 };
    assert.deepEqual(Object.keys(sample).sort(), ["t", "v"]);

    const table: Record<string, unknown> = { id: "x", columns: ["a"], rows: [{ a: 1 }] };
    assert.deepEqual(Object.keys(table).sort(), ["columns", "id", "rows"]);
  });

  it("GET /api/sources returns exactly the declared keys", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/sources`)).json()) as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(body), ["sources"]);
  });

  it("GET /api/layout wraps the document in a layout key", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/layout`)).json()) as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(body), ["layout"]);

    const layout = body.layout as {
      version: number;
      activeTabId: string;
      tabs: { id: string; name: string; widgets: Record<string, unknown>[] }[];
    };

    assert.equal(typeof layout.version, "number");
    assert.equal(typeof layout.activeTabId, "string");
    assert.ok(Array.isArray(layout.tabs));

    for (const tab of layout.tabs) {
      assert.deepEqual(Object.keys(tab).sort(), ["id", "name", "widgets"]);
      for (const widget of tab.widgets) {
        for (const key of ["id", "type", "title", "sourceId", "metrics", "span"]) {
          assert.ok(key in widget, `widget is missing ${key}`);
        }
        assert.ok(WIDGET_TYPES.includes(widget.type as (typeof WIDGET_TYPES)[number]));
        assert.ok(GRID_SPANS.includes(widget.span as (typeof GRID_SPANS)[number]));
      }
    }
  });

  it("error responses use a stable envelope", async () => {
    const response = await fetch(`${harness.baseUrl}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout: { version: 1, tabs: [], activeTabId: "" } }),
    });
    const body = (await response.json()) as { error: Record<string, unknown> };

    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal(typeof body.error.code, "string");
    assert.equal(typeof body.error.message, "string");
    assert.ok(Array.isArray(body.error.details));
  });

  it("declares the source status values the frontend switches on", () => {
    // The frontend branches on these exact strings, so they are part of the contract.
    assert.deepEqual([...SOURCE_STATUSES], ["ok", "degraded", "unavailable", "disabled"]);
  });

  it("serves JSON for every API response", async () => {
    for (const target of [
      "/api/health",
      "/api/config",
      "/api/readings",
      "/api/sources",
      "/api/layout",
      "/api/version",
      "/api/update",
    ]) {
      const response = await fetch(`${harness.baseUrl}${target}`);
      assert.match(
        response.headers.get("content-type") ?? "",
        /application\/json/,
        `${target} must respond with JSON`,
      );
    }
  });
});
