import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/environment.ts";
import { loadRemoteNodes } from "../../src/config/remote-nodes.ts";
import { EMPTY_INTEGRATIONS } from "../../src/config/integrations.ts";
import { createRuntime } from "../../src/main.ts";
import type { Server } from "node:http";
import type { ReadingsSnapshot } from "../../src/shared/observations.ts";

describe("remote node observation", () => {
  let peerDir: string;
  let aggregatorDir: string;
  let peerServer: Server;
  let aggregatorServer: Server;
  let aggregatorBaseUrl: string;

  before(async () => {
    peerDir = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-remote-peer-"));
    aggregatorDir = await fs.mkdtemp(path.join(os.tmpdir(), "homelabmd-remote-aggregator-"));

    const peerConfig = loadConfig(
      {
        NODE_ENV: "test",
        HOMELABMD_HOST: "127.0.0.1",
        HOMELABMD_DATA_DIR: peerDir,
        HOMELABMD_STATIC_DIR: path.join(peerDir, "no-frontend-here"),
        HOMELABMD_METRICS_INTERVAL_MS: "500",
        HOMELABMD_HISTORY_LENGTH: "10",
      },
      process.cwd(),
    );

    const peerRuntime = await createRuntime(peerConfig, EMPTY_INTEGRATIONS);
    peerServer = await new Promise<Server>((resolve) => {
      const listening = peerRuntime.app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const peerAddress = peerServer.address() as AddressInfo;
    const peerUrl = `http://127.0.0.1:${peerAddress.port}`;

    const aggregatorConfig = loadConfig(
      {
        NODE_ENV: "test",
        HOMELABMD_HOST: "127.0.0.1",
        HOMELABMD_DATA_DIR: aggregatorDir,
        HOMELABMD_STATIC_DIR: path.join(aggregatorDir, "no-frontend-here"),
        HOMELABMD_METRICS_INTERVAL_MS: "500",
        HOMELABMD_HISTORY_LENGTH: "10",
        HOMELABMD_REMOTE_NODE_URLS: peerUrl,
        HOMELABMD_REMOTE_NODE_LABELS: "Peer",
      },
      process.cwd(),
    );

    const remoteNodes = loadRemoteNodes({
      NODE_ENV: "test",
      HOMELABMD_REMOTE_NODE_URLS: peerUrl,
      HOMELABMD_REMOTE_NODE_LABELS: "Peer",
      HOMELABMD_REMOTE_NODE_TIMEOUT_MS: "1000",
    });

    const aggregatorRuntime = await createRuntime(
      aggregatorConfig,
      EMPTY_INTEGRATIONS,
      remoteNodes,
      {
        // The test servers bind to loopback; production rejects loopback peers.
        peerUrlPolicy: (url) => Promise.resolve({ url, addresses: [] }),
      },
    );
    aggregatorServer = await new Promise<Server>((resolve) => {
      const listening = aggregatorRuntime.app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    aggregatorBaseUrl = `http://127.0.0.1:${(aggregatorServer.address() as AddressInfo).port}`;

    const initialPeerCollection = await peerRuntime.scheduler.runOnce();
    void initialPeerCollection;
    await aggregatorRuntime.scheduler.runOnce();
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      aggregatorServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      peerServer.close(() => resolve());
    });
    await fs.rm(aggregatorDir, { recursive: true, force: true });
    await fs.rm(peerDir, { recursive: true, force: true });
  });

  it("registers peer reads as a remote source", async () => {
    const health = await fetch(`${aggregatorBaseUrl}/api/health`);
    const body = (await health.json()) as { sources: { id: string; kind: string }[] };

    assert.equal(health.status, 200);
    assert.ok(
      body.sources.some((source) => source.id === "node-peer" && source.kind === "remote-node"),
    );
  });

  it("aggregates peer metrics under the remote source", async () => {
    const readings = await fetch(`${aggregatorBaseUrl}/api/readings`);
    const body = (await readings.json()) as ReadingsSnapshot;

    assert.equal(readings.status, 200);
    assert.ok(
      body.series.some(
        (series: { sourceId: string; metric: string }) =>
          series.sourceId === "node-peer" && series.metric === "cpu.usage",
      ),
    );
  });
});
