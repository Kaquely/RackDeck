import type { Layout } from "./layout.ts";
import type { ReadingsSnapshot, SourceInfo } from "./observations.ts";

/**
 * The HTTP contract.
 *
 * Response shapes are declared here and pinned by the contract tests, so a change to any
 * endpoint is a deliberate, visible change rather than an accidental drift.
 */

export type HealthResponse = {
  /** `ok` when the process can serve, `degraded` when a dependency is unhealthy. */
  status: "ok" | "degraded";
  version: string;
  /** Seconds since process start. */
  uptimeSeconds: number;
  /** The node's role, so an operator can tell a peer from a main at a glance. */
  role: "main" | "peer";
  /** `ok` or `degraded`; `degraded` means the stored layout could not be read. */
  layoutStore: { status: "ok" | "degraded"; error?: string };
  /** Status of the peer document. Always `ok` after a successful strict load. */
  peerStore: { status: "ok" | "degraded"; error?: string };
  sources: SourceInfo[];
};

export type ConfigResponse = {
  role: "main" | "peer";
  metricsIntervalMs: number;
  historyLength: number;
  dataDir: string;
  widgetTypes: readonly string[];
  maxTabs: number;
  maxWidgetsPerTab: number;
};

export type VersionResponse = {
  version: string;
  /** Source revision embedded at build time, or `unknown` for a local build. */
  commit: string;
  channel: string;
};

export type UpdateStatus = "current" | "available" | "unknown" | "disabled";

export type UpdateResponse = {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  /** True when the last successful check is older than the freshness window. */
  stale: boolean;
};

/** Token-free peer metadata for the Nodes dialog. */
export type PeerSummary = {
  id: string;
  label: string;
  url: string;
  /** False when the peer comes from the environment and cannot be removed in the UI. */
  managed: boolean;
  hasToken: boolean;
};

export type PeersResponse = {
  peers: PeerSummary[];
};

export type PeerInfoResponse = {
  role: "peer";
  version: string;
  id: string;
};

export type PeerVerifyRequest = {
  url: string;
  token: string;
};

export type PeerVerifyResponse = PeerInfoResponse;

export type PeerAddRequest = {
  label: string;
  url: string;
  token: string;
};

export type PeerAddResponse = {
  peer: PeerSummary;
};

export type PeerDeleteResponse = {
  removed: true;
};

export type SourcesResponse = {
  sources: SourceInfo[];
};

export type ReadingsResponse = ReadingsSnapshot;

export type LayoutResponse = {
  layout: Layout;
};

export type ErrorResponse = {
  error: {
    code: string;
    message: string;
    /** Field-level detail, present for validation failures. */
    details?: string[];
  };
};
