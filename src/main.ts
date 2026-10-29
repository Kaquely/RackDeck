import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config/environment.ts";
import type { Config } from "./config/environment.ts";
import { loadIntegrations } from "./config/integrations.ts";
import type { IntegrationConfig } from "./config/integrations.ts";
import { loadRemoteNodes, describeRemoteNodes } from "./config/remote-nodes.ts";
import type { RemoteNodeConfig } from "./config/remote-nodes.ts";
import type { ResolvedPeerUrl } from "./config/peer-url.ts";
import { createIntegrationCollectors, describeIntegrations } from "./server/integrations/index.ts";
import { createApp } from "./server/app.ts";
import { createHostCollector } from "./server/collectors/host.ts";
import { createRemoteNodeCollector } from "./server/collectors/remote-node.ts";
import { CollectorScheduler } from "./server/metrics/collector-scheduler.ts";
import { SnapshotStore } from "./server/metrics/snapshot-store.ts";
import { createPeerManager } from "./server/peers/peer-manager.ts";
import type { PeerManager } from "./server/peers/peer-manager.ts";
import { createPeerStore } from "./server/peers/peer-store.ts";
import { createUpdateChecker } from "./server/update/update-checker.ts";
import type { UpdateChecker } from "./server/update/update-checker.ts";
import { APP_CHANNEL, APP_COMMIT, APP_VERSION } from "./server/version.ts";
import type { SourceInfo } from "./shared/observations.ts";
import type { ReadingsResponse } from "./shared/api.ts";
import { defaultLayout, validateLayout } from "./shared/layout.ts";
import { migrateLayout } from "./shared/layout-migrations.ts";
import type { Layout } from "./shared/layout.ts";
import { JsonDocumentStore } from "./store/json-document-store.ts";

/**
 * Composition root.
 *
 * Assembles the configuration, the layout store and the HTTP application, then owns the
 * process lifecycle. Nothing here contacts a data source, so the dashboard binds its port
 * and starts serving even when every observed system is unreachable — a homelab whose
 * applications are all down must still be able to show *why* it is empty.
 */

export type RuntimeOptions = {
  /** Test seam for the peer address policy. Production uses `resolvePeerUrl`. */
  peerUrlPolicy?: (url: string) => Promise<ResolvedPeerUrl>;
  /** Test seam for verification. Production calls the peer information endpoint. */
  verifyPeer?: (
    url: string,
    token: string,
  ) => Promise<{
    role: "peer";
    version: string;
    id: string;
  }>;
  /** Test seam for the update check; production uses the global fetch. */
  updateFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
};

export type Runtime = {
  config: Config;
  store: JsonDocumentStore<Layout>;
  app: ReturnType<typeof createApp>;
  scheduler: CollectorScheduler;
  peerManager?: PeerManager;
  updateChecker: UpdateChecker;
  /** In-memory readings. A cheap read; never performs I/O. */
  snapshot: () => ReadingsResponse;
  listSources: () => SourceInfo[];
};

export async function createRuntime(
  config: Config,
  integrations = loadIntegrations(),
  remoteNodes = loadRemoteNodes(process.env, config.role),
  options: RuntimeOptions = {},
): Promise<Runtime> {
  if (config.role === "peer" && remoteNodes.length > 0) {
    throw new Error(
      "HOMELABMD_REMOTE_NODE_URLS must be empty when HOMELABMD_ROLE=peer; a peer does not poll other nodes",
    );
  }
  const store = new JsonDocumentStore<Layout>({
    filePath: config.layoutFile,
    fallback: defaultLayout,
    validate: validateLayout,
    migrate: migrateLayout,
  });

  const snapshotStore = new SnapshotStore({
    historyLength: config.historyLength,
    intervalMs: config.metricsIntervalMs,
  });

  // An integration that is not configured contributes nothing, so a default install
  // behaves exactly as it did before the framework existed. Peer collectors are added by
  // the peer manager so environment and stored peers follow one registration path.
  const scheduler = new CollectorScheduler({
    collectors: [createHostCollector(), ...createIntegrationCollectors(integrations)],
    store: snapshotStore,
    intervalMs: config.metricsIntervalMs,
  });

  let peerManager: PeerManager | undefined;
  if (config.role === "main") {
    peerManager = await createPeerManager({
      environmentPeers: remoteNodes,
      store: createPeerStore(config.peersFile),
      scheduler,
      createCollector: (peer) =>
        createRemoteNodeCollector(peer, { resolveUrl: options.peerUrlPolicy }),
      verifyPeer: options.verifyPeer,
      ...(options.peerUrlPolicy === undefined ? {} : { resolveUrl: options.peerUrlPolicy }),
    });
  }

  const updateChecker = createUpdateChecker({
    currentVersion: APP_VERSION,
    repository: config.updateRepository,
    enabled: config.updateCheck === "github",
    intervalMs: config.updateCheckIntervalMs,
    channel: config.updateChannel,
    ...(options.updateFetch === undefined ? {} : { fetchImpl: options.updateFetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const app = createApp({
    config,
    layoutStore: store,
    snapshot: () => snapshotStore.snapshot(),
    listSources: () => snapshotStore.listSources(),
    layoutStoreStatus: () => store.status(),
    peerManager,
    peerStoreStatus: () =>
      peerManager === undefined ? { status: "ok" } : peerManager.storeStatus(),
    startedAt: Date.now(),
    version: APP_VERSION,
    commit: APP_COMMIT,
    channel: APP_CHANNEL,
    updateStatus: () => updateChecker.view(),
  });

  return {
    config,
    store,
    app,
    scheduler,
    peerManager,
    updateChecker,
    snapshot: () => snapshotStore.snapshot(),
    listSources: () => snapshotStore.listSources(),
  };
}

/**
 * Write the startup banner.
 *
 * The sink is injectable so a test can capture the exact lines. Nothing here may include a
 * credential: a peer reports only `token=present`, and a main reports peer labels and URLs
 * without the matching token.
 */
export function logStartup(
  config: Config,
  integrations: IntegrationConfig,
  peers: RemoteNodeConfig[],
  log: (message: string) => void = console.log,
): void {
  log(`[server] RackDeck listening on http://${config.host}:${config.port}`);
  log(`[server] role=${config.role} nodeEnv=${config.nodeEnv}`);
  log(`[server] interval=${config.metricsIntervalMs}ms`);
  log(`[server] integrations=${describeIntegrations(integrations)}`);
  if (config.role === "peer") {
    log(
      `[server] peerId=${config.peerId ?? "unknown"} token=present allowlist=${
        config.peerAllowedIps === null ? "none" : config.peerAllowedIps.length
      }`,
    );
    return;
  }
  log(`[server] peers=${describeRemoteNodes(peers)}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const integrations = loadIntegrations();
  const remoteNodes = loadRemoteNodes(process.env, config.role);
  const runtime = await createRuntime(config, integrations, remoteNodes);

  const storeStatus = await runtime.store.load();
  if (storeStatus.status === "degraded") {
    // Not fatal: a corrupt layout must not stop the dashboard from starting. It is logged
    // loudly because the operator's saved layout is genuinely at risk.
    console.error(`[layout] ${storeStatus.error}`);
  } else {
    console.log(`[layout] loaded ${config.layoutFile}`);
  }

  const server = runtime.app.listen(config.port, config.host, () => {
    logStartup(config, integrations, runtime.peerManager?.peers() ?? []);
  });

  // A slow or stalled client must not hold a connection open indefinitely on a long-running
  // process. This bounds request lifetime without affecting normal responses.
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 10_000;

  // Started after the port is bound so the dashboard is reachable immediately, rather than
  // refusing to respond while the first collection cycle runs.
  runtime.scheduler.start();
  runtime.updateChecker.start();

  let shuttingDown = false;

  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, draining in-flight requests`);

    // Stop background work first: no new source or network work should start while draining.
    runtime.scheduler.stop();
    runtime.updateChecker.stop();

    // Stop accepting new connections immediately, then let in-flight requests finish so a
    // container restart does not truncate a dashboard save.
    server.close((error) => {
      if (error) {
        console.error("[server] error while closing", error);
        process.exit(1);
        return;
      }
      console.log("[server] closed cleanly");
      process.exit(exitCode);
    });

    server.closeIdleConnections();

    // Backstop so a wedged connection cannot block the restart indefinitely.
    const forced = setTimeout(() => {
      console.error("[server] drain timed out, forcing exit");
      process.exit(1);
    }, 10_000);
    forced.unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    // Logged rather than fatal: a rejected promise from one collector must not take down a
    // dashboard that is otherwise serving correctly.
    console.error("[process] unhandled promise rejection", reason);
  });

  process.on("uncaughtException", (error) => {
    // Fatal and non-zero: after an uncaught exception the process state is not trustworthy.
    console.error("[process] uncaught exception", error);
    shutdown("uncaughtException", 1);
  });
}

/**
 * True when this module is the process entry point.
 *
 * Comparing resolved file URLs is the reliable form. Comparing `import.meta.url` against
 * `process.argv[1]` directly breaks on Windows, where one is a `file:///C:/...` URL and the
 * other is a `C:\...` path.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error("[server] failed to start", error);
    process.exit(1);
  });
}
