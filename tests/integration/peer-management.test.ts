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
import type { PeerInfoResponse } from "../../src/shared/api.ts";
import { generatePeerToken } from "../../src/shared/peer-token.ts";
import { isAllowedPeerAddress } from "../../src/config/peer-url.ts";
import { StoreLoadError } from "../../src/store/json-document-store.ts";

/**
 * Main-node peer management.
 *
 * The tests use the real peer manager, store and routing; only the outbound verification is
 * replaced, so no test depends on a second process or on the host's DNS.
 */

const ENV_TOKEN = generatePeerToken();
const ADD_TOKEN = generatePeerToken();
const BAD_TOKEN = `hlp_${"b".repeat(43)}`;

type Started = {
  runtime: Runtime;
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
};

async function listenRuntime(runtime: Runtime, host = "127.0.0.1"): Promise<Started> {
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, host, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  const connectHost = host === "0.0.0.0" ? "127.0.0.1" : host;

  return {
    runtime,
    server,
    baseUrl: `http://${connectHost}:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function start(
  dataDir: string,
  environmentPeers: RemoteNodeConfig[],
  verifyPeer?: (url: string, token: string) => Promise<PeerInfoResponse>,
): Promise<Started> {
  const config = loadConfig({
    NODE_ENV: "test",
    HOMELABMD_HOST: "127.0.0.1",
    HOMELABMD_DATA_DIR: dataDir,
    HOMELABMD_STATIC_DIR: path.join(dataDir, "no-frontend-here"),
    HOMELABMD_METRICS_INTERVAL_MS: "500",
    HOMELABMD_HISTORY_LENGTH: "10",
  });

  const runtime = await createRuntime(config, EMPTY_INTEGRATIONS, environmentPeers, {
    ...(verifyPeer === undefined ? {} : { verifyPeer }),
  });

  return listenRuntime(runtime);
}

function envPeer(overrides: Partial<RemoteNodeConfig> = {}): RemoteNodeConfig {
  return {
    id: "node-env",
    label: "Environment peer",
    url: "http://192.168.0.21:3000",
    timeoutMs: 1_000,
    token: ENV_TOKEN,
    managed: false,
    ...overrides,
  };
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A non-loopback IPv4 the real address policy accepts, so the live test can use the production
 * resolver instead of a seam. CI hosts without a private interface skip the test.
 */
function privateLanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isAllowedPeerAddress(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

const LAN_ADDRESS = privateLanAddress();
const LIVE_SKIP =
  LAN_ADDRESS === null ? "no private IPv4 address is available for a live peer" : false;

describe("main peer management", () => {
  let directory: string;
  let started: Started;
  let verifyCalls: { url: string; token: string }[];

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-peer-main-"));
    verifyCalls = [];
    started = await start(path.join(directory, "main"), [envPeer()], (url, token) => {
      verifyCalls.push({ url, token });
      if (token === BAD_TOKEN) {
        return Promise.reject(new Error("the peer rejected the token"));
      }
      if (url.includes("192.168.0.99")) {
        return Promise.reject(new Error("connect ECONNREFUSED 192.168.0.99:3000"));
      }
      return Promise.resolve({ role: "peer", version: "0.0.9", id: "remote-peer" });
    });
  });

  after(async () => {
    await started.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("lists environment peers without exposing their token", async () => {
    const response = await fetch(`${started.baseUrl}/api/peers`);
    const payload = await body<{ peers: Record<string, unknown>[] }>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload), ["peers"]);
    assert.equal(payload.peers.length, 1);
    assert.deepEqual(Object.keys(payload.peers[0] ?? {}).sort(), [
      "hasToken",
      "id",
      "label",
      "managed",
      "url",
    ]);
    assert.equal(payload.peers[0]?.id, "node-env");
    assert.equal(payload.peers[0]?.managed, false);
    assert.equal(payload.peers[0]?.hasToken, true);
    assert.equal(JSON.stringify(payload).includes(ENV_TOKEN), false);
  });

  it("verifies a candidate without saving it", async () => {
    const response = await fetch(`${started.baseUrl}/api/peers/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://192.168.0.20:3000", token: ADD_TOKEN }),
    });
    const payload = await body<Record<string, unknown>>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload).sort(), ["id", "role", "version"]);
    assert.equal(payload.role, "peer");
    assert.equal(payload.id, "remote-peer");

    const list = await body<{ peers: unknown[] }>(await fetch(`${started.baseUrl}/api/peers`));
    assert.equal(list.peers.length, 1);
  });

  it("reports a wrong token as a verification failure without echoing it", async () => {
    const callsBefore = verifyCalls.length;
    const response = await fetch(`${started.baseUrl}/api/peers/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://192.168.0.30:3000", token: BAD_TOKEN }),
    });
    const text = await response.text();

    assert.equal(response.status, 502);
    assert.match(text, /could not be verified|rejected/i);
    assert.equal(text.includes(BAD_TOKEN), false);
    assert.equal(verifyCalls.length, callsBefore + 1);
  });

  it("reports an unreachable candidate as a verification failure", async () => {
    const callsBefore = verifyCalls.length;
    const response = await fetch(`${started.baseUrl}/api/peers/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://192.168.0.99:3000", token: ADD_TOKEN }),
    });
    const text = await response.text();

    assert.equal(response.status, 502);
    assert.match(text, /could not be verified/i);
    assert.equal(text.includes("192.168.0.99"), false);
    assert.equal(verifyCalls.length, callsBefore + 1);
  });

  it("adds a verified peer, persists it and registers its source", async () => {
    const response = await fetch(`${started.baseUrl}/api/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Lab node",
        url: "http://192.168.0.20:3000",
        token: ADD_TOKEN,
      }),
    });
    const payload = await body<{ peer: Record<string, unknown> }>(response);

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(payload), ["peer"]);
    assert.equal(payload.peer.id, "node-lab-node");
    assert.equal(payload.peer.managed, true);
    assert.equal(payload.peer.hasToken, true);
    assert.equal(JSON.stringify(payload).includes(ADD_TOKEN), false);

    const list = await body<{ peers: { id: string }[] }>(
      await fetch(`${started.baseUrl}/api/peers`),
    );
    assert.deepEqual(
      list.peers.map((peer) => peer.id),
      ["node-env", "node-lab-node"],
    );

    const sources = await body<{ sources: { id: string }[] }>(
      await fetch(`${started.baseUrl}/api/sources`),
    );
    assert.ok(sources.sources.some((source) => source.id === "node-lab-node"));

    const health = await body<{ peerStore: { status: string } }>(
      await fetch(`${started.baseUrl}/api/health`),
    );
    assert.equal(health.peerStore.status, "ok");

    const document = JSON.parse(
      await fs.readFile(path.join(directory, "main", "peers.json"), "utf8"),
    ) as { peers: { id: string }[] };
    assert.deepEqual(
      document.peers.map((peer) => peer.id),
      ["node-lab-node"],
    );

    if (process.platform !== "win32") {
      const mode = (await fs.stat(path.join(directory, "main", "peers.json"))).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });

  it("refuses a duplicate peer URL before verifying it", async () => {
    const before = verifyCalls.length;
    const response = await fetch(`${started.baseUrl}/api/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Duplicate",
        url: "http://192.168.0.20:3000/",
        token: ADD_TOKEN,
      }),
    });
    const payload = await body<{ error: { code: string; message: string } }>(response);

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "peer_conflict");
    assert.equal(verifyCalls.length, before);
  });

  it("keeps the store unchanged when verification fails", async () => {
    const peersFile = path.join(directory, "main", "peers.json");
    const storedBefore = await fs.readFile(peersFile, "utf8");

    const response = await fetch(`${started.baseUrl}/api/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Rejected node",
        url: "http://192.168.0.30:3000",
        token: BAD_TOKEN,
      }),
    });
    const payload = await body<{ error: { code: string; message: string } }>(response);

    assert.equal(response.status, 502);
    assert.equal(payload.error.code, "peer_verification_failed");
    assert.equal(await fs.readFile(peersFile, "utf8"), storedBefore);

    const list = await body<{ peers: unknown[] }>(await fetch(`${started.baseUrl}/api/peers`));
    assert.equal(list.peers.length, 2);
  });

  it("refuses to remove an environment peer", async () => {
    const response = await fetch(`${started.baseUrl}/api/peers/node-env`, { method: "DELETE" });
    const payload = await body<{ error: { code: string } }>(response);

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "peer_conflict");
  });

  it("returns 404 for an unknown peer and 400 for invalid input", async () => {
    const unknown = await fetch(`${started.baseUrl}/api/peers/node-ghost`, { method: "DELETE" });
    assert.equal(unknown.status, 404);

    for (const input of [
      { url: "http://192.168.0.40:3000", token: ADD_TOKEN },
      { label: "No token", url: "http://192.168.0.40:3000", token: "plain" },
      { label: "", url: "http://192.168.0.40:3000", token: ADD_TOKEN },
      { label: "Public", url: "http://8.8.8.8:3000", token: ADD_TOKEN },
    ]) {
      const response = await fetch(`${started.baseUrl}/api/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 400, JSON.stringify(input));
      assert.equal((await body<{ error: { code: string } }>(response)).error.code, "invalid_peer");
    }
  });

  it("removes a stored peer and unregisters its source", async () => {
    const response = await fetch(`${started.baseUrl}/api/peers/node-lab-node`, {
      method: "DELETE",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), { removed: true });

    const list = await body<{ peers: { id: string }[] }>(
      await fetch(`${started.baseUrl}/api/peers`),
    );
    assert.deepEqual(
      list.peers.map((peer) => peer.id),
      ["node-env"],
    );

    const sources = await body<{ sources: { id: string }[] }>(
      await fetch(`${started.baseUrl}/api/sources`),
    );
    assert.equal(
      sources.sources.some((source) => source.id === "node-lab-node"),
      false,
    );
  });

  it("pins the peer-management method matrix", async () => {
    const patch = await fetch(`${started.baseUrl}/api/peers`, { method: "PATCH" });
    assert.equal(patch.status, 405);
    assert.equal(patch.headers.get("allow"), "GET, HEAD, POST");

    const getVerify = await fetch(`${started.baseUrl}/api/peers/verify`);
    assert.equal(getVerify.status, 405);
    assert.equal(getVerify.headers.get("allow"), "POST");

    const postRecord = await fetch(`${started.baseUrl}/api/peers/node-env`, { method: "POST" });
    assert.equal(postRecord.status, 405);
    assert.equal(postRecord.headers.get("allow"), "DELETE");
  });

  it("does not mount the peer information endpoint on a main node", async () => {
    const response = await fetch(`${started.baseUrl}/api/peer/info`);
    assert.equal(response.status, 404);
  });
});

describe("peer persistence across restart", () => {
  let directory: string;

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-peer-restart-"));
  });

  after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("reloads a stored peer and its source without an environment entry", async () => {
    const dataDir = path.join(directory, "data");
    const verify = (): Promise<PeerInfoResponse> =>
      Promise.resolve({ role: "peer", version: "0.0.9", id: "remote-peer" });

    const first = await start(dataDir, [], verify);
    const added = await fetch(`${first.baseUrl}/api/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Restart node",
        url: "http://192.168.0.50:3000",
        token: ADD_TOKEN,
      }),
    });
    assert.equal(added.status, 201);
    await first.close();

    const second = await start(dataDir, [], verify);
    try {
      const list = await body<{ peers: { id: string; managed: boolean }[] }>(
        await fetch(`${second.baseUrl}/api/peers`),
      );
      assert.deepEqual(
        list.peers.map((peer) => peer.id),
        ["node-restart-node"],
      );
      assert.equal(list.peers[0]?.managed, true);

      const stored = second.runtime.peerManager?.peers()[0];
      assert.equal(stored?.token, ADD_TOKEN);
      assert.ok(second.runtime.listSources().some((source) => source.id === "node-restart-node"));
    } finally {
      await second.close();
    }
  });
});

describe("peer startup validation", () => {
  let directory: string;

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-peer-startup-"));
  });

  after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  function configFor(dataDir: string) {
    return loadConfig({
      NODE_ENV: "test",
      HOMELABMD_HOST: "127.0.0.1",
      HOMELABMD_DATA_DIR: dataDir,
      HOMELABMD_STATIC_DIR: path.join(dataDir, "no-frontend-here"),
    });
  }

  function storedDocument(id: string, url: string) {
    return {
      version: 1,
      peers: [
        {
          id,
          label: "Stored peer",
          url,
          token: ADD_TOKEN,
          timeoutMs: 5_000,
          createdAt: "2026-10-20T12:00:00.000Z",
        },
      ],
    };
  }

  it("fails startup on a corrupt peer document", async () => {
    const dataDir = path.join(directory, "corrupt");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "peers.json"), "{ not json", "utf8");

    await assert.rejects(
      () =>
        createRuntime(configFor(dataDir), EMPTY_INTEGRATIONS, [], {
          verifyPeer: () => Promise.reject(new Error("unused")),
        }),
      (error: unknown) => error instanceof StoreLoadError,
    );
  });

  it("fails startup when a stored peer duplicates an environment id", async () => {
    const dataDir = path.join(directory, "duplicate-id");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "peers.json"),
      JSON.stringify(storedDocument("node-env", "http://192.168.0.60:3000")),
      "utf8",
    );

    await assert.rejects(
      () =>
        createRuntime(configFor(dataDir), EMPTY_INTEGRATIONS, [envPeer()], {
          verifyPeer: () => Promise.reject(new Error("unused")),
        }),
      /peer id .* configured more than once/,
    );
  });

  it("fails startup when a stored peer duplicates an environment URL", async () => {
    const dataDir = path.join(directory, "duplicate-url");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "peers.json"),
      JSON.stringify(storedDocument("node-stored", "http://192.168.0.21:3000/")),
      "utf8",
    );

    await assert.rejects(
      () =>
        createRuntime(configFor(dataDir), EMPTY_INTEGRATIONS, [envPeer()], {
          verifyPeer: () => Promise.reject(new Error("unused")),
        }),
      /peer URL .* configured more than once/,
    );
  });
});

describe("live main and peer pair", () => {
  let directory: string;
  let peer: Started | undefined;
  let main: Started | undefined;
  let peerUrl = "";
  const token = generatePeerToken();

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-peer-live-"));
    if (LAN_ADDRESS === null) return;

    const peerConfig = loadConfig({
      NODE_ENV: "test",
      HOMELABMD_HOST: "0.0.0.0",
      HOMELABMD_ROLE: "peer",
      HOMELABMD_PEER_TOKEN: token,
      HOMELABMD_PEER_ID: "peer-live",
      HOMELABMD_DATA_DIR: path.join(directory, "peer"),
      HOMELABMD_STATIC_DIR: path.join(directory, "no-frontend-here"),
      HOMELABMD_METRICS_INTERVAL_MS: "100",
      HOMELABMD_HISTORY_LENGTH: "10",
    });
    const peerRuntime = await createRuntime(peerConfig, EMPTY_INTEGRATIONS, []);
    await peerRuntime.store.load();
    peer = await listenRuntime(peerRuntime, "0.0.0.0");
    const port = (peer.server.address() as AddressInfo).port;
    peerUrl = `http://${LAN_ADDRESS}:${port}`;
    peerRuntime.scheduler.start();
    // The whole integration suite runs in parallel on a shared CI runner. The first host
    // sample is fast in isolation, but a five-second budget makes this test depend on the
    // other suites' load rather than on the peer's behaviour.
    await waitFor(
      () =>
        peerRuntime.listSources().some((source) => source.id === "host" && source.status === "ok"),
      "the peer never collected its first host sample",
      15_000,
    );

    const mainConfig = loadConfig({
      NODE_ENV: "test",
      HOMELABMD_HOST: "127.0.0.1",
      HOMELABMD_DATA_DIR: path.join(directory, "main"),
      HOMELABMD_STATIC_DIR: path.join(directory, "no-frontend-here"),
      HOMELABMD_METRICS_INTERVAL_MS: "100",
      HOMELABMD_HISTORY_LENGTH: "10",
    });
    // No policy seam: the main uses the production resolver and the production store validator.
    const mainRuntime = await createRuntime(mainConfig, EMPTY_INTEGRATIONS, []);
    await mainRuntime.store.load();
    main = await listenRuntime(mainRuntime);
  });

  after(async () => {
    main?.runtime.scheduler.stop();
    peer?.runtime.scheduler.stop();
    if (main !== undefined) await main.close();
    if (peer !== undefined) await peer.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("rejects an unauthenticated read and accepts the token", { skip: LIVE_SKIP }, async () => {
    assert.ok(peer !== undefined);
    assert.notEqual(peerUrl, "");

    const unauthorised = await fetch(`${peerUrl}/api/readings`);
    assert.equal(unauthorised.status, 401);

    const authorised = await fetch(`${peerUrl}/api/readings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(authorised.status, 200);
  });

  it(
    "adds the live peer through the API and starts collecting without a restart",
    { skip: LIVE_SKIP },
    async () => {
      assert.ok(main !== undefined);
      assert.ok(peer !== undefined);
      assert.notEqual(peerUrl, "");

      const added = await fetch(`${main.baseUrl}/api/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Live peer", url: peerUrl, token }),
      });
      const addedText = await added.text();
      assert.equal(added.status, 201, addedText);
      const payload = JSON.parse(addedText) as { peer: { id: string } };
      assert.equal(payload.peer.id, "node-live-peer");

      main.runtime.scheduler.start();
      await waitFor(
        () =>
          main?.runtime
            .listSources()
            .some((source) => source.id === "node-live-peer" && source.status === "ok") ?? false,
        "the main node never collected the live peer",
      );

      const snapshot = main.runtime.snapshot();
      assert.ok(snapshot.series.some((series) => series.sourceId === "node-live-peer"));

      const list = await body<{ peers: Record<string, unknown>[] }>(
        await fetch(`${main.baseUrl}/api/peers`),
      );
      assert.equal(JSON.stringify(list).includes(token), false);
    },
  );
});
