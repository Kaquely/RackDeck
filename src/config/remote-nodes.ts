import { redactUrl } from "../server/integrations/http-json-reader.ts";
import { isPeerToken, readInteger } from "./environment.ts";
import type { Env, NodeRole } from "./environment.ts";
import { ConfigurationError } from "./environment.ts";

function readOptional(env: Env, variable: string): string | null {
  const raw = env[variable];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Configuration for direct-query observation of sibling RackDeck nodes.
 *
 * The feature is optional. Leaving the URL list empty means the dashboard behaves exactly
 * as it did before remote observation existed: no peer source, no requests, no overhead.
 */

export type RemoteNodeConfig = {
  /** Stable source identifier, for example `node-living-room`. */
  id: string;
  /** Base URL of a peer RackDeck instance, already validated. */
  url: string;
  /** Human readable source label. */
  label: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Shared peer credential. Never logged or returned by an HTTP route. */
  token: string | null;
  /** True when the peer was added through the dashboard rather than the environment. */
  managed: boolean;
};

export const EMPTY_REMOTE_NODES: RemoteNodeConfig[] = [];

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname || "node";
  } catch {
    return "node";
  }
}

function normalizeForDuplicateCheck(parsed: URL): string {
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}`;
}

export function loadRemoteNodes(
  env: Env = process.env,
  role: NodeRole = "main",
): RemoteNodeConfig[] {
  const rawUrls = readOptional(env, "HOMELABMD_REMOTE_NODE_URLS");
  if (rawUrls === null) {
    return EMPTY_REMOTE_NODES;
  }

  if (role === "peer") {
    throw new ConfigurationError(
      "HOMELABMD_REMOTE_NODE_URLS",
      "must be empty when HOMELABMD_ROLE=peer; a peer does not poll other nodes",
    );
  }

  const timeoutMs = readInteger(env, "HOMELABMD_REMOTE_NODE_TIMEOUT_MS", 5_000, {
    min: 100,
    max: 60_000,
  });

  const urls = rawUrls
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (urls.length === 0) {
    return EMPTY_REMOTE_NODES;
  }

  const rawLabels = readOptional(env, "HOMELABMD_REMOTE_NODE_LABELS");
  const labels =
    rawLabels === null
      ? urls.map((url, index) => hostnameOf(url) || `node-${index + 1}`)
      : rawLabels.split(",").map((entry) => entry.trim());

  if (labels.length !== urls.length) {
    throw new ConfigurationError(
      "HOMELABMD_REMOTE_NODE_LABELS",
      `must contain exactly ${urls.length} comma-separated label(s), received ${labels.length}`,
    );
  }

  const rawTokens = readOptional(env, "HOMELABMD_REMOTE_NODE_TOKENS");
  const tokens = rawTokens === null ? null : rawTokens.split(",").map((entry) => entry.trim());

  if (tokens !== null && tokens.length !== urls.length) {
    throw new ConfigurationError(
      "HOMELABMD_REMOTE_NODE_TOKENS",
      `must contain exactly ${urls.length} comma-separated token(s), received ${tokens.length}`,
    );
  }

  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();

  return urls.map((raw, index) => {
    const labelRaw = labels[index];
    const label = labelRaw ?? "";
    if (label.length === 0) {
      throw new ConfigurationError(
        "HOMELABMD_REMOTE_NODE_LABELS",
        `label at position ${index + 1} must not be empty`,
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ConfigurationError(
        "HOMELABMD_REMOTE_NODE_URLS",
        `entry ${index + 1} must be an absolute URL, received "${raw}"`,
      );
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ConfigurationError(
        "HOMELABMD_REMOTE_NODE_URLS",
        `entry ${index + 1} must be an http or https URL, received "${raw}"`,
      );
    }

    const normalizedUrl = normalizeForDuplicateCheck(parsed);
    if (seenUrls.has(normalizedUrl)) {
      throw new ConfigurationError(
        "HOMELABMD_REMOTE_NODE_URLS",
        `contains the duplicate URL "${normalizedUrl}"`,
      );
    }
    seenUrls.add(normalizedUrl);

    const token = tokens?.[index] ?? null;
    if (token !== null && !isPeerToken(token)) {
      throw new ConfigurationError(
        "HOMELABMD_REMOTE_NODE_TOKENS",
        `entry ${index + 1} must be hlp_ followed by 43 base64url characters`,
      );
    }

    const id = `node-${slugify(label) || slugify(hostnameOf(raw)) || String(index + 1)}`;
    if (id === "host" || seenIds.has(id)) {
      throw new ConfigurationError(
        "HOMELABMD_REMOTE_NODE_LABELS",
        `produces the duplicate or reserved source identifier "${id}"`,
      );
    }
    seenIds.add(id);

    return {
      id,
      url: raw,
      label,
      timeoutMs,
      token,
      managed: false,
    };
  });
}

/**
 * Log-safe description. The token is reported only by presence, never by value.
 */
export function describeRemoteNodes(nodes: RemoteNodeConfig[]): string {
  if (nodes.length === 0) return "none";
  return nodes
    .map((node) => `${node.id} at ${redactUrl(node.url)} (auth=${node.token ? "token" : "none"})`)
    .join(", ");
}
