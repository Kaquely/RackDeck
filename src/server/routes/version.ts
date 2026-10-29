import { Router } from "express";
import type { UpdateResponse, VersionResponse } from "../../shared/api.ts";

export type VersionDependencies = {
  version: string;
  commit: string;
  channel: string;
};

export function versionRouter(dependencies: VersionDependencies): Router {
  const router = Router();

  router.get("/version", (_request, response) => {
    const body: VersionResponse = {
      version: dependencies.version,
      commit: dependencies.commit,
      channel: dependencies.channel,
    };
    response.status(200).json(body);
  });

  return router;
}

export function updateRouter(status: () => UpdateResponse): Router {
  const router = Router();

  /**
   * The body is already a bounded, sanitised view. This route performs no I/O: the checker
   * owns the cache and the background refresh, so a request can never wait on GitHub.
   */
  router.get("/update", (_request, response) => {
    response.status(200).json(status());
  });

  return router;
}

/** The stable shape used before the first check, or when checking is disabled. */
export function disabledUpdate(currentVersion: string): UpdateResponse {
  return {
    status: "disabled",
    currentVersion,
    latestVersion: null,
    releaseUrl: null,
    publishedAt: null,
    checkedAt: null,
    stale: false,
  };
}
