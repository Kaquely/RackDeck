import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_REMOTE_NODES, loadRemoteNodes } from "../../src/config/remote-nodes.ts";
import { ConfigurationError } from "../../src/config/environment.ts";

describe("loadRemoteNodes", () => {
  it("configures nothing when no URLs are set", () => {
    assert.deepEqual(loadRemoteNodes({}), EMPTY_REMOTE_NODES);
  });

  it("treats a blank URL list as disabled", () => {
    assert.deepEqual(loadRemoteNodes({ HOMELABMD_REMOTE_NODE_URLS: "   " }), EMPTY_REMOTE_NODES);
  });

  it("creates a node from a single URL", () => {
    const [node] = loadRemoteNodes({ HOMELABMD_REMOTE_NODE_URLS: "http://node-a.lan:3000" });

    assert.equal(node?.id, "node-node-a-lan");
    assert.equal(node?.url, "http://node-a.lan:3000");
    assert.equal(node?.timeoutMs, 5_000);
    assert.equal(node?.label, "node-a.lan");
  });

  it("uses supplied labels in parallel with URLs", () => {
    const nodes = loadRemoteNodes({
      HOMELABMD_REMOTE_NODE_URLS: "http://a.lan:3000,http://b.lan:3000",
      HOMELABMD_REMOTE_NODE_LABELS: "Living room,Office",
    });

    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]?.id, "node-living-room");
    assert.equal(nodes[0]?.label, "Living room");
    assert.equal(nodes[1]?.id, "node-office");
  });

  it("rejects mismatched label counts", () => {
    assert.throws(
      () =>
        loadRemoteNodes({
          HOMELABMD_REMOTE_NODE_URLS: "http://a.lan:3000,http://b.lan:3000",
          HOMELABMD_REMOTE_NODE_LABELS: "Only one",
        }),
      (error: unknown) => error instanceof ConfigurationError,
    );
  });

  it("rejects an invalid URL", () => {
    assert.throws(
      () => loadRemoteNodes({ HOMELABMD_REMOTE_NODE_URLS: "not-a-url" }),
      (error: unknown) => error instanceof ConfigurationError,
    );
  });

  it("rejects duplicate identities", () => {
    assert.throws(
      () =>
        loadRemoteNodes({
          HOMELABMD_REMOTE_NODE_URLS: "http://a.lan:3000,http://b.lan:3000",
          HOMELABMD_REMOTE_NODE_LABELS: "Same,Same",
        }),
      (error: unknown) => error instanceof ConfigurationError,
    );
  });

  it("reads timeout from the environment", () => {
    const [node] = loadRemoteNodes({
      HOMELABMD_REMOTE_NODE_URLS: "http://a.lan:3000",
      HOMELABMD_REMOTE_NODE_TIMEOUT_MS: "1200",
    });

    assert.equal(node?.timeoutMs, 1_200);
  });
});
