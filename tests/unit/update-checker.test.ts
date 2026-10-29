import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUpdateChecker } from "../../src/server/update/update-checker.ts";
import type { UpdateCheckerOptions } from "../../src/server/update/update-checker.ts";

const RELEASE = {
  tag_name: "v0.4.0",
  html_url: "https://github.com/owner/repo/releases/tag/v0.4.0",
  published_at: "2026-10-20T12:00:00Z",
  prerelease: false,
  draft: false,
};

function checker(overrides: Partial<UpdateCheckerOptions> = {}) {
  return createUpdateChecker({
    currentVersion: "0.3.0",
    repository: "owner/repo",
    enabled: true,
    intervalMs: 6_000,
    channel: "stable",
    ...overrides,
  });
}

describe("update checker", () => {
  it("reports disabled without making a request", async () => {
    let calls = 0;
    const update = checker({
      enabled: false,
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response("{}"));
      },
    });

    await update.checkNow();

    assert.equal(calls, 0);
    assert.equal(update.view().status, "disabled");
    assert.equal(update.view().latestVersion, null);
  });

  it("reports available when the latest release is newer", async () => {
    const update = checker({
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(RELEASE))),
      now: () => 1_700_000_000_000,
    });

    await update.checkNow();
    const view = update.view();

    assert.equal(view.status, "available");
    assert.equal(view.currentVersion, "0.3.0");
    assert.equal(view.latestVersion, "0.4.0");
    assert.equal(view.releaseUrl, RELEASE.html_url);
    assert.equal(view.publishedAt, RELEASE.published_at);
    assert.equal(view.checkedAt, new Date(1_700_000_000_000).toISOString());
    assert.equal(view.stale, false);
    assert.equal("tag_name" in view, false, "the raw upstream payload must not leak");
  });

  it("reports current when the running version is the latest", async () => {
    const update = checker({
      currentVersion: "0.4.0",
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(RELEASE))),
    });

    await update.checkNow();

    assert.equal(update.view().status, "current");
  });

  it("stays unknown when GitHub is unreachable", async () => {
    const update = checker({
      fetchImpl: () => Promise.reject(new Error("offline")),
    });

    await update.checkNow();

    assert.equal(update.view().status, "unknown");
    assert.equal(update.view().latestVersion, null);
  });

  it("keeps the last good answer when a later check fails", async () => {
    let calls = 0;
    const update = checker({
      fetchImpl: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(new Response(JSON.stringify(RELEASE)));
        return Promise.reject(new Error("rate limited"));
      },
    });

    await update.checkNow();
    await update.checkNow();

    assert.equal(update.view().status, "available");
    assert.equal(update.view().latestVersion, "0.4.0");
  });

  it("uses an ETag and refreshes the checked time on 304", async () => {
    let calls = 0;
    const requestHeaders: Record<string, string>[] = [];
    let now = 1_700_000_000_000;

    const update = checker({
      now: () => now,
      fetchImpl: (_url, init) => {
        calls += 1;
        requestHeaders.push((init?.headers ?? {}) as Record<string, string>);
        if (calls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify(RELEASE), { headers: { etag: '"release-etag"' } }),
          );
        }
        return Promise.resolve(new Response(null, { status: 304 }));
      },
    });

    await update.checkNow();
    const firstCheckedAt = update.view().checkedAt;

    now += 60_000;
    await update.checkNow();

    assert.equal(requestHeaders[1]?.["If-None-Match"], '"release-etag"');
    assert.notEqual(update.view().checkedAt, firstCheckedAt);
    assert.equal(update.view().latestVersion, "0.4.0");
  });

  it("marks a cached answer stale after the freshness window", async () => {
    const update = checker({
      now: () => 1_700_000_000_000,
      staleAfterMs: 1_000,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(RELEASE))),
    });

    await update.checkNow();
    assert.equal(update.view().stale, false);

    let laterNow = 1_700_000_000_000;
    const later = checker({
      now: () => laterNow,
      staleAfterMs: 1_000,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(RELEASE))),
    });
    await later.checkNow();
    laterNow += 10_000;
    assert.equal(later.view().stale, true);
  });

  it("rejects an oversized response without failing the process", async () => {
    const update = checker({
      maxResponseBytes: 20,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(RELEASE))),
    });

    await update.checkNow();

    assert.equal(update.view().status, "unknown");
  });

  it("selects a prerelease from the releases list when requested", async () => {
    const prerelease = { ...RELEASE, tag_name: "v0.5.0-rc.1", prerelease: true };
    const update = checker({
      channel: "prerelease",
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify([prerelease, RELEASE]))),
    });

    await update.checkNow();

    assert.equal(update.view().latestVersion, "0.5.0-rc.1");
    assert.equal(update.view().status, "available");
  });

  it("ignores a draft or a prerelease on the stable channel", async () => {
    const update = checker({
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ ...RELEASE, tag_name: "v0.5.0-rc.1", prerelease: true })),
        ),
    });

    await update.checkNow();

    assert.equal(update.view().status, "unknown");
  });

  it("never surfaces a non-GitHub release URL", async () => {
    const update = checker({
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ ...RELEASE, html_url: "http://evil.example/release" })),
        ),
    });

    await update.checkNow();

    assert.equal(update.view().releaseUrl, null);
  });
});
