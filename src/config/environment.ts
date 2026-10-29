import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { isPeerToken } from "../shared/peer-token.ts";

/**
 * Typed configuration loaded once at startup.
 *
 * Every value comes from the environment so the container can be reconfigured without a
 * rebuild. Invalid values fail startup with a message naming the variable, rather than being
 * silently clamped at the point of use where they would produce quietly wrong numbers on a
 * chart.
 */

export type NodeEnv = "development" | "production" | "test";
export type NodeRole = "main" | "peer";
export type UpdateCheckMode = "github" | "off";
export type UpdateChannel = "stable" | "prerelease";

export type Config = {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  /** Sampling interval for every collector. Drives the client refresh cadence. */
  metricsIntervalMs: number;
  /** Samples retained per series. Bounds memory so it cannot grow with uptime. */
  historyLength: number;
  /** Directory holding the layout document. */
  dataDir: string;
  /** Absolute path of the layout document. */
  layoutFile: string;
  /** Absolute path of the persisted peer document. */
  peersFile: string;
  /** Directory of the built frontend. Served as static assets when present. */
  staticDir: string;
  /** Ceiling for a single request. Guards the read-only surface against slow bodies. */
  jsonBodyLimit: string;
  /**
   * `main` serves the dashboard and may observe peers. `peer` serves the read-only API only.
   * Defaults to `main` so every existing deployment keeps its behaviour.
   */
  role: NodeRole;
  /** Machine-to-machine token required by a peer. Never exposed over HTTP. */
  peerToken: string | null;
  /** Optional IP/CIDR allowlist for a peer. Never exposed over HTTP. */
  peerAllowedIps: string[] | null;
  /** Stable peer identifier reported by `/api/peer/info`. */
  peerId: string | null;
  /** Whether the server may check GitHub Releases for a newer version. */
  updateCheck: UpdateCheckMode;
  /** Minimum time between successful update checks. */
  updateCheckIntervalMs: number;
  /** Stable excludes prereleases; prerelease includes them. */
  updateChannel: UpdateChannel;
  /** GitHub repository in `owner/name` form used by the update check. */
  updateRepository: string;
};

export class ConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string, detail: string) {
    super(`Invalid configuration for ${variable}: ${detail}`);
    this.name = "ConfigurationError";
    this.variable = variable;
  }
}

type Env = Record<string, string | undefined>;

/** Exported so the integration configuration reuses exactly the same parsing and messages. */
export type { Env };

export function readString(env: Env, variable: string, fallback: string): string {
  const raw = env[variable];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ConfigurationError(variable, "must not be empty");
  }
  return trimmed;
}

export function readInteger(
  env: Env,
  variable: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = env[variable];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  // Number() would accept "", " " and "0x10", which are never intended values here.
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ConfigurationError(variable, `must be an integer, received "${raw}"`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < bounds.min || parsed > bounds.max) {
    throw new ConfigurationError(
      variable,
      `must be between ${bounds.min} and ${bounds.max}, received ${parsed}`,
    );
  }
  return parsed;
}

function readNodeEnv(env: Env): NodeEnv {
  const raw = env.NODE_ENV?.trim();
  if (raw === undefined || raw === "") return "production";
  if (raw === "development" || raw === "production" || raw === "test") return raw;
  throw new ConfigurationError(
    "NODE_ENV",
    `must be one of development, production, test; received "${raw}"`,
  );
}

/** Re-exported for existing server imports; the shared module is the source of truth. */
export { PEER_TOKEN_PATTERN, isPeerToken } from "../shared/peer-token.ts";

function readRole(env: Env): NodeRole {
  const raw = env.HOMELABMD_ROLE?.trim();
  if (raw === undefined || raw === "") return "main";
  if (raw === "main" || raw === "peer") return raw;
  throw new ConfigurationError("HOMELABMD_ROLE", `must be one of main, peer; received "${raw}"`);
}

function readOptional(env: Env, variable: string): string | null {
  const raw = env[variable];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function defaultPeerId(): string {
  const slug = os
    .hostname()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "peer" : slug.slice(0, 64);
}

function readPeerId(env: Env): string {
  const raw = readOptional(env, "HOMELABMD_PEER_ID") ?? defaultPeerId();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw)) {
    throw new ConfigurationError(
      "HOMELABMD_PEER_ID",
      "must be 1-64 lowercase letters, digits or hyphens, and start with a letter or digit",
    );
  }
  return raw;
}

/**
 * Validate an IP or CIDR entry without converting it to a binary form.
 *
 * The middleware builds the actual `net.BlockList`; keeping this layer textual makes the
 * configuration value easy to report in an error and easy to test.
 */
function isValidIpEntry(entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    return isIP(entry) !== 0;
  }
  if (entry.indexOf("/", slash + 1) !== -1) return false;

  const address = entry.slice(0, slash);
  const prefixRaw = entry.slice(slash + 1);
  const family = isIP(address);
  if (family === 0) return false;
  if (!/^\d{1,3}$/.test(prefixRaw)) return false;

  const prefix = Number.parseInt(prefixRaw, 10);
  return prefix >= 0 && prefix <= (family === 4 ? 32 : 128);
}

function readPeerAllowedIps(env: Env): string[] | null {
  const raw = readOptional(env, "HOMELABMD_PEER_ALLOWED_IPS");
  if (raw === null) return null;

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new ConfigurationError(
      "HOMELABMD_PEER_ALLOWED_IPS",
      "must contain at least one IP address or CIDR block",
    );
  }

  for (const entry of entries) {
    if (!isValidIpEntry(entry)) {
      throw new ConfigurationError(
        "HOMELABMD_PEER_ALLOWED_IPS",
        `contains an invalid IP address or CIDR block: "${entry}"`,
      );
    }
  }

  return entries;
}

function readUpdateCheck(env: Env): UpdateCheckMode {
  const raw = env.HOMELABMD_UPDATE_CHECK?.trim();
  if (raw === undefined || raw === "") return "github";
  if (raw === "github" || raw === "off") return raw;
  throw new ConfigurationError(
    "HOMELABMD_UPDATE_CHECK",
    `must be one of github, off; received "${raw}"`,
  );
}

function readUpdateChannel(env: Env): UpdateChannel {
  const raw = env.HOMELABMD_UPDATE_CHANNEL?.trim();
  if (raw === undefined || raw === "") return "stable";
  if (raw === "stable" || raw === "prerelease") return raw;
  throw new ConfigurationError(
    "HOMELABMD_UPDATE_CHANNEL",
    `must be one of stable, prerelease; received "${raw}"`,
  );
}

function readUpdateRepository(env: Env): string {
  const raw = readString(env, "HOMELABMD_UPDATE_REPOSITORY", "Kaquely/RackDeck");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
    throw new ConfigurationError(
      "HOMELABMD_UPDATE_REPOSITORY",
      `must be a GitHub owner/repository pair; received "${raw}"`,
    );
  }
  return raw;
}

/**
 * Build the configuration from an environment map.
 *
 * The environment is a parameter rather than a direct read of `process.env` so tests can
 * exercise every default and every failure without mutating global process state.
 */
export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): Config {
  const nodeEnv = readNodeEnv(env);
  const role = readRole(env);

  const dataDir = path.resolve(cwd, readString(env, "HOMELABMD_DATA_DIR", "data"));

  const layoutFileName = readString(env, "HOMELABMD_LAYOUT_FILE", "layout.json");
  if (path.basename(layoutFileName) !== layoutFileName) {
    throw new ConfigurationError(
      "HOMELABMD_LAYOUT_FILE",
      "must be a file name without a directory component",
    );
  }

  const peersFileName = readString(env, "HOMELABMD_PEERS_FILE", "peers.json");
  if (path.basename(peersFileName) !== peersFileName) {
    throw new ConfigurationError(
      "HOMELABMD_PEERS_FILE",
      "must be a file name without a directory component",
    );
  }

  const rawPeerToken = readOptional(env, "HOMELABMD_PEER_TOKEN");
  const rawPeerAllowedIps = readOptional(env, "HOMELABMD_PEER_ALLOWED_IPS");
  const rawPeerId = readOptional(env, "HOMELABMD_PEER_ID");

  if (role === "main") {
    // These settings describe a peer. Accepting them on a main node would imply a protection
    // or an identity the process does not use, so reject the configuration instead.
    for (const [variable, value] of [
      ["HOMELABMD_PEER_TOKEN", rawPeerToken],
      ["HOMELABMD_PEER_ALLOWED_IPS", rawPeerAllowedIps],
      ["HOMELABMD_PEER_ID", rawPeerId],
    ] as const) {
      if (value !== null) {
        throw new ConfigurationError(variable, "is only valid when HOMELABMD_ROLE=peer");
      }
    }
  }

  let peerToken: string | null = null;
  if (role === "peer") {
    if (rawPeerToken === null) {
      throw new ConfigurationError("HOMELABMD_PEER_TOKEN", "is required when HOMELABMD_ROLE=peer");
    }
    if (!isPeerToken(rawPeerToken)) {
      throw new ConfigurationError(
        "HOMELABMD_PEER_TOKEN",
        "must be 32 random bytes encoded as hlp_ followed by 43 base64url characters",
      );
    }
    peerToken = rawPeerToken;
  }

  return {
    nodeEnv,
    host: readString(env, "HOMELABMD_HOST", "0.0.0.0"),
    port: readInteger(env, "PORT", 3000, { min: 1, max: 65535 }),
    metricsIntervalMs: readInteger(env, "HOMELABMD_METRICS_INTERVAL_MS", 500, {
      min: 100,
      max: 60_000,
    }),
    historyLength: readInteger(env, "HOMELABMD_HISTORY_LENGTH", 600, { min: 10, max: 100_000 }),
    dataDir,
    layoutFile: path.join(dataDir, layoutFileName),
    peersFile: path.join(dataDir, peersFileName),
    staticDir: path.resolve(cwd, readString(env, "HOMELABMD_STATIC_DIR", "dist/web")),
    jsonBodyLimit: readString(env, "HOMELABMD_JSON_BODY_LIMIT", "256kb"),
    role,
    peerToken,
    peerAllowedIps: role === "peer" ? readPeerAllowedIps(env) : null,
    peerId: role === "peer" ? readPeerId(env) : null,
    updateCheck: readUpdateCheck(env),
    updateCheckIntervalMs: readInteger(env, "HOMELABMD_UPDATE_CHECK_INTERVAL_MS", 21_600_000, {
      // A minimum of one second keeps tests fast without letting a typo hammer GitHub.
      min: 1_000,
      max: 7 * 24 * 60 * 60 * 1000,
    }),
    updateChannel: readUpdateChannel(env),
    updateRepository: readUpdateRepository(env),
  };
}

/**
 * The settings that may be exposed over HTTP.
 *
 * This is an explicit allow-list rather than a projection of the loaded configuration, so
 * adding a field to `Config` cannot leak a credential by default. The safe behaviour is the
 * default behaviour.
 */
export function publicConfig(config: Config): {
  metricsIntervalMs: number;
  historyLength: number;
  dataDir: string;
} {
  return {
    metricsIntervalMs: config.metricsIntervalMs,
    historyLength: config.historyLength,
    dataDir: config.dataDir,
  };
}
