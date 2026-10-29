import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateDocument } from "../../src/store/document-migrations.ts";
import type { DocumentMigration } from "../../src/store/document-migrations.ts";

type DocumentV2 = { version: 2; names: string[] };

function validateV2(
  input: unknown,
): { ok: true; value: DocumentV2 } | { ok: false; errors: string[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["document must be an object"] };
  }
  const record = input as Record<string, unknown>;
  if (record.version !== 2) return { ok: false, errors: ["version must be 2"] };
  if (!Array.isArray(record.names) || record.names.some((name) => typeof name !== "string")) {
    return { ok: false, errors: ["names must be an array of strings"] };
  }
  return { ok: true, value: { version: 2, names: record.names as string[] } };
}

const v1ToV2: DocumentMigration = {
  from: 1,
  to: 2,
  migrate: (input) => {
    const record = input as { name?: unknown };
    return {
      version: 2,
      names: typeof record.name === "string" ? [record.name] : [],
    };
  },
};

describe("document migrations", () => {
  it("applies ordered migrations to reach the current version", () => {
    const result = migrateDocument(
      { version: 1, name: "first" },
      { currentVersion: 2, migrations: [v1ToV2], validate: validateV2 },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, { version: 2, names: ["first"] });
    assert.equal(result.fromVersion, 1);
  });

  it("validates a current document without migrating it", () => {
    const result = migrateDocument(
      { version: 2, names: ["already"] },
      { currentVersion: 2, migrations: [v1ToV2], validate: validateV2 },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.fromVersion, null);
  });

  it("fails when no migration path exists", () => {
    const result = migrateDocument(
      { version: 0, name: "old" },
      { currentVersion: 2, migrations: [v1ToV2], validate: validateV2 },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.fromVersion, 0);
    assert.match(result.errors.join(" "), /no migration from version 0/);
  });

  it("fails on a document newer than the code", () => {
    const result = migrateDocument(
      { version: 3, names: [] },
      { currentVersion: 2, migrations: [v1ToV2], validate: validateV2 },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors.join(" "), /newer than the supported version 2/);
  });

  it("fails when a migration throws", () => {
    const result = migrateDocument(
      { version: 1, name: "first" },
      {
        currentVersion: 2,
        migrations: [
          {
            from: 1,
            to: 2,
            migrate: () => {
              throw new Error("boom");
            },
          },
        ],
        validate: validateV2,
      },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors.join(" "), /migration from version 1 failed: boom/);
  });

  it("fails when the migrated document does not validate", () => {
    const result = migrateDocument(
      { version: 1, name: 42 },
      { currentVersion: 2, migrations: [v1ToV2], validate: validateV2 },
    );

    assert.equal(result.ok, true, "names is empty and still valid");

    const invalid = migrateDocument(
      { version: 1 },
      {
        currentVersion: 2,
        migrations: [{ from: 1, to: 2, migrate: () => ({ version: 2, names: "nope" }) }],
        validate: validateV2,
      },
    );
    assert.equal(invalid.ok, false);
    if (invalid.ok) return;
    assert.match(invalid.errors.join(" "), /failed validation/);
  });
});
