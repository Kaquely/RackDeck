import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UpdateResponse } from "../../src/shared/api.ts";
import {
  mountUpdateBanner,
  readDismissedVersion,
  shouldShowUpdate,
  storeDismissedVersion,
  UPDATE_COMMAND,
  UPDATE_DISMISS_KEY,
} from "../../src/web/update-banner.ts";
import { registerDom } from "../helpers/dom.ts";

registerDom();

function update(overrides: Partial<UpdateResponse> = {}): UpdateResponse {
  return {
    status: "available",
    currentVersion: "0.3.0",
    latestVersion: "0.4.0",
    releaseUrl: "https://github.com/owner/repo/releases/tag/v0.4.0",
    publishedAt: "2026-10-20T12:00:00Z",
    checkedAt: "2026-10-20T12:05:00Z",
    stale: false,
    ...overrides,
  };
}

function storageWith(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
    values,
  };
}

describe("update banner", () => {
  it("is shown only for an available, undismissed release", () => {
    assert.equal(shouldShowUpdate(update(), null), true);
    assert.equal(shouldShowUpdate(update(), "0.4.0"), false);
    assert.equal(shouldShowUpdate(update(), "0.3.0"), true);

    for (const status of ["current", "unknown", "disabled"] as const) {
      assert.equal(shouldShowUpdate(update({ status }), null), false);
    }
  });

  it("renders both versions, the release link and the copied command", () => {
    const container = document.createElement("div");
    const shown = mountUpdateBanner({
      container,
      update: update(),
      dismissedVersion: null,
      storage: storageWith(),
    });

    assert.equal(shown, true);
    assert.equal(container.hidden, false);
    assert.match(container.textContent, /0\.4\.0 is available/);
    assert.match(container.textContent, /running 0\.3\.0/);
    assert.equal(container.querySelector("a")?.getAttribute("href"), update().releaseUrl);
    assert.equal(container.querySelector("a")?.getAttribute("rel"), "noopener noreferrer");
    assert.equal(container.querySelector("code")?.textContent, UPDATE_COMMAND);
    assert.equal(container.querySelector("summary")?.textContent, "How to update");
  });

  it("dismisses per offered version and stores that version", () => {
    const container = document.createElement("div");
    const storage = storageWith();
    let dismissed = false;

    mountUpdateBanner({
      container,
      update: update(),
      dismissedVersion: null,
      storage,
      onDismiss: () => {
        dismissed = true;
      },
    });

    const dismiss = container.querySelector<HTMLButtonElement>(".update-banner__dismiss");
    assert.ok(dismiss);
    assert.equal(dismiss.getAttribute("aria-label"), "Dismiss the 0.4.0 update notice");
    dismiss.click();

    assert.equal(container.hidden, true);
    assert.equal(container.childElementCount, 0);
    assert.equal(storage.values.get(UPDATE_DISMISS_KEY), "0.4.0");
    assert.equal(dismissed, true);
    assert.equal(readDismissedVersion(storage), "0.4.0");

    // A later release is not covered by the earlier dismissal.
    mountUpdateBanner({
      container,
      update: update({ latestVersion: "0.5.0" }),
      dismissedVersion: readDismissedVersion(storage),
      storage,
    });
    assert.equal(container.hidden, false);
    assert.match(container.textContent, /0\.5\.0 is available/);
  });

  it("does not render for a non-actionable status", () => {
    const container = document.createElement("div");

    const shown = mountUpdateBanner({
      container,
      update: update({ status: "current" }),
      dismissedVersion: null,
      storage: storageWith(),
    });

    assert.equal(shown, false);
    assert.equal(container.hidden, true);
    assert.equal(container.childElementCount, 0);
  });

  it("survives storage that throws", () => {
    const storage = {
      getItem(): string | null {
        throw new Error("blocked");
      },
      setItem(): void {
        throw new Error("blocked");
      },
    };

    assert.equal(readDismissedVersion(storage), null);
    assert.doesNotThrow(() => storeDismissedVersion("0.4.0", storage));
  });
});
