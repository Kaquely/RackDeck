import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMode,
  DISPLAY_MODE_KEY,
  isDisplayMode,
  nextMode,
  readMode,
  storeMode,
} from "../../src/web/display-mode.ts";
import { registerDom } from "../helpers/dom.ts";

registerDom();

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

describe("display mode", () => {
  it("toggles between edit and view", () => {
    assert.equal(nextMode("edit"), "view");
    assert.equal(nextMode("view"), "edit");
  });

  it("accepts only the two defined modes", () => {
    assert.equal(isDisplayMode("edit"), true);
    assert.equal(isDisplayMode("view"), true);
    assert.equal(isDisplayMode("EDIT"), false);
    assert.equal(isDisplayMode(null), false);
  });

  it("starts in edit mode when nothing is stored", () => {
    assert.equal(readMode(storageWith()), "edit");
  });

  it("restores a stored view mode", () => {
    assert.equal(readMode(storageWith({ [DISPLAY_MODE_KEY]: "view" })), "view");
  });

  it("falls back to edit for an unknown stored value", () => {
    assert.equal(readMode(storageWith({ [DISPLAY_MODE_KEY]: "compact" })), "edit");
  });

  it("falls back to edit when storage throws", () => {
    const storage = {
      getItem(): string | null {
        throw new Error("storage is blocked");
      },
    };

    assert.equal(readMode(storage), "edit");
  });

  it("stores the selected mode under the dedicated key", () => {
    const storage = storageWith();

    storeMode("view", storage);

    assert.equal(storage.values.get(DISPLAY_MODE_KEY), "view");
  });

  it("does not throw when storage cannot be written", () => {
    const storage = {
      setItem(): void {
        throw new Error("quota exceeded");
      },
    };

    assert.doesNotThrow(() => storeMode("view", storage));
  });

  it("applies the edit mode to the app and the button", () => {
    const app = document.createElement("div");
    const button = document.createElement("button");

    applyMode(app, button, "edit");

    assert.equal(app.dataset.mode, "edit");
    assert.equal(button.textContent, "View");
    assert.equal(button.getAttribute("aria-label"), "Switch to view mode");
    assert.equal(button.title, "Switch to view mode");
  });

  it("applies the view mode to the app and the button", () => {
    const app = document.createElement("div");
    const button = document.createElement("button");

    applyMode(app, button, "view");

    assert.equal(app.dataset.mode, "view");
    assert.equal(button.textContent, "Edit");
    assert.equal(button.getAttribute("aria-label"), "Switch to edit mode");
    assert.equal(button.title, "Switch to edit mode");
  });

  it("uses an action label rather than a contradicting pressed state", () => {
    const app = document.createElement("div");
    const button = document.createElement("button");

    applyMode(app, button, "view");

    assert.equal(button.hasAttribute("aria-pressed"), false);
  });
});
