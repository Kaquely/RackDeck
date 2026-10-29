import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JsonDocumentStore, StoreUnavailableError } from "../../src/store/json-document-store.ts";
import type { DocumentMigration } from "../../src/store/document-migrations.ts";
import { migrateDocument } from "../../src/store/document-migrations.ts";

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
    return { version: 2, names: typeof record.name === "string" ? [record.name] : [] };
  },
};

function migrator(input: unknown) {
  return migrateDocument(input, {
    currentVersion: 2,
    migrations: [v1ToV2],
    validate: validateV2,
  });
}

function newStore(filePath: string, migrate = migrator): JsonDocumentStore<DocumentV2> {
  return new JsonDocumentStore<DocumentV2>({
    filePath,
    fallback: () => ({ version: 2, names: [] }),
    validate: validateV2,
    migrate,
  });
}

describe("JsonDocumentStore migrations", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "homelabmd-migrate-"));
    filePath = path.join(directory, "layout.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("migrates an older document, writes the current version and keeps a backup", async () => {
    const original = JSON.stringify({ version: 1, name: "kept" });
    await writeFile(filePath, original, "utf8");

    const store = newStore(filePath);
    const status = await store.load();

    assert.equal(status.status, "ok");
    assert.deepEqual(store.get(), { version: 2, names: ["kept"] });

    const written = JSON.parse(await readFile(filePath, "utf8")) as DocumentV2;
    assert.deepEqual(written, { version: 2, names: ["kept"] });

    const backups = (await readdir(directory)).filter((name) => name.includes(".pre-v1-"));
    assert.equal(backups.length, 1, "expected exactly one pre-migration backup");
    assert.equal(await readFile(path.join(directory, backups[0] as string), "utf8"), original);
  });

  it("does not rewrite or back up a document already at the current version", async () => {
    const original = JSON.stringify({ version: 2, names: ["current"] });
    await writeFile(filePath, original, "utf8");

    const store = newStore(filePath);
    const status = await store.load();

    assert.equal(status.status, "ok");
    assert.equal(await readFile(filePath, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["layout.json"]);
  });

  it("leaves the readable document unchanged when migration fails", async () => {
    const original = JSON.stringify({ version: 0, name: "unsupported" });
    await writeFile(filePath, original, "utf8");

    const store = newStore(filePath);
    const status = await store.load();

    assert.equal(status.status, "degraded");
    assert.match(status.error ?? "", /could not be migrated/);
    assert.match(status.error ?? "", /left unchanged/);
    assert.equal(await readFile(filePath, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["layout.json"]);

    // The default layout must not be served as if it were the operator's document.
    assert.throws(() => store.get(), StoreUnavailableError);
    await assert.rejects(store.set({ version: 2, names: [] }), StoreUnavailableError);
    assert.equal(await readFile(filePath, "utf8"), original);
  });

  it("leaves the readable document unchanged when the migrated document is invalid", async () => {
    const original = JSON.stringify({ version: 1, name: "kept" });
    await writeFile(filePath, original, "utf8");

    const store = newStore(filePath, (input) =>
      migrateDocument(input, {
        currentVersion: 2,
        migrations: [{ from: 1, to: 2, migrate: () => ({ version: 2, names: "nope" }) }],
        validate: validateV2,
      }),
    );
    const status = await store.load();

    assert.equal(status.status, "degraded");
    assert.match(status.error ?? "", /failed validation/);
    assert.equal(await readFile(filePath, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["layout.json"]);
  });
});
