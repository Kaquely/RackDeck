import type { MetricSample } from "../../collectors/types.ts";
import type { TableData } from "../../../shared/observations.ts";

/**
 * Pi-hole payloads into the product's own model.
 *
 * Everything here is a pure function of its input. No network, no clock, no configuration. That
 * is deliberate: this is where all the interesting logic lives — two upstream API shapes, absent
 * fields, unrecognised bodies — and keeping it pure means it is tested against captured
 * fixtures instead of against a Pi-hole nobody here has.
 *
 * A widget never sees a vendor key. `dns.queriesBlocked` means the same thing whichever
 * version of Pi-hole produced it.
 */

/** The facts the product cares about, before they become metrics. */
export type PiholeFacts = {
  queriesTotal: number | null;
  queriesBlocked: number | null;
  percentBlocked: number | null;
  queriesCached: number | null;
  queriesForwarded: number | null;
  uniqueClients: number | null;
  uniqueDomains: number | null;
  gravityDomainsBlocked: number | null;
};

export type PiholeTables = {
  topUpstreams: TableData | null;
  topDomains: TableData | null;
  topClients: TableData | null;
};

export class PiholePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiholePayloadError";
  }
}

/** A finite number, or null. Never coerces: a string "12" is a schema problem, not a number. */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pi-hole v5 wraps every response in `{ data, took, status }`.
 *
 * v6 returns the object directly. Unwrapping a non-`data` key would be wrong for v6, whose
 * payload genuinely has no `data` property, so the unwrap only happens when `data` is present
 * and is an object.
 */
function unwrap(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const outer = payload as Record<string, unknown>;
  const inner = outer["data"];
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return outer;
}

/**
 * Read the daily counters, from either API shape.
 *
 * A field that exists in neither shape is `null`, never zero. A Pi-hole that does not report
 * cached queries has not cached zero queries; it has not said, and reporting 0 would draw a
 * confident flat line at the bottom of a chart that means nothing.
 */
export function normaliseSummary(payload: unknown): PiholeFacts {
  const body = unwrap(payload);
  if (body === null) {
    throw new PiholePayloadError("Pi-hole summary was not a JSON object");
  }

  // v6 nests counters under `queries`, `clients` and `gravity`.
  const v6Queries = asRecord(body["queries"]);
  if (v6Queries !== null) {
    const v6Clients = asRecord(body["clients"]) ?? {};
    const v6Gravity = asRecord(body["gravity"]) ?? {};

    return {
      queriesTotal: numberOrNull(v6Queries["total"]),
      queriesBlocked: numberOrNull(v6Queries["blocked"]),
      percentBlocked: numberOrNull(v6Queries["percent_blocked"]),
      queriesCached: numberOrNull(v6Queries["cached"]),
      queriesForwarded: numberOrNull(v6Queries["forwarded"]),
      uniqueClients: numberOrNull(v6Clients["active"]),
      uniqueDomains: numberOrNull(v6Queries["unique_domains"]),
      gravityDomainsBlocked: numberOrNull(v6Gravity["domains_being_blocked"]),
    };
  }

  // v5 keeps them at the top level, under two different spellings per counter.
  const hasV5Key =
    "total_queries" in body ||
    "dns_queries_today" in body ||
    "ads_blocked_today" in body ||
    "blocked_queries" in body;
  if (!hasV5Key) {
    throw new PiholePayloadError(
      "Pi-hole summary did not match the v5 or v6 shape; is the URL pointing at /admin?",
    );
  }

  return {
    queriesTotal: numberOrNull(body["total_queries"]) ?? numberOrNull(body["dns_queries_today"]),
    queriesBlocked:
      numberOrNull(body["ads_blocked_today"]) ?? numberOrNull(body["blocked_queries"]),
    percentBlocked: numberOrNull(body["percent_blocked"]),
    queriesCached: numberOrNull(body["cached_queries"]),
    queriesForwarded: numberOrNull(body["forwarded_queries"]),
    uniqueClients: numberOrNull(body["unique_clients"]),
    uniqueDomains: numberOrNull(body["unique_domains"]),
    gravityDomainsBlocked: numberOrNull(body["domains_being_blocked"]),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Turn one upstream list into a table, from either shape.
 *
 * v6 calls the array `upstreams`, v5 `forward_destinations`. Each row keeps the same column
 * set either way, so a saved layout renders identically against both.
 */
function normaliseUpstreams(payload: unknown, topN: number): TableData | null {
  const body = unwrap(payload);
  if (body === null) return null;

  const rows = body["upstreams"] ?? body["forward_destinations"];
  if (!Array.isArray(rows)) return null;

  return {
    id: "dns.topUpstreams",
    columns: ["ip", "name", "port", "queries"],
    rows: rows.slice(0, topN).flatMap((entry) => {
      const row = asRecord(entry);
      if (row === null) return [];
      const count = numberOrNull(row["count"]);
      if (count === null) return [];
      return [
        {
          ip: text(row["ip"]),
          // v6 sets an empty name for an upstream it could not resolve; showing blank is
          // better than inventing a name from the IP.
          name: text(row["name"]),
          port: numberOrNull(row["port"]) ?? 0,
          queries: count,
        },
      ];
    }),
  };
}

/** Top queried domains. The array key is `domains` in both shapes. */
function normaliseDomains(payload: unknown, topN: number): TableData | null {
  const body = unwrap(payload);
  if (body === null) return null;

  const rows = body["domains"];
  if (!Array.isArray(rows)) return null;

  return {
    id: "dns.topDomains",
    columns: ["domain", "queries"],
    rows: rows.slice(0, topN).flatMap((entry) => {
      const row = asRecord(entry);
      if (row === null) return [];
      const domain = text(row["domain"]);
      const count = numberOrNull(row["count"]);
      if (domain.length === 0 || count === null) return [];
      return [{ domain, queries: count }];
    }),
  };
}

/** Top clients by query count. */
function normaliseClients(payload: unknown, topN: number): TableData | null {
  const body = unwrap(payload);
  if (body === null) return null;

  const rows = body["clients"];
  if (!Array.isArray(rows)) return null;

  return {
    id: "dns.topClients",
    columns: ["ip", "name", "queries"],
    rows: rows.slice(0, topN).flatMap((entry) => {
      const row = asRecord(entry);
      if (row === null) return [];
      const count = numberOrNull(row["count"]);
      if (count === null) return [];
      return [
        {
          ip: text(row["ip"]),
          name: text(row["name"]),
          queries: count,
        },
      ];
    }),
  };
}

export function normaliseTables(
  payloads: {
    upstreams: unknown;
    domains: unknown;
    clients: unknown;
  },
  topN: number,
): PiholeTables {
  return {
    topUpstreams: normaliseUpstreams(payloads.upstreams, topN),
    topDomains: normaliseDomains(payloads.domains, topN),
    topClients: normaliseClients(payloads.clients, topN),
  };
}

/**
 * The cumulative counters a rate can be derived from.
 *
 * Returning the mapping as data rather than emitting metrics keeps the rate derivation a pure
 * function that can be tested against hand-built sequences.
 */
export function cumulativeCounters(facts: PiholeFacts): Map<string, number | null> {
  return new Map<string, number | null>([
    ["dns.queriesTotal", facts.queriesTotal],
    ["dns.queriesBlocked", facts.queriesBlocked],
    ["dns.queriesCached", facts.queriesCached],
    ["dns.queriesForwarded", facts.queriesForwarded],
    ["dns.uniqueDomains", facts.uniqueDomains],
  ]);
}

/** The facts as product metrics, in a stable order so charts and tests agree. */
export function toMetrics(
  facts: PiholeFacts,
  rates: ReadonlyMap<string, number | null>,
): MetricSample[] {
  const row = (
    metric: string,
    label: string,
    unit: string,
    value: number | null,
  ): MetricSample => ({ metric, label, unit, value });

  return [
    row("dns.queriesTotal", "DNS queries today", "", facts.queriesTotal),
    row("dns.queriesBlocked", "Queries blocked today", "", facts.queriesBlocked),
    row("dns.percentBlocked", "Percent blocked", "%", facts.percentBlocked),
    row("dns.queriesCached", "Cached queries", "", facts.queriesCached),
    row("dns.queriesForwarded", "Forwarded queries", "", facts.queriesForwarded),
    row("dns.uniqueClients", "Unique clients", "", facts.uniqueClients),
    row("dns.uniqueDomains", "Unique domains", "", facts.uniqueDomains),
    row("dns.gravityDomainsBlocked", "Gravity domains", "", facts.gravityDomainsBlocked),
    // The per-second rate is what an operator actually watches; the cumulative counters above
    // are context for it.
    row("dns.queryRate", "Queries per second", "q/s", rates.get("dns.queriesTotal") ?? null),
    row("dns.blockedRate", "Blocked per second", "q/s", rates.get("dns.queriesBlocked") ?? null),
  ];
}
