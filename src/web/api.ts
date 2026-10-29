import type { Layout, WidgetConfig, WidgetType } from "../shared/layout.ts";
import type { Series, SourceInfo, TableData } from "../shared/observations.ts";
import type {
  PeerAddRequest,
  PeerAddResponse,
  PeerDeleteResponse,
  PeerInfoResponse,
  PeersResponse,
  PeerSummary,
  PeerVerifyRequest,
  ReadingsResponse,
  UpdateResponse,
} from "../shared/api.ts";

/**
 * The read-only client.
 *
 * It exposes the reads the dashboard needs, one write for the product's own layout document,
 * and peer management on a main node. There is deliberately no method that could change an
 * observed system, which is the client-side half of the read-only guarantee the server
 * enforces.
 */

export type PublicConfig = {
  role: "main" | "peer";
  metricsIntervalMs: number;
  historyLength: number;
  dataDir: string;
  widgetTypes: readonly string[];
  maxTabs: number;
  maxWidgetsPerTab: number;
};

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(`GET ${url} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; details?: string[] };
  } | null;
  return body?.error?.details?.join("; ") ?? body?.error?.message ?? fallback;
}

export function fetchReadings(signal?: AbortSignal): Promise<ReadingsResponse> {
  return readJson<ReadingsResponse>("/api/readings", signal);
}

export async function fetchConfig(): Promise<PublicConfig> {
  const body = await readJson<PublicConfig>("/api/config");
  return body;
}

export async function fetchVersion(): Promise<string> {
  const body = await readJson<{ version: string }>("/api/version");
  return body.version;
}

export async function fetchLayout(): Promise<Layout> {
  const body = await readJson<{ layout: Layout }>("/api/layout");
  return body.layout;
}

export async function fetchHealth(): Promise<{ status: string; sources: SourceInfo[] }> {
  return readJson<{ status: string; sources: SourceInfo[] }>("/api/health");
}

export function fetchUpdateStatus(signal?: AbortSignal): Promise<UpdateResponse> {
  return readJson<UpdateResponse>("/api/update", signal);
}

/**
 * Replace the stored layout.
 *
 * The server echoes back what it stored, so the caller adopts the response rather than
 * assuming its input was stored verbatim.
 */
export async function saveLayout(layout: Layout): Promise<Layout> {
  const response = await fetch("/api/layout", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout }),
  });

  if (!response.ok) {
    const detail = await errorMessage(
      response,
      `Saving the layout failed with status ${response.status}`,
    );
    throw new Error(detail);
  }

  const body = (await response.json()) as { layout: Layout };
  return body.layout;
}

export async function fetchPeers(): Promise<PeerSummary[]> {
  const body = await readJson<PeersResponse>("/api/peers");
  return body.peers;
}

export async function verifyPeer(input: PeerVerifyRequest): Promise<PeerInfoResponse> {
  const response = await fetch("/api/peers/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(
      await errorMessage(response, `Verification failed with status ${response.status}`),
    );
  }

  return (await response.json()) as PeerInfoResponse;
}

export async function addPeer(input: PeerAddRequest): Promise<PeerSummary> {
  const response = await fetch("/api/peers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(
      await errorMessage(response, `Adding the peer failed with status ${response.status}`),
    );
  }

  const body = (await response.json()) as PeerAddResponse;
  return body.peer;
}

export async function removePeer(id: string): Promise<void> {
  const response = await fetch(`/api/peers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(
      await errorMessage(response, `Removing the peer failed with status ${response.status}`),
    );
  }

  // The body is `{removed:true}`; parsing it is unnecessary, but a malformed response is still
  // a server contract violation worth surfacing rather than silently ignoring.
  const body = (await response.json()) as PeerDeleteResponse;
  if (body.removed !== true) {
    throw new Error("The server did not confirm the removal.");
  }
}

/** An index of the latest snapshot, so a widget can resolve its metrics in one lookup. */
export type ReadingsIndex = {
  series: Map<string, Series>;
  tables: Map<string, TableData>;
  sources: SourceInfo[];
  generatedAt: number;
  intervalMs: number;
};

export function keyOf(sourceId: string, metric: string): string {
  return `${sourceId}.${metric}`;
}

export function indexReadings(snapshot: ReadingsResponse): ReadingsIndex {
  const series = new Map<string, Series>();
  for (const entry of snapshot.series) {
    series.set(keyOf(entry.sourceId, entry.metric), entry);
  }

  const tables = new Map<string, TableData>();
  for (const table of snapshot.tables) {
    tables.set(table.id, table);
  }

  return {
    series,
    tables,
    sources: snapshot.sources,
    generatedAt: snapshot.generatedAt,
    intervalMs: snapshot.intervalMs,
  };
}

export type { Layout, WidgetConfig, WidgetType, Series, SourceInfo, TableData, PeerSummary };
