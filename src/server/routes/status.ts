import { Router } from "express";
import type { ConfigResponse, HealthResponse } from "../../shared/api.ts";
import { LAYOUT_LIMITS, WIDGET_TYPES } from "../../shared/layout.ts";
import type { SourceInfo } from "../../shared/observations.ts";
import { publicConfig } from "../../config/environment.ts";
import type { Config } from "../../config/environment.ts";
import type { StoreStatus } from "../../store/json-document-store.ts";

export type HealthDependencies = {
  config: Config;
  version: string;
  startedAt: number;
  /** Status of every registered source. Must not perform I/O. */
  listSources: () => SourceInfo[];
  /** Status of the layout store. Must not perform I/O. */
  layoutStoreStatus: () => StoreStatus;
  /** Status of the peer store. Must not perform I/O. */
  peerStoreStatus: () => StoreStatus;
};

export function healthRouter(dependencies: HealthDependencies): Router {
  const router = Router();

  /**
   * Liveness and readiness in one endpoint.
   *
   * It reports source and store status from already-held state and never contacts a source,
   * so it stays fast and truthful even when every source is unreachable. That is what makes
   * it usable as a container health check.
   */
  router.get("/health", (_request, response) => {
    const sources = dependencies.listSources();
    const layoutStore = dependencies.layoutStoreStatus();
    const peerStore = dependencies.peerStoreStatus();

    const allSourcesHealthy = sources.every(
      (source) => source.status === "ok" || source.status === "disabled",
    );
    const status: HealthResponse["status"] =
      allSourcesHealthy && layoutStore.status === "ok" && peerStore.status === "ok"
        ? "ok"
        : "degraded";

    const body: HealthResponse = {
      status,
      version: dependencies.version,
      uptimeSeconds: Math.max(0, Math.round((Date.now() - dependencies.startedAt) / 1000)),
      role: dependencies.config.role,
      layoutStore,
      peerStore,
      sources,
    };

    response.status(200).json(body);
  });

  return router;
}

export function configRouter(config: Config): Router {
  const router = Router();

  /**
   * Exposes an explicit allow-list, never a projection of the loaded configuration, so a
   * field added to `Config` later cannot leak a credential by default.
   */
  router.get("/config", (_request, response) => {
    const body: ConfigResponse = {
      ...publicConfig(config),
      role: config.role,
      widgetTypes: WIDGET_TYPES,
      maxTabs: LAYOUT_LIMITS.maxTabs,
      maxWidgetsPerTab: LAYOUT_LIMITS.maxWidgetsPerTab,
    };
    response.status(200).json(body);
  });

  return router;
}
