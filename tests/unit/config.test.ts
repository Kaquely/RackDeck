import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ConfigurationError, loadConfig, publicConfig } from "../../src/config/environment.ts";

/** Fixed base so expectations are platform independent. */
const CWD = path.resolve(path.sep, "srv", "app");

const at = (...segments: string[]): string => path.resolve(CWD, ...segments);

describe("loadConfig", () => {
  it("applies documented defaults when the environment is empty", () => {
    const config = loadConfig({}, CWD);

    assert.equal(config.nodeEnv, "production");
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 3000);
    assert.equal(config.metricsIntervalMs, 500);
    assert.equal(config.historyLength, 600);
    assert.equal(config.dataDir, at("data"));
    assert.equal(config.layoutFile, at("data", "layout.json"));
    assert.equal(config.staticDir, at("dist", "web"));
  });

  it("resolves relative paths against the supplied working directory", () => {
    const config = loadConfig({ HOMELABMD_DATA_DIR: "var/homelab" }, CWD);

    assert.equal(config.dataDir, at("var", "homelab"));
    assert.equal(config.layoutFile, at("var", "homelab", "layout.json"));
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig(
      {
        PORT: "8080",
        HOMELABMD_HOST: "127.0.0.1",
        HOMELABMD_METRICS_INTERVAL_MS: "1000",
        HOMELABMD_HISTORY_LENGTH: "120",
        NODE_ENV: "test",
      },
      CWD,
    );

    assert.equal(config.port, 8080);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.metricsIntervalMs, 1000);
    assert.equal(config.historyLength, 120);
    assert.equal(config.nodeEnv, "test");
  });

  it("fails with the variable name when a numeric value is not a number", () => {
    assert.throws(
      () => loadConfig({ HOMELABMD_METRICS_INTERVAL_MS: "fast" }, CWD),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.variable, "HOMELABMD_METRICS_INTERVAL_MS");
        assert.match(error.message, /HOMELABMD_METRICS_INTERVAL_MS/);
        return true;
      },
    );
  });

  it("rejects values that Number() would accept but that are never intended", () => {
    // Number("") and Number("0x10") are both valid numbers, so a naive parse would silently
    // accept them and produce a wrong interval.
    for (const raw of ["", " ", "0x10", "1e3", "500ms"]) {
      assert.throws(
        () => loadConfig({ HOMELABMD_METRICS_INTERVAL_MS: raw }, CWD),
        ConfigurationError,
        `expected ${JSON.stringify(raw)} to be rejected`,
      );
    }
  });

  it("rejects a numeric value outside its bounds", () => {
    assert.throws(
      () => loadConfig({ HOMELABMD_METRICS_INTERVAL_MS: "0" }, CWD),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /between 100 and 60000/);
        return true;
      },
    );
  });

  it("rejects an out-of-range port", () => {
    assert.throws(() => loadConfig({ PORT: "70000" }, CWD), ConfigurationError);
  });

  it("rejects an unknown NODE_ENV", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "staging" }, CWD),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.variable, "NODE_ENV");
        return true;
      },
    );
  });

  it("rejects an empty string where a value is required", () => {
    assert.throws(() => loadConfig({ HOMELABMD_HOST: "   " }, CWD), ConfigurationError);
  });

  it("rejects a layout file name containing a directory component", () => {
    // Without this check a hostile or mistaken value could write outside the data directory.
    assert.throws(
      () => loadConfig({ HOMELABMD_LAYOUT_FILE: "../escape.json" }, CWD),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.variable, "HOMELABMD_LAYOUT_FILE");
        return true;
      },
    );
  });

  it("accepts an absolute data directory", () => {
    const absolute = at("elsewhere");
    const config = loadConfig({ HOMELABMD_DATA_DIR: absolute }, CWD);

    assert.equal(config.dataDir, absolute);
    assert.equal(config.layoutFile, path.join(absolute, "layout.json"));
  });

  it("defaults to the public release check configured for this repository", () => {
    const config = loadConfig({}, CWD);

    assert.equal(config.updateCheck, "github");
    assert.equal(config.updateCheckIntervalMs, 21_600_000);
    assert.equal(config.updateChannel, "stable");
    assert.equal(config.updateRepository, "Kaquely/RackDeck");
  });

  it("accepts an explicit update configuration", () => {
    const config = loadConfig(
      {
        HOMELABMD_UPDATE_CHECK: "off",
        HOMELABMD_UPDATE_CHECK_INTERVAL_MS: "60000",
        HOMELABMD_UPDATE_CHANNEL: "prerelease",
        HOMELABMD_UPDATE_REPOSITORY: "owner/another-repo",
      },
      CWD,
    );

    assert.equal(config.updateCheck, "off");
    assert.equal(config.updateCheckIntervalMs, 60_000);
    assert.equal(config.updateChannel, "prerelease");
    assert.equal(config.updateRepository, "owner/another-repo");
  });

  it("rejects an invalid update mode, interval, channel or repository", () => {
    for (const [variable, value] of [
      ["HOMELABMD_UPDATE_CHECK", "yes"],
      ["HOMELABMD_UPDATE_CHECK_INTERVAL_MS", "10"],
      ["HOMELABMD_UPDATE_CHANNEL", "nightly"],
      ["HOMELABMD_UPDATE_REPOSITORY", "not-a-repository"],
    ] as const) {
      assert.throws(
        () => loadConfig({ [variable]: value }, CWD),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.equal(error.variable, variable);
          return true;
        },
        `${variable}=${value} must be rejected`,
      );
    }
  });
});

describe("publicConfig", () => {
  it("exposes only allow-listed settings", () => {
    const config = loadConfig({ HOMELABMD_HOST: "10.0.0.5" }, CWD);
    const exposed = publicConfig(config);

    assert.deepEqual(Object.keys(exposed).sort(), [
      "dataDir",
      "historyLength",
      "metricsIntervalMs",
    ]);
    // The bind address describes the host's own exposure and is not part of the contract.
    assert.equal("host" in exposed, false);
  });
});
