import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { LAYOUT_VERSION, validateLayout } from "../../src/shared/layout.ts";
import { migrateLayout } from "../../src/shared/layout-migrations.ts";

const FIXTURE = path.resolve(import.meta.dirname, "..", "fixtures", "layout-v1.json");

describe("layout migrations", () => {
  it("leaves the current version untouched", async () => {
    const document = JSON.parse(await readFile(FIXTURE, "utf8")) as unknown;

    assert.equal(LAYOUT_VERSION, 1);
    const validated = validateLayout(document);
    assert.equal(validated.ok, true);

    const result = migrateLayout(document);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.fromVersion, null, "a current document is not rewritten");
    assert.deepEqual(result.value, document);
  });

  it("fails closed for a document newer than the running code", () => {
    const result = migrateLayout({ version: 99, tabs: [], activeTabId: "" });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.fromVersion, 99);
    assert.match(result.errors.join(" "), /newer than the supported version 1/);
  });

  it("fails closed for a corrupt current document", () => {
    const result = migrateLayout({ version: 1, tabs: "not-an-array", activeTabId: "" });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors.join(" "), /tabs must be an array/);
  });
});
