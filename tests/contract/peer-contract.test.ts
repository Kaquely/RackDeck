import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/environment.ts";
import { EMPTY_INTEGRATIONS } from "../../src/config/integrations.ts";
import { createRuntime } from "../../src/main.ts";
import type { Runtime } from "../../src/main.ts";
import type { RemoteNodeConfig } from "../../src/config/remote-nodes.ts";
import { generatePeerToken } from "../../src/shared/peer-token.ts";

/**
 * The peer onboarding wire contract.
 *
 * The dashboard is a separate build, so the shapes below are the only shared boundary. These
 * tests pin them and, in particular, assert that no token field ever appears in a response.
 */

const HEALTH_KEYS = [
  "status",
  "version",
  "uptimeSeconds",
  "role",
  "layoutStore",
  "peerStore",
  "sources",
];
const CONFIG_KEYS = [
  "role",
  "metricsIntervalMs",
  "historyLength",
  "dataDir",
  "widgetTypes",
  "maxTabs",
  "maxWidgetsPerTab",
];
const SNAPSHOT_KEYS = ["generatedAt", "intervalMs", "sources", "series", "tables"];
const PEER_KEYS = ["hasToken", "id", "label", "managed", "url"];

type Started = {
  runtime: Runtime;
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
};

async function listen(runtime: Runtime): Promise<Started> {
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;

  return {
    runtime,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("peer management contract", () => {
  let directory: string;
  let main: Started;
  const token = generatePeerToken();

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-peer-contract-"));
    const config = loadConfig({
      NODE_ENV: "test",
      HOMELABMD_HOST: "127.0.0.1",
      HOMELABMD_DATA_DIR: path.join(directory, "main"),
      HOMELABMD_STATIC_DIR: path.join(directory, "no-frontend-here"),
      HOMELABMD_METRICS_INTERVAL_MS: "500",
      HOMELABMD_HISTORY_LENGTH: "10",
    });

    const environmentPeer: RemoteNodeConfig = {
      id: "node-env",
      label: "Environment peer",
      url: "http://192.168.0.21:3000",
      timeoutMs: 1_000,
      token: generatePeerToken(),
      managed: false,
    };

    main = await listen(
      await createRuntime(config, EMPTY_INTEGRATIONS, [environmentPeer], {
        verifyPeer: () => Promise.resolve({ role: "peer", version: "0.0.9", id: "remote-peer" }),
      }),
    );

    const added = await fetch(`${main.baseUrl}/api/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Contract node",
        url: "http://192.168.0.71:3000",
        token,
      }),
    });
    assert.equal(added.status, 201);
  });

  after(async () => {
    await main.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("GET /api/peers returns token-free summaries with exactly the declared keys", async () => {
    const response = await fetch(`${main.baseUrl}/api/peers`);
    const payload = await json<{ peers: Record<string, unknown>[] }>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload), ["peers"]);
    assert.equal(payload.peers.length, 2);
    for (const peer of payload.peers) {
      assert.deepEqual(Object.keys(peer).sort(), PEER_KEYS);
      assert.equal(typeof peer.id, "string");
      assert.equal(typeof peer.label, "string");
      assert.equal(typeof peer.url, "string");
      assert.equal(typeof peer.managed, "boolean");
      assert.equal(typeof peer.hasToken, "boolean");
      assert.equal("token" in peer, false);
    }
    assert.equal(JSON.stringify(payload).includes(token), false);
  });

  it("POST /api/peers/verify returns exactly the peer identity", async () => {
    const response = await fetch(`${main.baseUrl}/api/peers/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://192.168.0.72:3000", token }),
    });
    const payload = await json<Record<string, unknown>>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload).sort(), ["id", "role", "version"]);
    assert.equal(payload.role, "peer");
  });

  it("POST /api/peers wraps a token-free peer summary", async () => {
    const response = await fetch(`${main.baseUrl}/api/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Second contract node",
        url: "http://192.168.0.73:3000",
        token,
      }),
    });
    const payload = await json<{ peer: Record<string, unknown> }>(response);

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(payload), ["peer"]);
    assert.deepEqual(Object.keys(payload.peer).sort(), PEER_KEYS);
    assert.equal(JSON.stringify(payload).includes(token), false);
  });

  it("peer errors use a stable envelope and do not echo the token", async () => {
    const response = await fetch(`${main.baseUrl}/api/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Duplicate",
        url: "http://192.168.0.71:3000",
        token,
      }),
    });
    const payload = await json<{ error: Record<string, unknown> }>(response);

    assert.equal(response.status, 409);
    assert.deepEqual(Object.keys(payload), ["error"]);
    assert.equal(typeof payload.error.code, "string");
    assert.equal(typeof payload.error.message, "string");
    assert.equal(JSON.stringify(payload).includes(token), false);
  });

  it("DELETE /api/peers/:id confirms removal", async () => {
    const response = await fetch(`${main.baseUrl}/api/peers/node-contract-node`, {
      method: "DELETE",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { removed: true });
  });
});

describe("peer role contract", () => {
  let directory: string;
  let peer: Started;
  const token = generatePeerToken();

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-peer-role-contract-"));
    const config = loadConfig({
      NODE_ENV: "test",
      HOMELABMD_HOST: "127.0.0.1",
      HOMELABMD_ROLE: "peer",
      HOMELABMD_PEER_TOKEN: token,
      HOMELABMD_PEER_ID: "contract-peer",
      HOMELABMD_DATA_DIR: path.join(directory, "peer"),
      HOMELABMD_STATIC_DIR: path.join(directory, "no-frontend-here"),
    });

    peer = await listen(await createRuntime(config, EMPTY_INTEGRATIONS, []));
    await peer.runtime.store.load();
  });

  after(async () => {
    await peer.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("GET /api/health is public and returns exactly the declared keys", async () => {
    const payload = await json<Record<string, unknown>>(await fetch(`${peer.baseUrl}/api/health`));

    assert.deepEqual(Object.keys(payload).sort(), [...HEALTH_KEYS].sort());
    assert.equal(payload.role, "peer");
    assert.ok(["ok", "degraded"].includes(payload.status as string));
  });

  it("GET /api/config returns exactly the declared keys", async () => {
    const response = await fetch(`${peer.baseUrl}/api/config`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = await json<Record<string, unknown>>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload).sort(), [...CONFIG_KEYS].sort());
    assert.equal(payload.role, "peer");
  });

  it("GET /api/readings returns exactly the snapshot keys", async () => {
    const response = await fetch(`${peer.baseUrl}/api/readings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = await json<Record<string, unknown>>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload).sort(), [...SNAPSHOT_KEYS].sort());
  });

  it("GET /api/peer/info returns role, version and id only", async () => {
    const response = await fetch(`${peer.baseUrl}/api/peer/info`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = await json<Record<string, unknown>>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload).sort(), ["id", "role", "version"]);
    assert.equal(payload.role, "peer");
    assert.equal(payload.id, "contract-peer");
    assert.equal(JSON.stringify(payload).includes(token), false);
  });

  it("an unauthenticated read returns the declared error envelope", async () => {
    const response = await fetch(`${peer.baseUrl}/api/readings`);
    const payload = await json<{ error: Record<string, unknown> }>(response);

    assert.equal(response.status, 401);
    assert.deepEqual(Object.keys(payload), ["error"]);
    assert.equal(payload.error.code, "unauthorized");
    assert.equal(typeof payload.error.message, "string");
    assert.equal(JSON.stringify(payload).includes(token), false);
  });
});
