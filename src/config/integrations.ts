import { readInteger, readString } from "./environment.ts";
import type { Env } from "./environment.ts";
import { ConfigurationError } from "./environment.ts";

/**
 * Configuration for the third-party integrations.
 *
 * Kept separate from the core configuration because it is optional and because it is the only
 * place a secret exists. Nothing here reaches `publicConfig`, which is an allow-list, so a
 * credential cannot be exposed by adding a field to this file.
 *
 * An integration is enabled by setting its endpoint. There is no `enabled` flag: a flag that
 * says `false` while an endpoint is set is a contradiction nobody needs to debug.
 */

export type PiholeConfig = {
  /** Base URL of the Pi-hole HTTP API, already normalised. */
  url: string;
  /**
   * Application password, or null when the operator has none.
   *
   * A secret. Never logged, never exposed over HTTP, never included in an error message.
   */
  password: string | null;
  timeoutMs: number;
  /** How many rows each top-N table reports. */
  topN: number;
  /**
   * How often the top-N tables are refetched.
   *
   * Deliberately much slower than the 500 ms collection cadence. Pi-hole answers these endpoints
   * from its own query database, and the dashboard runs on the same small node as the DNS server
   * it is watching. Polling four endpoints eight times a second to refresh a list that changes
   * slowly would be the dashboard harming the system it observes.
   */
  tablesIntervalMs: number;
  /** Shown in the dashboard header. */
  label: string;
};

export type IntegrationConfig = {
  /** null when the operator configured no integration. */
  pihole: PiholeConfig | null;
};

export const EMPTY_INTEGRATIONS: IntegrationConfig = { pihole: null };

/**
 * Read a value that may legitimately be absent or blank.
 *
 * `readString` treats a blank value as a configuration error, which is right for a required
 * value and wrong here: an operator who leaves `HOMELABMD_PIHOLE_PASSWORD=` empty means "no
 * password", not "misconfigured".
 */
function readOptional(env: Env, variable: string): string | null {
  const raw = env[variable];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseUrl(raw: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(
      variable,
      `must be an absolute URL, received "${raw}". Example: http://pihole.lan:8080`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(
      variable,
      `must be an http or https URL including a scheme, received the "${parsed.protocol.replace(":", "")}" scheme from "${raw}". Example: http://pihole.lan:8080`,
    );
  }
  return raw;
}

export function loadIntegrations(env: Env = process.env): IntegrationConfig {
  const url = readOptional(env, "HOMELABMD_PIHOLE_URL");

  if (url === null) {
    return EMPTY_INTEGRATIONS;
  }

  const timeoutMs = readInteger(env, "HOMELABMD_PIHOLE_TIMEOUT_MS", 5_000, {
    min: 100,
    max: 60_000,
  });
  const topN = readInteger(env, "HOMELABMD_PIHOLE_TOP_N", 10, { min: 1, max: 100 });
  const tablesIntervalMs = readInteger(env, "HOMELABMD_PIHOLE_TABLES_INTERVAL_MS", 10_000, {
    min: 1_000,
    max: 600_000,
  });
  const label = readString(env, "HOMELABMD_PIHOLE_LABEL", "Pi-hole");

  return {
    pihole: {
      url: parseUrl(url, "HOMELABMD_PIHOLE_URL"),
      password: readOptional(env, "HOMELABMD_PIHOLE_PASSWORD"),
      timeoutMs,
      topN,
      tablesIntervalMs,
      label,
    },
  };
}
