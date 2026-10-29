import type { Collector } from "../collectors/types.ts";
import type { IntegrationConfig } from "../../config/integrations.ts";
import { createPiholeCollector } from "./pihole/collector.ts";
import { redactUrl } from "./http-json-reader.ts";

/**
 * The integration framework's entry point.
 *
 * Adding a second application is meant to be a one-line change here plus its own normalizer and
 * collector. That is the whole point of building Pi-hole this way, and it is worth keeping this
 * file boring so the second integration has somewhere obvious to go.
 */

export type IntegrationDeps = {
  fetchFn?: typeof fetch;
  now?: () => number;
};

export function createIntegrationCollectors(
  config: IntegrationConfig,
  deps: IntegrationDeps = {},
): Collector[] {
  const collectors: Collector[] = [];

  if (config.pihole !== null) {
    collectors.push(createPiholeCollector(config.pihole, deps));
  }

  return collectors;
}

/**
 * A log-safe description of what is configured.
 *
 * Reports whether a credential is *present*, never anything about it. An operator needs to know
 * why a source is not authenticating; they do not need the password echoed into a log file that
 * will be pasted into an issue.
 */
export function describeIntegrations(config: IntegrationConfig): string {
  if (config.pihole === null) return "none";
  const pihole = config.pihole;
  return [
    `pihole at ${redactUrl(pihole.url)}`,
    `timeout ${pihole.timeoutMs}ms`,
    `top ${pihole.topN}`,
    `tables every ${pihole.tablesIntervalMs}ms`,
    `password ${pihole.password === null ? "not set" : "set"}`,
  ].join(", ");
}
