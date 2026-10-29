import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_INTEGRATIONS, loadIntegrations } from "../../src/config/integrations.ts";
import { ConfigurationError, publicConfig } from "../../src/config/environment.ts";

const PASSWORD = "correct-horse-battery-staple";

describe("loadIntegrations", () => {
  it("configures nothing when no endpoint is set", () => {
    assert.deepEqual(loadIntegrations({}), EMPTY_INTEGRATIONS);
    assert.equal(loadIntegrations({}).pihole, null);
  });

  it("treats a blank endpoint as not configured", () => {
    // An operator who leaves the line empty in .env means "off", not "misconfigured".
    assert.equal(loadIntegrations({ HOMELABMD_PIHOLE_URL: "   " }).pihole, null);
  });

  it("enables the integration when a URL is set", () => {
    const config = loadIntegrations({ HOMELABMD_PIHOLE_URL: "http://pihole.lan:8080" });

    assert.equal(config.pihole?.url, "http://pihole.lan:8080");
  });

  it("defaults the options sensibly", () => {
    const config = loadIntegrations({ HOMELABMD_PIHOLE_URL: "http://pihole.lan:8080" });

    assert.equal(config.pihole?.timeoutMs, 5_000);
    assert.equal(config.pihole?.topN, 10);
    // Much slower than the 500 ms cadence, on purpose: the dashboard shares a node with the
    // DNS server it is watching.
    assert.equal(config.pihole?.tablesIntervalMs, 10_000);
    assert.equal(config.pihole?.label, "Pi-hole");
  });

  it("reads every option from the environment", () => {
    const config = loadIntegrations({
      HOMELABMD_PIHOLE_URL: "https://pi.hole",
      HOMELABMD_PIHOLE_PASSWORD: PASSWORD,
      HOMELABMD_PIHOLE_TIMEOUT_MS: "1500",
      HOMELABMD_PIHOLE_TOP_N: "25",
      HOMELABMD_PIHOLE_TABLES_INTERVAL_MS: "30000",
      HOMELABMD_PIHOLE_LABEL: "DNS filter",
    });

    assert.equal(config.pihole?.url, "https://pi.hole");
    assert.equal(config.pihole?.password, PASSWORD);
    assert.equal(config.pihole?.timeoutMs, 1_500);
    assert.equal(config.pihole?.topN, 25);
    assert.equal(config.pihole?.tablesIntervalMs, 30_000);
    assert.equal(config.pihole?.label, "DNS filter");
  });

  it("treats a blank password as absent", () => {
    const config = loadIntegrations({
      HOMELABMD_PIHOLE_URL: "http://pihole.lan:8080",
      HOMELABMD_PIHOLE_PASSWORD: "",
    });

    assert.equal(config.pihole?.password, null);
  });

  it("supports a Pi-hole with authentication disabled", () => {
    const config = loadIntegrations({ HOMELABMD_PIHOLE_URL: "http://pihole.lan:8080" });

    assert.equal(config.pihole?.password, null);
  });

  it("trims surrounding whitespace from a password", () => {
    const config = loadIntegrations({
      HOMELABMD_PIHOLE_URL: "http://pihole.lan:8080",
      HOMELABMD_PIHOLE_PASSWORD: `  ${PASSWORD}  `,
    });

    assert.equal(config.pihole?.password, PASSWORD);
  });

  describe("rejects invalid configuration by naming the variable", () => {
    const expectError = (env: Record<string, string>, variable: string) => {
      assert.throws(
        () => loadIntegrations(env),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError, `expected ConfigurationError`);
          assert.equal(error.variable, variable);
          assert.ok(error.message.includes(variable), "message should name the variable");
          return true;
        },
      );
    };

    it("rejects a URL that is not absolute", () => {
      expectError({ HOMELABMD_PIHOLE_URL: "pihole.lan:8080" }, "HOMELABMD_PIHOLE_URL");
    });

    it("rejects a non-http scheme", () => {
      expectError({ HOMELABMD_PIHOLE_URL: "file:///etc/passwd" }, "HOMELABMD_PIHOLE_URL");
    });

    it("rejects a non-integer timeout", () => {
      expectError(
        { HOMELABMD_PIHOLE_URL: "http://pi.hole", HOMELABMD_PIHOLE_TIMEOUT_MS: "5s" },
        "HOMELABMD_PIHOLE_TIMEOUT_MS",
      );
    });

    it("rejects a timeout below the floor", () => {
      // Below ~100 ms every request would fail against a real network hop, which looks like an
      // unreachable Pi-hole rather than a typo.
      expectError(
        { HOMELABMD_PIHOLE_URL: "http://pi.hole", HOMELABMD_PIHOLE_TIMEOUT_MS: "10" },
        "HOMELABMD_PIHOLE_TIMEOUT_MS",
      );
    });

    it("rejects a top-N of zero", () => {
      expectError(
        { HOMELABMD_PIHOLE_URL: "http://pi.hole", HOMELABMD_PIHOLE_TOP_N: "0" },
        "HOMELABMD_PIHOLE_TOP_N",
      );
    });

    it("rejects an empty label", () => {
      expectError(
        { HOMELABMD_PIHOLE_URL: "http://pi.hole", HOMELABMD_PIHOLE_LABEL: " " },
        "HOMELABMD_PIHOLE_LABEL",
      );
    });

    it("never puts the password in a configuration error", () => {
      try {
        loadIntegrations({
          HOMELABMD_PIHOLE_URL: "not-a-url",
          HOMELABMD_PIHOLE_PASSWORD: PASSWORD,
        });
        assert.fail("should have thrown");
      } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        assert.ok(!error.message.includes(PASSWORD));
      }
    });
  });
});

describe("the public configuration excludes credentials", () => {
  it("carries no integration field at all", () => {
    // The allow-list is the mechanism: adding a field to IntegrationConfig cannot leak it,
    // because nothing here projects from it.
    const exposed = publicConfig({
      nodeEnv: "production",
      host: "0.0.0.0",
      port: 3000,
      metricsIntervalMs: 500,
      historyLength: 600,
      dataDir: "/data",
      layoutFile: "/data/layout.json",
      peersFile: "/data/peers.json",
      staticDir: "/app/dist/web",
      jsonBodyLimit: "256kb",
      role: "main",
      peerToken: null,
      peerAllowedIps: null,
      peerId: null,
      updateCheck: "github",
      updateCheckIntervalMs: 21_600_000,
      updateChannel: "stable",
      updateRepository: "owner/repo",
    });

    assert.deepEqual(Object.keys(exposed).sort(), [
      "dataDir",
      "historyLength",
      "metricsIntervalMs",
    ]);
  });

  it("does not expose the URL, the label or the password", () => {
    const exposed = JSON.stringify(
      publicConfig({
        nodeEnv: "production",
        host: "0.0.0.0",
        port: 3000,
        metricsIntervalMs: 500,
        historyLength: 600,
        dataDir: "/data",
        layoutFile: "/data/layout.json",
        peersFile: "/data/peers.json",
        staticDir: "/app/dist/web",
        jsonBodyLimit: "256kb",
        role: "main",
        peerToken: null,
        peerAllowedIps: null,
        peerId: null,
        updateCheck: "github",
        updateCheckIntervalMs: 21_600_000,
        updateChannel: "stable",
        updateRepository: "owner/repo",
      }),
    );

    assert.ok(!exposed.includes("pihole"), "the public configuration names an integration");
    assert.ok(!exposed.toLowerCase().includes("password"));
  });
});
