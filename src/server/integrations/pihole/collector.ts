import type { Collector, CollectorResult } from "../../collectors/types.ts";
import type { TableData } from "../../../shared/observations.ts";
import { HttpJsonReader, IntegrationError } from "../http-json-reader.ts";
import { RateDeriver } from "../rate-deriver.ts";
import type { PiholeConfig } from "../../../config/integrations.ts";
import { cumulativeCounters, normaliseSummary, normaliseTables, toMetrics } from "./normalize.ts";
import { PIHOLE_PASSWORD_VARIABLE, establishSession } from "./session.ts";

/**
 * Pi-hole as an observed system.
 *
 * Pi-hole v6 has no unauthenticated read path, so this collector holds the session cookie for the
 * lifetime of the process and only re-authenticates when the application says the session is no
 * longer valid. Two cycles of a healthy deployment produce exactly one authentication request.
 *
 * It also does not poll four endpoints at the 500 ms cadence. The top-N tables are refetched on
 * their own, slower interval, because Pi-hole answers them from its query database and this
 * dashboard shares a node with the DNS server it is watching. Polling harder would make the
 * monitoring tool a load on the monitored system.
 */

export const PIHOLE_SOURCE_ID = "pihole";

export type PiholeCollectorDeps = {
  fetchFn?: typeof fetch;
  /** Injectable so tests can drive the rate derivation without real elapsed time. */
  now?: () => number;
};

/** Pi-hole answers 401, and some proxies answer 403, for an absent or stale session. */
function isAuthChallenge(error: unknown): boolean {
  return (
    error instanceof IntegrationError &&
    error.reason === "status" &&
    (error.status === 401 || error.status === 403)
  );
}

export function createPiholeCollector(
  config: PiholeConfig,
  deps: PiholeCollectorDeps = {},
): Collector {
  const now = deps.now ?? (() => Date.now());
  const reader = new HttpJsonReader({
    baseUrl: config.url,
    timeoutMs: config.timeoutMs,
    fetchFn: deps.fetchFn,
  });

  const rates = new RateDeriver();
  /** Set once a session exists. Empty string means "authenticated, but sessionless". */
  let cookie: string | null = null;

  let lastTables: TableData[] = [];
  let lastTablesAt: number | null = null;

  /**
   * Read one endpoint, authenticating and retrying once if the application says the session is
   * no good. Retried exactly once: a second failure is reported, not retried into a loop.
   */
  async function read(path: string): Promise<unknown> {
    const withCookie = async (): Promise<unknown> =>
      reader.getJson(path, cookie === null || cookie === "" ? {} : { headers: { cookie } });

    try {
      return await withCookie();
    } catch (error) {
      if (!isAuthChallenge(error)) throw error;

      if (config.password === null) {
        // No password is a valid configuration — a Pi-hole with authentication disabled is read
        // without one — so this only happens when the deployment does require a password.
        throw new IntegrationError(
          "auth",
          `Pi-hole requires authentication but no password is configured; set ${PIHOLE_PASSWORD_VARIABLE}`,
          401,
        );
      }

      const sid = await establishSession({
        baseUrl: config.url,
        password: config.password,
        timeoutMs: config.timeoutMs,
        fetchFn: deps.fetchFn,
      });
      cookie = sid === null ? "" : `sid=${sid}`;

      if (sid === null) {
        // The deployment authenticated us but issued no cookie, so retrying the same request
        // would just fail the same way. Report the original challenge.
        throw new IntegrationError(
          "auth",
          `Pi-hole accepted the password but issued no session; check that the API is reachable at ${reader.baseUrl}`,
          401,
        );
      }

      return await withCookie();
    }
  }

  /** Refetch the top-N tables only when their interval has elapsed. */
  async function readTables(at: number): Promise<TableData[]> {
    if (lastTablesAt !== null && at - lastTablesAt < config.tablesIntervalMs) {
      return lastTables;
    }

    const query = `?N=${config.topN}`;
    const payloads = await Promise.allSettled([
      read("api/stats/upstreams"),
      read(`api/stats/domains${query}`),
      read(`api/stats/clients${query}`),
    ]);

    const [upstreams, domains, clients] = payloads;
    const normalised = normaliseTables(
      {
        upstreams: upstreams.status === "fulfilled" ? upstreams.value : undefined,
        domains: domains.status === "fulfilled" ? domains.value : undefined,
        clients: clients.status === "fulfilled" ? clients.value : undefined,
      },
      config.topN,
    );

    const tables = [normalised.topUpstreams, normalised.topDomains, normalised.topClients].filter(
      (table): table is TableData => table !== null,
    );

    // A table that failed is simply absent; the metrics still update. Reporting "degraded"
    // rather than failing the whole source keeps a transient table failure from blanking the
    // charts, which are the reason anyone is looking at this widget.
    if (payloads.some((result) => result.status === "rejected")) {
      lastTablesAt = at;
      return tables.length > 0 ? tables : lastTables;
    }

    lastTables = tables;
    lastTablesAt = at;
    return tables;
  }

  return {
    id: PIHOLE_SOURCE_ID,
    label: config.label,
    kind: "pihole",

    async collect(): Promise<CollectorResult> {
      const at = now();

      // The summary is the only thing that can fail the source: without it there are no metrics
      // at all, and an empty widget is the correct thing to show.
      const summary = await read("api/stats/summary");
      const facts = normaliseSummary(summary);
      const ratesNow = rates.compute(cumulativeCounters(facts), at);

      const tables = await readTables(at);

      return {
        status: "ok",
        metrics: toMetrics(facts, ratesNow),
        tables,
      };
    },
  };
}
