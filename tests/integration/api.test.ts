import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";
import { defaultLayout } from "../../src/shared/layout.ts";
import type { Layout } from "../../src/shared/layout.ts";

describe("HTTP API", () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });

  after(async () => {
    await harness.close();
  });

  describe("GET /api/health", () => {
    it("responds 200 with version and a positive uptime", async () => {
      const response = await fetch(`${harness.baseUrl}/api/health`);
      const body = (await response.json()) as {
        status: string;
        version: string;
        uptimeSeconds: number;
        layoutStore: { status: string };
        sources: unknown[];
      };

      assert.equal(response.status, 200);
      assert.equal(body.status, "ok");
      assert.ok(body.version.length > 0);
      assert.ok(body.uptimeSeconds >= 0);
      assert.equal(body.layoutStore.status, "ok");
      assert.deepEqual(body.sources, []);
    });

    it("answers even when no data source is registered", async () => {
      // The health endpoint must stay a valid probe when every source is unreachable, which
      // is why it reads held state instead of performing I/O.
      const response = await fetch(`${harness.baseUrl}/api/health`);

      assert.equal(response.status, 200);
    });
  });

  describe("GET /api/config", () => {
    it("exposes only non-sensitive settings", async () => {
      const response = await fetch(`${harness.baseUrl}/api/config`);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.metricsIntervalMs, 500);
      assert.equal(body.historyLength, 600);
      assert.equal("host" in body, false);
      assert.equal("port" in body, false);
      assert.equal("layoutFile" in body, false);
    });
  });

  describe("GET /api/version", () => {
    it("reports the running version, revision and channel without host details", async () => {
      const response = await fetch(`${harness.baseUrl}/api/version`);
      const body = (await response.json()) as {
        version: string;
        commit: string;
        channel: string;
      };

      assert.equal(response.status, 200);
      assert.match(body.version, /^\d+\.\d+\.\d+/);
      assert.equal(typeof body.commit, "string");
      assert.equal(typeof body.channel, "string");
      assert.equal("dataDir" in body, false);
      assert.equal("host" in body, false);
    });

    it("rejects a mutating method", async () => {
      const response = await fetch(`${harness.baseUrl}/api/version`, { method: "POST" });

      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    });
  });

  describe("GET /api/update", () => {
    it("reports disabled when no checker is configured", async () => {
      const response = await fetch(`${harness.baseUrl}/api/update`);
      const body = (await response.json()) as { status: string; currentVersion: string };

      assert.equal(response.status, 200);
      assert.equal(body.status, "disabled");
      assert.equal(typeof body.currentVersion, "string");
    });

    it("rejects a mutating method", async () => {
      const response = await fetch(`${harness.baseUrl}/api/update`, { method: "POST" });

      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    });
  });

  describe("GET /api/readings", () => {
    it("returns the current snapshot", async () => {
      const response = await fetch(`${harness.baseUrl}/api/readings`);
      const body = (await response.json()) as {
        generatedAt: number;
        intervalMs: number;
        sources: unknown[];
        series: unknown[];
      };

      assert.equal(response.status, 200);
      assert.equal(body.intervalMs, 500);
      assert.ok(Array.isArray(body.series));
    });
  });

  describe("read-only guarantee", () => {
    it("rejects every mutating method on observed data with 405 and an Allow header", async () => {
      for (const target of ["/api/readings", "/api/sources"]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          const response = await fetch(`${harness.baseUrl}${target}`, {
            method,
            headers: { "content-type": "application/json" },
            body: method === "DELETE" ? undefined : JSON.stringify({ probe: true }),
          });

          assert.equal(response.status, 405, `${method} ${target} must be rejected`);
          assert.equal(response.headers.get("allow"), "GET, HEAD");
        }
      }
    });

    it("rejects mutating methods on the layout except PUT", async () => {
      for (const method of ["POST", "PATCH", "DELETE"]) {
        const response = await fetch(`${harness.baseUrl}/api/layout`, {
          method,
          headers: { "content-type": "application/json" },
          body: method === "DELETE" ? undefined : JSON.stringify({ probe: true }),
        });

        assert.equal(response.status, 405, `${method} /api/layout must be rejected`);
        assert.equal(response.headers.get("allow"), "GET, HEAD, PUT");
      }
    });

    it("does not expose the framework fingerprint", async () => {
      const response = await fetch(`${harness.baseUrl}/api/health`);

      assert.equal(response.headers.get("x-powered-by"), null);
    });
  });

  describe("layout resource", () => {
    it("returns the default layout when nothing is stored", async () => {
      const response = await fetch(`${harness.baseUrl}/api/layout`);
      const body = (await response.json()) as { layout: Layout };

      assert.equal(response.status, 200);
      assert.equal(body.layout.tabs.length, defaultLayout().tabs.length);
    });

    it("persists a valid layout and returns the stored document", async () => {
      const document = defaultLayout();
      document.tabs[0]!.name = "Integration";

      const response = await fetch(`${harness.baseUrl}/api/layout`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: document }),
      });
      const body = (await response.json()) as { layout: Layout };

      assert.equal(response.status, 200);
      assert.equal(body.layout.tabs[0]!.name, "Integration");

      const reread = await fetch(`${harness.baseUrl}/api/layout`);
      const rereadBody = (await reread.json()) as { layout: Layout };
      assert.equal(rereadBody.layout.tabs[0]!.name, "Integration");
    });

    it("accepts a bare layout document as well as a wrapped one", async () => {
      const document = defaultLayout();
      document.tabs[0]!.name = "Bare";

      const response = await fetch(`${harness.baseUrl}/api/layout`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(document),
      });

      assert.equal(response.status, 200);
    });

    it("rejects an invalid layout with 400 and field-level detail", async () => {
      const response = await fetch(`${harness.baseUrl}/api/layout`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          layout: { version: 1, activeTabId: "nope", tabs: [{ id: "a", name: "A", widgets: [] }] },
        }),
      });
      const body = (await response.json()) as { error: { code: string; details: string[] } };

      assert.equal(response.status, 400);
      assert.equal(body.error.code, "invalid_layout");
      assert.ok(body.error.details.length > 0);
    });

    it("leaves the stored layout untouched when a write is rejected", async () => {
      const before = await (await fetch(`${harness.baseUrl}/api/layout`)).json();

      await fetch(`${harness.baseUrl}/api/layout`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: { version: 1, activeTabId: "x", tabs: "not-an-array" } }),
      });

      const after = await (await fetch(`${harness.baseUrl}/api/layout`)).json();
      assert.deepEqual(after, before);
    });

    it("writes the document to disk under the configured data directory", async () => {
      const raw = await readFile(path.join(harness.dataDir, "layout.json"), "utf8");
      const parsed = JSON.parse(raw) as Layout;

      assert.equal(parsed.version, 1);
      assert.ok(parsed.tabs.length > 0);
    });

    it("rejects a malformed JSON body with 400", async () => {
      const response = await fetch(`${harness.baseUrl}/api/layout`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      });

      assert.equal(response.status, 400);
    });
  });

  describe("unknown routes", () => {
    it("returns a JSON 404 for an unknown API path", async () => {
      // Must not fall through to the SPA fallback, which would answer 200 with HTML.
      const response = await fetch(`${harness.baseUrl}/api/does-not-exist`);
      const body = (await response.json()) as { error: { code: string } };

      assert.equal(response.status, 404);
      assert.equal(body.error.code, "not_found");
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    });

    it("explains that the frontend is not built instead of returning a bare 404", async () => {
      const response = await fetch(`${harness.baseUrl}/`);
      const text = await response.text();

      assert.equal(response.status, 503);
      assert.match(text, /npm run build/);
    });
  });
});
