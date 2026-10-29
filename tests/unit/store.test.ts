import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JsonDocumentStore, StoreValidationError } from "../../src/store/json-document-store.ts";
import { defaultLayout, validateLayout } from "../../src/shared/layout.ts";
import type { Layout } from "../../src/shared/layout.ts";

function newStore(filePath: string): JsonDocumentStore<Layout> {
  return new JsonDocumentStore<Layout>({
    filePath,
    fallback: defaultLayout,
    validate: validateLayout,
  });
}

describe("JsonDocumentStore", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "homelabmd-store-"));
    filePath = path.join(directory, "layout.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("serves the fallback when no document exists yet", async () => {
    const store = newStore(filePath);

    const status = await store.load();

    assert.equal(status.status, "ok");
    assert.equal(store.get().tabs.length, defaultLayout().tabs.length);
  });

  it("round-trips a document through disk", async () => {
    const store = newStore(filePath);
    await store.load();

    const document = defaultLayout();
    document.tabs[0]!.name = "Renamed";
    await store.set(document);

    const reopened = newStore(filePath);
    await reopened.load();

    assert.equal(reopened.get().tabs[0]!.name, "Renamed");
  });

  it("writes valid JSON with a trailing newline", async () => {
    const store = newStore(filePath);
    await store.load();
    await store.set(defaultLayout());

    const raw = await readFile(filePath, "utf8");

    assert.ok(raw.endsWith("\n"), "expected a trailing newline");
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it("leaves no temporary file behind after a successful write", async () => {
    const store = newStore(filePath);
    await store.load();
    await store.set(defaultLayout());

    const entries = await readdir(directory);

    assert.deepEqual(entries, ["layout.json"]);
  });

  it("creates the data directory when it does not exist", async () => {
    const nested = path.join(directory, "deep", "nested", "layout.json");
    const store = newStore(nested);
    await store.load();

    await store.set(defaultLayout());

    const raw = await readFile(nested, "utf8");
    assert.ok(raw.length > 0);
  });

  it("degrades to the fallback when the file is not valid JSON", async () => {
    await writeFile(filePath, "{ this is not json", "utf8");
    const store = newStore(filePath);

    const status = await store.load();

    assert.equal(status.status, "degraded");
    assert.match(status.error ?? "", /not valid JSON/);
    assert.equal(store.get().tabs.length, defaultLayout().tabs.length);
  });

  it("degrades to the fallback when the document fails validation", async () => {
    await writeFile(filePath, JSON.stringify({ version: 99, tabs: [] }), "utf8");
    const store = newStore(filePath);

    const status = await store.load();

    assert.equal(status.status, "degraded");
    assert.match(status.error ?? "", /failed validation/);
  });

  it("does not persist a document that fails validation", async () => {
    const store = newStore(filePath);
    await store.load();
    await store.set(defaultLayout());
    const before = await readFile(filePath, "utf8");

    await assert.rejects(
      // This object is structurally a valid `Layout` as far as the compiler is concerned:
      // an empty `tabs` array type-checks. The rule "at least one tab" cannot be expressed
      // in the type, so the runtime validator is the only guard. That is precisely why the
      // store validates on write instead of trusting its caller.
      () => store.set({ version: 1, tabs: [], activeTabId: "" }),
      StoreValidationError,
    );

    assert.equal(await readFile(filePath, "utf8"), before, "file must be untouched");
  });

  it("keeps serving after a rejected write", async () => {
    const store = newStore(filePath);
    await store.load();
    await store.set(defaultLayout());

    await assert.rejects(() => store.set({} as unknown as Layout), StoreValidationError);

    // A failed write must not poison the serialisation queue.
    const next = defaultLayout();
    next.activeTabId = next.tabs[1]!.id;
    await store.set(next);

    assert.equal(store.get().activeTabId, next.tabs[1]!.id);
    assert.equal(store.status().status, "ok");
  });

  it("serialises concurrent writes so the last one wins intact", async () => {
    const store = newStore(filePath);
    await store.load();

    const first = defaultLayout();
    first.tabs[0]!.name = "first";
    const second = defaultLayout();
    second.tabs[0]!.name = "second";

    await Promise.all([store.set(first), store.set(second)]);

    // Whichever write ran last, the file must be a complete, parseable document.
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = validateLayout(parsed);

    assert.equal(result.ok, true);
    const entries = await readdir(directory);
    assert.deepEqual(entries, ["layout.json"], "no temp file may survive concurrent writes");
  });

  it("hands out copies so callers cannot mutate the stored document", async () => {
    const store = newStore(filePath);
    await store.load();

    const snapshot = store.get();
    snapshot.tabs[0]!.name = "mutated outside";

    assert.notEqual(store.get().tabs[0]!.name, "mutated outside");
  });
});
