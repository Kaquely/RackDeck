import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { after, before, describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  PeerStoreConflictError,
  createPeerStore,
  mergeRemoteNodes,
  peerSummary,
  storedPeerToConfig,
  validatePeerDocument,
} from "../../src/server/peers/peer-store.ts";
import type { PeerDocument, StoredPeer } from "../../src/server/peers/peer-store.ts";
import type { RemoteNodeConfig } from "../../src/config/remote-nodes.ts";
import { StoreLoadError } from "../../src/store/json-document-store.ts";
import { generatePeerToken } from "../../src/shared/peer-token.ts";

const TOKEN = generatePeerToken();

function storedPeer(overrides: Partial<StoredPeer> = {}): StoredPeer {
  return {
    id: "node-lab",
    label: "Lab node",
    url: "http://192.168.0.20:3000",
    token: TOKEN,
    timeoutMs: 5_000,
    createdAt: "2026-10-20T12:00:00.000Z",
    ...overrides,
  };
}

function envPeer(overrides: Partial<RemoteNodeConfig> = {}): RemoteNodeConfig {
  return {
    id: "node-env",
    label: "Environment peer",
    url: "http://192.168.0.21:3000",
    timeoutMs: 5_000,
    token: null,
    managed: false,
    ...overrides,
  };
}

describe("peer document validation", () => {
  it("accepts an empty document", () => {
    const result = validatePeerDocument({ version: 1, peers: [] });
    assert.equal(result.ok, true);
  });

  it("accepts a well-formed stored peer", () => {
    const result = validatePeerDocument({ version: 1, peers: [storedPeer()] });
    assert.equal(result.ok, true);
  });

  it("rejects the wrong version", () => {
    const result = validatePeerDocument({ version: 2, peers: [] });
    assert.equal(result.ok, false);
  });

  it("rejects invalid fields with an explanation", () => {
    const result = validatePeerDocument({
      version: 1,
      peers: [
        storedPeer({
          id: "Bad_ID",
          label: "",
          url: "http://8.8.8.8:3000",
          token: "hlp_short",
          timeoutMs: 10,
          createdAt: "not-a-date",
        }),
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    const message = result.errors.join("; ");
    assert.match(message, /id/);
    assert.match(message, /label/);
    assert.match(message, /url/);
    assert.match(message, /token/);
    assert.match(message, /timeoutMs/);
    assert.match(message, /createdAt/);
  });

  it("rejects duplicate ids and canonical URLs", () => {
    const result = validatePeerDocument({
      version: 1,
      peers: [
        storedPeer(),
        storedPeer({ label: "Duplicate id", url: "http://192.168.0.30:3000" }),
        storedPeer({
          id: "node-other",
          label: "Duplicate URL",
          url: "http://192.168.0.20:3000/",
        }),
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors.join("; "), /duplicate peer id/);
    assert.match(result.errors.join("; "), /duplicate peer URL/);
  });
});

describe("peer store", () => {
  let directory: string;
  let filePath: string;

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-peer-store-"));
    filePath = path.join(directory, "peers.json");
  });

  after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("treats a missing file as an empty store", async () => {
    const store = createPeerStore(filePath);
    const status = await store.load();

    assert.equal(status.status, "ok");
    assert.deepEqual(store.get(), { version: 1, peers: [] });
  });

  it("round-trips a document and restricts the file mode", async () => {
    const store = createPeerStore(filePath);
    await store.load();
    await store.set({ version: 1, peers: [storedPeer()] });

    const reread = createPeerStore(filePath);
    await reread.load();
    assert.deepEqual(reread.get().peers, [storedPeer()]);

    if (process.platform !== "win32") {
      const mode = (await fs.stat(filePath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });

  it("fails startup on invalid JSON instead of silently dropping peers", async () => {
    const brokenPath = path.join(directory, "broken.json");
    await fs.writeFile(brokenPath, "{ not json", "utf8");

    const store = createPeerStore(brokenPath);
    await assert.rejects(
      () => store.load(),
      (error: unknown) => error instanceof StoreLoadError,
    );
  });

  it("fails startup on a document that violates the schema", async () => {
    const invalidPath = path.join(directory, "invalid.json");
    await fs.writeFile(
      invalidPath,
      JSON.stringify({ version: 1, peers: [storedPeer({ token: "plain" })] }),
      "utf8",
    );

    const store = createPeerStore(invalidPath);
    await assert.rejects(
      () => store.load(),
      (error: unknown) => error instanceof StoreLoadError,
    );
  });
});

describe("peer summaries and merging", () => {
  it("never projects the token into a summary", () => {
    const summary = peerSummary(storedPeerToConfig(storedPeer()));

    assert.equal(summary.hasToken, true);
    assert.equal(summary.managed, true);
    assert.equal(JSON.stringify(summary).includes(TOKEN), false);
    assert.equal("token" in summary, false);
  });

  it("merges environment and stored peers without changing their ownership", () => {
    const merged = mergeRemoteNodes([envPeer()], [storedPeer()]);

    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.managed, false);
    assert.equal(merged[1]?.managed, true);
  });

  it("rejects a duplicate id across environment and store", () => {
    assert.throws(
      () => mergeRemoteNodes([envPeer({ id: "node-lab" })], [storedPeer()]),
      PeerStoreConflictError,
    );
  });

  it("rejects a duplicate URL across environment and store", () => {
    assert.throws(
      () => mergeRemoteNodes([envPeer({ url: "http://192.168.0.20:3000/" })], [storedPeer()]),
      PeerStoreConflictError,
    );
  });
});

describe("peer document type", () => {
  it("keeps the version literal", () => {
    const document: PeerDocument = { version: 1, peers: [] };
    assert.equal(document.version, 1);
  });
});
