import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareSemver, parseVersion } from "../../src/server/update/semver.ts";

describe("semantic version comparison", () => {
  it("compares numerically, not lexically", () => {
    assert.ok((compareSemver("0.10.0", "0.9.0") ?? 0) > 0);
    assert.ok((compareSemver("1.0.0", "0.99.99") ?? 0) > 0);
    assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  });

  it("accepts a leading v on either side", () => {
    assert.equal(compareSemver("v0.4.0", "0.4.0"), 0);
    assert.ok((compareSemver("0.4.0", "v0.3.9") ?? 0) > 0);
  });

  it("orders prereleases below the matching release", () => {
    assert.ok((compareSemver("1.0.0-rc.1", "1.0.0") ?? 0) < 0);
    assert.ok((compareSemver("1.0.0", "1.0.0-rc.1") ?? 0) > 0);
    assert.ok((compareSemver("1.0.0-rc.2", "1.0.0-rc.1") ?? 0) > 0);
  });

  it("treats numeric identifiers below alphanumeric ones", () => {
    assert.ok((compareSemver("1.0.0-1", "1.0.0-alpha") ?? 0) < 0);
  });

  it("returns null for an unparseable release tag", () => {
    assert.equal(compareSemver("nightly", "1.0.0"), null);
    assert.equal(parseVersion("1.0"), null);
    assert.equal(parseVersion("1.0.0.0"), null);
  });
});
