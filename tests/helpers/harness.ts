import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { loadConfig } from "../../src/config/environment.ts";
import { createApp } from "../../src/server/app.ts";
import { defaultLayout, validateLayout } from "../../src/shared/layout.ts";
import type { Layout } from "../../src/shared/layout.ts";
import { JsonDocumentStore } from "../../src/store/json-document-store.ts";

export type Harness = {
  baseUrl: string;
  store: JsonDocumentStore<Layout>;
  dataDir: string;
  close: () => Promise<void>;
};

/**
 * Start the real application on an ephemeral port.
 *
 * Integration and contract tests drive the same `createApp` stack that runs in production
 * rather than a reimplementation, so routing, middleware and error handling are all covered.
 * The port is 0, so tests never collide and never need teardown ordering.
 */
export async function startHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "homelabmd-http-"));

  const config = loadConfig(
    {
      NODE_ENV: "test",
      HOMELABMD_HOST: "127.0.0.1",
      HOMELABMD_DATA_DIR: dataDir,
      // Point at a directory that cannot exist, so tests exercise the "frontend not built"
      // branch deterministically instead of depending on whether dist/ happens to be there.
      HOMELABMD_STATIC_DIR: path.join(dataDir, "no-frontend-here"),
      ...overrides,
    },
    process.cwd(),
  );

  const store = new JsonDocumentStore<Layout>({
    filePath: config.layoutFile,
    fallback: defaultLayout,
    validate: validateLayout,
  });
  await store.load();

  const app: Express = createApp({
    config,
    layoutStore: store,
    snapshot: () => ({
      generatedAt: 1_700_000_000_000,
      intervalMs: config.metricsIntervalMs,
      sources: [],
      series: [],
      tables: [],
    }),
    listSources: () => [],
    layoutStoreStatus: () => store.status(),
    startedAt: Date.now() - 5_000,
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    dataDir,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
