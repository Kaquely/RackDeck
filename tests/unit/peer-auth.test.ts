import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createPeerAuth } from "../../src/server/middleware/peer-auth.ts";
import { generatePeerToken } from "../../src/shared/peer-token.ts";

const TOKEN = generatePeerToken();

async function start(options: { token?: string; allowedIps?: string[] | null } = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.get(
    "/protected",
    createPeerAuth({
      token: options.token ?? TOKEN,
      allowedIps: options.allowedIps === undefined ? null : options.allowedIps,
    }),
    (_request, response) => {
      response.status(200).json({ ok: true });
    },
  );

  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("peer authentication", () => {
  const cleanups: (() => Promise<void>)[] = [];

  after(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  });

  async function server(options: { token?: string; allowedIps?: string[] | null } = {}) {
    const started = await start(options);
    cleanups.push(started.close);
    return started;
  }

  it("accepts the exact bearer token", async () => {
    const peer = await server();
    const response = await fetch(`${peer.baseUrl}/protected`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("rejects a missing token without echoing the secret", async () => {
    const peer = await server();
    const response = await fetch(`${peer.baseUrl}/protected`);
    const body = (await response.json()) as { error: { message: string } };

    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
    assert.equal(body.error.message.includes(TOKEN), false);
  });

  it("rejects a wrong token and a non-bearer scheme", async () => {
    const peer = await server();

    for (const authorization of [`Bearer ${generatePeerToken()}`, `Basic ${TOKEN}`, `Bearer`]) {
      const response = await fetch(`${peer.baseUrl}/protected`, {
        headers: { authorization },
      });
      assert.equal(response.status, 401, authorization);
    }
  });

  it("accepts a client inside the allowlist", async () => {
    const peer = await server({ allowedIps: ["127.0.0.1"] });
    const response = await fetch(`${peer.baseUrl}/protected`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 200);
  });

  it("accepts an IPv4-mapped allowlist entry", async () => {
    const peer = await server({ allowedIps: ["::ffff:127.0.0.1"] });
    const response = await fetch(`${peer.baseUrl}/protected`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 200);
  });

  it("rejects an address outside the allowlist even with a valid token", async () => {
    const peer = await server({ allowedIps: ["192.168.0.0/24"] });
    const response = await fetch(`${peer.baseUrl}/protected`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 403);
  });

  it("ignores a spoofed X-Forwarded-For header", async () => {
    const peer = await server({ allowedIps: ["192.168.0.10"] });
    const response = await fetch(`${peer.baseUrl}/protected`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-forwarded-for": "192.168.0.10",
        "x-real-ip": "192.168.0.10",
      },
    });

    assert.equal(response.status, 403);
  });

  it("refuses to build an invalid allowlist", () => {
    for (const entry of ["not-an-ip", "10.0.0.0/33", "10.0.0.0/abc"]) {
      assert.throws(
        () => createPeerAuth({ token: TOKEN, allowedIps: [entry] }),
        /invalid peer allowlist/,
      );
    }
  });
});
