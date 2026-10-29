import type { ReadingsResponse } from "../../shared/api.ts";
import type { Collector, CollectorResult } from "./types.ts";
import type { RemoteNodeConfig } from "../../config/remote-nodes.ts";
import { resolvePeerUrl } from "../../config/peer-url.ts";
import type { ResolvedPeerUrl } from "../../config/peer-url.ts";
import { HttpJsonReader, IntegrationError } from "../integrations/http-json-reader.ts";

export type RemoteNodeCollectorDeps = {
  fetchFn?: typeof fetch;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * URL policy hook. Production uses DNS resolution plus the private-address allowlist; a
   * test can replace it without opening a resolver.
   */
  resolveUrl?: (url: string) => Promise<ResolvedPeerUrl>;
};

function isReadingsSnapshot(value: unknown): value is ReadingsResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.generatedAt === "number" &&
    typeof candidate.intervalMs === "number" &&
    Array.isArray(candidate.sources) &&
    Array.isArray(candidate.series) &&
    Array.isArray(candidate.tables)
  );
}

export function createRemoteNodeCollector(
  config: RemoteNodeConfig,
  deps: RemoteNodeCollectorDeps = {},
): Collector {
  const resolveUrl = deps.resolveUrl ?? resolvePeerUrl;

  return {
    id: config.id,
    label: config.label,
    kind: "remote-node",

    async collect(): Promise<CollectorResult> {
      try {
        await resolveUrl(config.url);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new IntegrationError("unreachable", `peer URL rejected: ${detail}`);
      }

      const reader = new HttpJsonReader({
        baseUrl: config.url,
        timeoutMs: config.timeoutMs,
        // A redirect could forward the bearer token to a host the operator did not choose.
        redirect: "error",
        fetchFn: deps.fetchFn,
        setTimeoutFn: deps.setTimeoutFn,
        clearTimeoutFn: deps.clearTimeoutFn,
      });

      const headers: Record<string, string> =
        config.token === null ? {} : { authorization: `Bearer ${config.token}` };

      let payload: ReadingsResponse;
      try {
        payload = await reader.getJson<ReadingsResponse>("/api/readings", { headers });
      } catch (error) {
        if (error instanceof IntegrationError) {
          // The generic reader treats every non-2xx as a status failure so other integrations
          // can keep their own semantics. A peer 401 specifically means the token is wrong.
          if (error.status === 401) {
            throw new IntegrationError("auth", error.message, 401);
          }
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(detail, { cause: error });
      }

      if (!isReadingsSnapshot(payload)) {
        throw new Error("remote peer returned an invalid readings payload");
      }

      const hostSource = payload.sources.find((source) => source.id === "host");
      const status = hostSource?.status ?? (payload.series.length > 0 ? "ok" : "unavailable");

      const metrics = payload.series.map((series) => {
        const latest = series.samples.length > 0 ? series.samples[series.samples.length - 1] : null;
        const value = latest?.v;
        return {
          metric: series.metric,
          label: series.label,
          unit: series.unit,
          value: typeof value === "number" && Number.isFinite(value) ? value : null,
        };
      });

      const tables = payload.tables.map((table) => ({ ...table }));

      return { status, metrics, tables };
    },
  };
}
