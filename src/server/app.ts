import { existsSync } from "node:fs";
import express from "express";
import type { Express, RequestHandler, Router } from "express";
import path from "node:path";
import type { Config } from "../config/environment.ts";
import type { Layout } from "../shared/layout.ts";
import type { SourceInfo } from "../shared/observations.ts";
import type { ReadingsResponse, UpdateResponse } from "../shared/api.ts";
import type { JsonDocumentStore, StoreStatus } from "../store/json-document-store.ts";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.ts";
import { enforceReadOnlyApi } from "./middleware/read-only-guard.ts";
import { createPeerAuth } from "./middleware/peer-auth.ts";
import { layoutRouter } from "./routes/layout.ts";
import { readingsRouter, sourcesRouter } from "./routes/readings.ts";
import { configRouter, healthRouter } from "./routes/status.ts";
import { disabledUpdate, updateRouter, versionRouter } from "./routes/version.ts";
import { peerInfoRouter, peersRouter } from "./routes/peers.ts";
import type { PeerManager } from "./peers/peer-manager.ts";
import { APP_CHANNEL, APP_COMMIT, APP_VERSION } from "./version.ts";

export type AppDependencies = {
  config: Config;
  layoutStore: JsonDocumentStore<Layout>;
  /** Current readings. Must be an in-memory read; see the readings router. */
  snapshot: () => ReadingsResponse;
  listSources: () => SourceInfo[];
  layoutStoreStatus: () => StoreStatus;
  /** Present on a main node. A peer has no peer store and no management routes. */
  peerManager?: PeerManager;
  peerStoreStatus?: () => StoreStatus;
  startedAt: number;
  version?: string;
  commit?: string;
  channel?: string;
  /** Cached update view. Must not perform I/O; the checker refreshes in the background. */
  updateStatus?: () => UpdateResponse;
};

const PEER_LANDING =
  "RackDeck peer\n\n" +
  "This node serves a read-only observation API and no dashboard.\n" +
  "Point a main RackDeck node at it with a valid peer token.\n";

/**
 * Build the HTTP application.
 *
 * This function deliberately does not listen. `src/main.ts` is the only module that binds a
 * port, which lets the integration and contract tests drive the real routing, middleware and
 * error handling in-process on an ephemeral port, with no child process and no teardown race.
 * The tests therefore exercise the same stack that runs in production.
 */
export function createApp(dependencies: AppDependencies): Express {
  const { config } = dependencies;
  const app = express();
  const peerStoreStatus = dependencies.peerStoreStatus ?? (() => ({ status: "ok" }));
  const version = dependencies.version ?? APP_VERSION;
  const updateStatus = dependencies.updateStatus ?? (() => disabledUpdate(version));

  // The dashboard is a single-user LAN page with no cookies and no sessions, so it is
  // explicitly not a cross-origin API. Trusting arbitrary proxies here would let any website
  // read a homelab's metrics through the operator's browser.
  app.disable("x-powered-by");

  app.use(express.json({ limit: config.jsonBodyLimit }));

  // Mounted at the root, not under `/api`, because Express strips the mount path from
  // `request.path`. Mounting under `/api` would hide the prefix from the guard and it would
  // never match. Running it before the routers lets it reject a mutating method before any
  // handler executes.
  app.use(enforceReadOnlyApi);

  // Health is intentionally public on both roles so the container probe never needs a token.
  app.use(
    "/api",
    healthRouter({
      config,
      version,
      startedAt: dependencies.startedAt,
      listSources: dependencies.listSources,
      layoutStoreStatus: dependencies.layoutStoreStatus,
      peerStoreStatus,
    }),
    versionRouter({
      version,
      commit: dependencies.commit ?? APP_COMMIT,
      channel: dependencies.channel ?? APP_CHANNEL,
    }),
    updateRouter(updateStatus),
  );

  if (config.role === "main") {
    app.use(
      "/api",
      configRouter(config),
      readingsRouter({ intervalMs: config.metricsIntervalMs, snapshot: dependencies.snapshot }),
      sourcesRouter(dependencies.listSources),
      layoutRouter(dependencies.layoutStore),
    );

    if (dependencies.peerManager !== undefined) {
      app.use("/api", peersRouter(dependencies.peerManager));
    }
  } else {
    // A peer mounts only the read-only observation surface. Every mounted route except health
    // goes through the token gate; an unknown `/api` path falls through to the JSON 404 rather
    // than revealing whether it would have required a token.
    const token = config.peerToken;
    const peerId = config.peerId;
    if (token === null || peerId === null) {
      // `loadConfig` enforces this, so reaching here means the app was composed incorrectly.
      throw new Error("a peer requires a token and an id");
    }

    const auth = createPeerAuth({ token, allowedIps: config.peerAllowedIps });
    app.use(
      "/api",
      requireAuthentication(
        configRouter(config),
        readingsRouter({ intervalMs: config.metricsIntervalMs, snapshot: dependencies.snapshot }),
        sourcesRouter(dependencies.listSources),
        peerInfoRouter({ version, peerId }),
        auth,
      ),
    );
  }

  // Unmatched API paths must be JSON 404s. Without this they would fall through to the SPA
  // fallback and return HTML with a 200, sending the client into a parse error.
  app.use("/api", notFoundHandler());

  if (config.role === "main") {
    app.use(staticAssets(config.staticDir));
  } else {
    app.use((request, response, next) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        next();
        return;
      }
      response.status(200).type("text/plain").send(PEER_LANDING);
    });
  }

  app.use(errorHandler(config.nodeEnv));

  return app;
}

/** Wrap several routers behind one authentication middleware. */
function requireAuthentication(
  first: Router,
  second: Router,
  third: Router,
  fourth: Router,
  auth: RequestHandler,
): Router {
  const wrapper = express.Router();
  wrapper.use(auth);
  wrapper.use(first);
  wrapper.use(second);
  wrapper.use(third);
  wrapper.use(fourth);
  return wrapper;
}

/**
 * Serve the built frontend, with a single-page fallback.
 *
 * The fallback is what makes a deep link such as `/?tab=network` survive a reload. It is
 * mounted after the API so it can never shadow an API route.
 */
function staticAssets(staticDir: string): RequestHandler {
  const indexPath = path.join(staticDir, "index.html");

  if (!existsSync(indexPath)) {
    // A placeholder rather than a 404, so a developer who started only the backend sees an
    // explanation instead of a bare "Cannot GET /".
    return (_request, response) => {
      response
        .status(503)
        .type("text/plain")
        .send(
          "The frontend has not been built yet.\n\n" +
            "Run `npm run build` and restart, or use `npm run dev:web` for the Vite dev server.\n",
        );
    };
  }

  const assets = express.static(staticDir, { index: false, maxAge: "1h" });

  return (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    assets(request, response, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      // No static file matched, so this is a client-side route: serve the shell.
      response.sendFile(indexPath, (sendError?: unknown) => {
        if (sendError) next(sendError);
      });
    });
  };
}
