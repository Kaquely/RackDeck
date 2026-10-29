import { Router } from "express";
import type { ReadingsResponse, SourcesResponse } from "../../shared/api.ts";
import type { SourceInfo } from "../../shared/observations.ts";

export type ReadingsDependencies = {
  /** Configured sampling interval, echoed so the client can detect drift. */
  intervalMs: number;
  /**
   * Returns the current snapshot.
   *
   * This must be a cheap, in-memory read. Querying a source here would make every request pay
   * the cost of the slowest source and would break the 200 ms response budget, so collection
   * happens on a timer and the request only reads the buffer.
   */
  snapshot: () => ReadingsResponse;
};

export function readingsRouter(dependencies: ReadingsDependencies): Router {
  const router = Router();

  router.get("/readings", (_request, response) => {
    const body: ReadingsResponse = dependencies.snapshot();
    response.status(200).json(body);
  });

  return router;
}

export function sourcesRouter(listSources: () => SourceInfo[]): Router {
  const router = Router();

  router.get("/sources", (_request, response) => {
    const body: SourcesResponse = { sources: listSources() };
    response.status(200).json(body);
  });

  return router;
}
