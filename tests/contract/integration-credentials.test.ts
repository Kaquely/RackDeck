import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config/environment.ts";
import { loadIntegrations } from "../../src/config/integrations.ts";
import { createRuntime } from "../../src/main.ts";
import { startHarness } from "../helpers/harness.ts";

/**
 * The integration must not become a way to leak a credential.
 *
 * `publicConfig` is an allow-list, so no field added to `IntegrationConfig` can reach a
 * response by default — but "by default" is a claim about the code, and a claim about the code
 * is worth less than a test that drives the real application with an integration configured and
 * reads every endpoint an operator or a browser can reach.
 */

const PASSWORD = "pi-hole-application-password-do-not-log";

const ENDPOINTS = [
  "/api/health",
  "/api/readings",
  "/api/config",
  "/api/layout",
  "/api/sources",
] as const;

describe("integration credentials over HTTP", () => {
  it("appear in no response the dashboard serves", async () => {
    const harness = await startHarness({
      HOMELABMD_PIHOLE_URL: "http://pihole.invalid:8080",
      HOMELABMD_PIHOLE_PASSWORD: PASSWORD,
    });

    try {
      for (const endpoint of ENDPOINTS) {
        const response = await fetch(`${harness.baseUrl}${endpoint}`);
        const body = await response.text();

        assert.ok(
          !body.includes(PASSWORD),
          `${endpoint} disclosed the credential: ${body.slice(0, 200)}`,
        );
        assert.ok(
          !/PIHOLE|HOMELABMD_/i.test(body),
          `${endpoint} named an integration variable: ${body.slice(0, 200)}`,
        );
      }
    } finally {
      await harness.close();
    }
  });

  it("are limited to the allow-listed configuration keys", async () => {
    const harness = await startHarness({
      HOMELABMD_PIHOLE_URL: "http://pihole.invalid:8080",
      HOMELABMD_PIHOLE_PASSWORD: PASSWORD,
    });

    try {
      const response = await fetch(`${harness.baseUrl}/api/config`);
      const body = (await response.json()) as Record<string, unknown>;

      // The allow-list is the mechanism, so the exact key set is the assertion. Adding an
      // integration field to Config cannot reach a response unless someone edits this list.
      // The endpoint also publishes the layout limits, which the client needs to validate a
      // saved layout. The point of the assertion is the exact set: a new key cannot appear here
      // without someone editing the allow-list and noticing this test fail.
      assert.deepEqual(Object.keys(body).sort(), [
        "dataDir",
        "historyLength",
        "maxTabs",
        "maxWidgetsPerTab",
        "metricsIntervalMs",
        "role",
        "widgetTypes",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("are not reachable through an error response", async () => {
    const harness = await startHarness({
      HOMELABMD_PIHOLE_URL: "http://pihole.invalid:8080",
      HOMELABMD_PIHOLE_PASSWORD: PASSWORD,
    });

    try {
      // A 404 and a rejected method both produce error bodies; neither may echo configuration.
      const notFound = await fetch(`${harness.baseUrl}/api/nothing-here`);
      const notAllowed = await fetch(`${harness.baseUrl}/api/readings`, { method: "POST" });

      for (const response of [notFound, notAllowed]) {
        const body = await response.text();
        assert.ok(!body.includes(PASSWORD), "an error body disclosed the credential");
      }
    } finally {
      await harness.close();
    }
  });

  it("are absent from the public configuration document by allow-list", async () => {
    const integrations = loadIntegrations({
      HOMELABMD_PIHOLE_URL: "http://pihole.lan:8080",
      HOMELABMD_PIHOLE_PASSWORD: PASSWORD,
    });
    const config = loadConfig({ NODE_ENV: "test" });

    const runtime = await createRuntime(config, integrations);

    // The source is deliberately visible — the operator needs to see it and its error. The
    // credential is not.
    assert.deepEqual(
      runtime.listSources().map((source) => source.id),
      ["host", "pihole"],
    );
    assert.ok(!JSON.stringify(runtime.snapshot()).includes(PASSWORD));
    assert.ok(!JSON.stringify(runtime.config).includes(PASSWORD));
  });
});

describe("an unconfigured integration changes nothing", () => {
  it("produces exactly the collector set the product had before", () => {
    const integrations = loadIntegrations({});
    assert.deepEqual(integrations, { pihole: null });
  });

  it("does not appear as a source", async () => {
    const integrations = loadIntegrations({});
    const runtime = await createRuntime(loadConfig({ NODE_ENV: "test" }), integrations);

    await runtime.scheduler.runOnce();
    const sources = runtime.listSources();

    assert.deepEqual(
      sources.map((source) => source.id),
      ["host"],
    );
  });
});

describe("a configured integration registers a source", () => {
  it("appears with a label and a kind, and reports unavailable when unreachable", async () => {
    // Port 1 is reserved; nothing listens there, so the source must be honestly unavailable
    // rather than absent, which is the difference between "not configured" and "broken".
    const fake: Server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.destroy();
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const runtime = await createRuntime(loadConfig({ NODE_ENV: "test" }), {
      pihole: {
        url: `http://127.0.0.1:${address.port}`,
        password: null,
        timeoutMs: 500,
        topN: 5,
        tablesIntervalMs: 10_000,
        label: "Pi-hole",
      },
    });

    try {
      await runtime.scheduler.runOnce();
      const pihole = runtime.listSources().find((source) => source.id === "pihole");

      assert.ok(pihole !== undefined, "the integration did not register a source");
      assert.equal(pihole.label, "Pi-hole");
      assert.equal(pihole.kind, "pihole");
      assert.equal(pihole.status, "unavailable");
      assert.ok(pihole.error !== undefined && pihole.error.length > 0);

      // The host source must be unaffected: one broken integration cannot blank the dashboard.
      const host = runtime.listSources().find((source) => source.id === "host");
      assert.ok(host !== undefined);
      assert.notEqual(host.status, "unavailable");
    } finally {
      await new Promise<void>((resolve) => {
        fake.closeAllConnections();
        fake.close(() => resolve());
      });
    }
  });
});
