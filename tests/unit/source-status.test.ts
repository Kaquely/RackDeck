import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeOverall, describeSource, hasFailures } from "../../src/web/source-status.ts";
import type { SourceInfo } from "../../src/shared/observations.ts";

function source(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    id: "host",
    label: "This machine",
    kind: "host",
    status: "ok",
    lastSampleAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("describeSource", () => {
  it("shows a working source plainly", () => {
    const view = describeSource(source());

    assert.equal(view.label, "This machine");
    assert.equal(view.tone, "ok");
    assert.equal(view.detail, undefined);
  });

  it("shows a source that has never sampled as starting, not as a failure", () => {
    // A freshly registered source is `unavailable` with no error until its first cycle
    // finishes. Reporting that as a red failure is a false alarm.
    const view = describeSource(source({ status: "unavailable", lastSampleAt: null }));

    assert.equal(view.tone, "starting");
    assert.match(view.label, /starting/);
    assert.equal(view.detail, undefined);
  });

  it("still reports a failure when there is a reason", () => {
    const view = describeSource(
      source({ status: "unavailable", lastSampleAt: null, error: "socket not readable" }),
    );

    assert.equal(view.tone, "warn");
    assert.match(view.label, /unavailable/);
    assert.equal(view.detail, "socket not readable");
  });

  it("reports a source that failed after having worked", () => {
    const view = describeSource(
      source({ status: "unavailable", lastSampleAt: 1, error: "timed out" }),
    );

    assert.equal(view.tone, "warn");
    assert.equal(view.detail, "timed out");
  });

  it("reports a degraded source", () => {
    assert.equal(describeSource(source({ status: "degraded" })).tone, "warn");
  });

  it("marks a disabled source as intentionally off", () => {
    const view = describeSource(source({ status: "disabled", lastSampleAt: null }));

    assert.equal(view.tone, "ok");
    assert.match(view.label, /off/);
  });
});

describe("describeOverall", () => {
  it("is healthy when every source is reporting", () => {
    assert.equal(describeOverall([source(), source({ id: "docker" })]).tone, "ok");
  });

  it("is starting when nothing has failed but nothing has sampled", () => {
    const overall = describeOverall([source({ status: "unavailable", lastSampleAt: null })]);

    assert.equal(overall.tone, "starting");
    assert.equal(overall.label, "Starting");
  });

  it("is degraded as soon as one source has failed", () => {
    // A real failure outranks a source that is merely still starting.
    const overall = describeOverall([
      source({ status: "unavailable", lastSampleAt: null }),
      source({ id: "docker", status: "unavailable", lastSampleAt: 1, error: "boom" }),
    ]);

    assert.equal(overall.tone, "warn");
    assert.equal(overall.label, "Degraded");
  });

  it("is healthy with no sources at all", () => {
    assert.equal(describeOverall([]).tone, "ok");
  });

  it("ignores a deliberately disabled source", () => {
    const overall = describeOverall([source(), source({ id: "x", status: "disabled" })]);

    assert.equal(overall.tone, "ok");
  });
});

describe("hasFailures", () => {
  it("is false while a source is only starting", () => {
    assert.equal(hasFailures([source({ status: "unavailable", lastSampleAt: null })]), false);
  });

  it("is true once a source reports a reason", () => {
    assert.equal(
      hasFailures([source({ status: "unavailable", lastSampleAt: 1, error: "boom" })]),
      true,
    );
  });

  it("is false when everything is fine", () => {
    assert.equal(hasFailures([source()]), false);
  });
});
