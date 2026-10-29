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
import { generatePeerToken } from "../../src/shared/peer-token.ts";

/**
 * The peer role surface.
 *
 * A peer is the same image as a main node with a different composition. These tests drive the
 * real app so the role boundary is exercised at the routing layer: public health, token-gated
 * reads, no dashboard, no layout writes and no peer-management routes.
 */

const TOKEN = generatePeerToken();

type Started = {
  runtime: Runtime;
  server: Server;
  baseUrl: string;
};

async function listen(runtime: Runtime): Promise<Started> {
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  return { runtime, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(started: Started): Promise<void> {
  started.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    started.server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("peer role surface", () => {
  let directory: string;
  let peer: Started;
  let restricted: Started;

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-peer-role-"));

    const config = loadConfig({
      NODE_ENV: "test",
      HOMELABMD_HOST: "127.0.0.1",
      HOMELABMD_ROLE: "peer",
      HOMELABMD_PEER_TOKEN: TOKEN,
      HOMELABMD_PEER_ID: "peer-lab",
      HOMELABMD_DATA_DIR: path.join(directory, "open"),
      HOMELABMD_STATIC_DIR: path.join(directory, "no-frontend-here"),
      HOMELABMD_METRICS_INTERVAL_MS: "500",
      HOMELABMD_HISTORY_LENGTH: "10",
    });
    peer = await listen(await createRuntime(config, EMPTY_INTEGRATIONS, []));
    await peer.runtime.store.load();

    const restrictedConfig = loadConfig({
      NODE_ENV: "test",
      HOMELABMD_HOST: "127.0.0.1",
      HOMELABMD_ROLE: "peer",
      HOMELABMD_PEER_TOKEN: TOKEN,
      HOMELABMD_PEER_ID: "peer-restricted",
      HOMELABMD_PEER_ALLOWED_IPS: "192.168.0.5",
      HOMELABMD_DATA_DIR: path.join(directory, "restricted"),
      HOMELABMD_STATIC_DIR: path.join(directory, "no-frontend-here"),
      HOMELABMD_METRICS_INTERVAL_MS: "500",
      HOMELABMD_HISTORY_LENGTH: "10",
    });
    restricted = await listen(await createRuntime(restrictedConfig, EMPTY_INTEGRATIONS, []));
    await restricted.runtime.store.load();
  });

  after(async () => {
    await close(peer);
    await close(restricted);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("serves public health without a token and reports the role", async () => {
    const response = await fetch(`${peer.baseUrl}/api/health`);
    const body = await json<{ status: string; role: string; version: string }>(response);

    assert.equal(response.status, 200);
    assert.ok(["ok", "degraded"].includes(body.status));
    assert.equal(body.role, "peer");
    assert.equal(typeof body.version, "string");
  });

  it("serves a plain-text landing page instead of the dashboard shell", async () => {
    for (const target of ["/", "/index.html", "/assets/app.js"]) {
      const response = await fetch(`${peer.baseUrl}${target}`);
      const body = await response.text();

      assert.equal(response.status, 200, target);
      assert.match(response.headers.get("content-type") ?? "", /^text\/plain/, target);
      assert.match(body, /RackDeck peer/, target);
      assert.doesNotMatch(body, /<html/i, target);
    }
  });

  it("rejects an unauthenticated read without leaking readings", async () => {
    const response = await fetch(`${peer.baseUrl}/api/readings`);
    const body = await json<{ error: { code: string; message: string } }>(response);

    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
    assert.equal(body.error.code, "unauthorized");
    assert.equal("series" in body, false);
    assert.equal("sources" in body, false);
  });

  it("rejects a wrong token without echoing either token", async () => {
    const wrong = generatePeerToken();
    const response = await fetch(`${peer.baseUrl}/api/readings`, {
      headers: { authorization: `Bearer ${wrong}` },
    });
    const body = await response.text();

    assert.equal(response.status, 401);
    assert.equal(body.includes(TOKEN), false);
    assert.equal(body.includes(wrong), false);
  });

  it("accepts the configured token on every data route", async () => {
    const headers = { authorization: `Bearer ${TOKEN}` };

    const readings = await fetch(`${peer.baseUrl}/api/readings`, { headers });
    const readingsBody = await json<{
      sources: { id: string; kind: string }[];
      series: unknown[];
    }>(readings);
    assert.equal(readings.status, 200);
    assert.ok(readingsBody.sources.some((source) => source.id === "host"));
    assert.ok(Array.isArray(readingsBody.series));

    const config = await fetch(`${peer.baseUrl}/api/config`, { headers });
    assert.equal(config.status, 200);
    assert.equal((await json<{ role: string }>(config)).role, "peer");

    const sources = await fetch(`${peer.baseUrl}/api/sources`, { headers });
    assert.equal(sources.status, 200);
    assert.ok(Array.isArray((await json<{ sources: unknown[] }>(sources)).sources));
  });

  it("identifies itself through the authenticated peer-info endpoint", async () => {
    const headers = { authorization: `Bearer ${TOKEN}` };

    const unauthenticated = await fetch(`${peer.baseUrl}/api/peer/info`);
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(`${peer.baseUrl}/api/peer/info`, { headers });
    const body = await json<Record<string, unknown>>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["id", "role", "version"]);
    assert.equal(body.role, "peer");
    assert.equal(body.id, "peer-lab");
    assert.equal(typeof body.version, "string");
    assert.equal("token" in body, false);
  });

  it("does not mount layout or peer-management routes", async () => {
    const headers = { authorization: `Bearer ${TOKEN}` };

    const targets: { url: string; method: string; body?: string }[] = [
      { url: "/api/layout", method: "GET" },
      { url: "/api/peers", method: "GET" },
      { url: "/api/peers/verify", method: "POST" },
    ];

    for (const target of targets) {
      const response = await fetch(`${peer.baseUrl}${target.url}`, {
        method: target.method,
        headers: {
          ...headers,
          ...(target.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(target.body === undefined ? {} : { body: target.body }),
      });
      assert.equal(response.status, 404, target.url);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/, target.url);
    }

    // The read-only guard rejects an unknown API method before role routing, which is still a
    // refusal; the exact status is not part of the peer contract.
    const write = await fetch(`${peer.baseUrl}/api/layout`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ layout: { version: 1, tabs: [], activeTabId: "" } }),
    });
    assert.notEqual(write.status, 200);
    assert.notEqual(write.status, 201);
  });

  it("returns a JSON 404 for an unknown API path", async () => {
    const headers = { authorization: `Bearer ${TOKEN}` };

    const unauthenticated = await fetch(`${peer.baseUrl}/api/nope`);
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(`${peer.baseUrl}/api/nope`, { headers });
    const body = await json<{ error: { code: string; message: string } }>(response);
    assert.equal(response.status, 404);
    assert.equal(typeof body.error.code, "string");
    assert.equal(typeof body.error.message, "string");
  });

  it("refuses a caller outside the allowlist before checking the token", async () => {
    const response = await fetch(`${restricted.baseUrl}/api/readings`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-forwarded-for": "192.168.0.5",
        "x-real-ip": "192.168.0.5",
      },
    });
    const body = await json<{ error: { code: string } }>(response);

    assert.equal(response.status, 403);
    assert.equal(body.error.code, "forbidden");

    const health = await fetch(`${restricted.baseUrl}/api/health`);
    assert.equal(health.status, 200);
  });

  it("refuses to compose a peer that polls remote nodes", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      HOMELABMD_ROLE: "peer",
      HOMELABMD_PEER_TOKEN: TOKEN,
      HOMELABMD_DATA_DIR: path.join(directory, "invalid"),
    });

    await assert.rejects(
      () =>
        createRuntime(config, EMPTY_INTEGRATIONS, [
          {
            id: "node-other",
            label: "Other",
            url: "http://192.168.0.30:3000",
            timeoutMs: 1_000,
            token: null,
            managed: false,
          },
        ]),
      /HOMELABMD_REMOTE_NODE_URLS/,
    );
  });
});
