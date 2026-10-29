import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PiholePayloadError,
  cumulativeCounters,
  normaliseSummary,
  normaliseTables,
  toMetrics,
} from "../../src/server/integrations/pihole/normalize.ts";

/**
 * Captured payload shapes.
 *
 * Pi-hole v5 wraps everything in `{ data }` and spells counters `total_queries` /
 * `ads_blocked_today`; v6 returns the object directly and nests them under `queries`, `clients`
 * and `gravity` with different names entirely. Both are real fixtures, trimmed to the fields the
 * product reads, so that supporting both versions is a tested fact rather than an intention.
 */

const V5_SUMMARY = {
  data: {
    total_queries: 12_345,
    cached_queries: 3_000,
    forwarded_queries: 9_000,
    blocked_queries: 345,
    ads_blocked_today: 345,
    dns_queries_today: 12_345,
    percent_blocked: 2.8,
    unique_domains: 500,
    domains_being_blocked: 123_456,
    unique_clients: 7,
    clients_ever_seen: 9,
  },
  took: 0.001,
  status: "ok",
};

const V6_SUMMARY = {
  queries: {
    total: 12_345,
    cached: 3_000,
    forwarded: 9_000,
    blocked: 345,
    percent_blocked: 2.8,
    unique_domains: 500,
    types: { A: 1, AAAA: 2 },
    status: { FORWARDED: 9_000, CACHE: 3_000 },
    replies: { NXDOMAIN: 10, NODATA: 5 },
  },
  clients: { active: 7, total: 9 },
  gravity: { domains_being_blocked: 123_456, last_update: 1_700_000_000 },
};

describe("normaliseSummary", () => {
  it("reads the v5 shape", () => {
    assert.deepEqual(normaliseSummary(V5_SUMMARY), {
      queriesTotal: 12_345,
      queriesBlocked: 345,
      percentBlocked: 2.8,
      queriesCached: 3_000,
      queriesForwarded: 9_000,
      uniqueClients: 7,
      uniqueDomains: 500,
      gravityDomainsBlocked: 123_456,
    });
  });

  it("reads the v6 shape", () => {
    assert.deepEqual(normaliseSummary(V6_SUMMARY), {
      queriesTotal: 12_345,
      queriesBlocked: 345,
      percentBlocked: 2.8,
      queriesCached: 3_000,
      queriesForwarded: 9_000,
      uniqueClients: 7,
      uniqueDomains: 500,
      gravityDomainsBlocked: 123_456,
    });
  });

  it("produces the same model from both versions", () => {
    // The whole reason both are supported: a saved layout must render identically either way.
    assert.deepEqual(normaliseSummary(V5_SUMMARY), normaliseSummary(V6_SUMMARY));
  });

  it("reports a field missing from one shape as not measurable", () => {
    // v6 without `cached`. Zero would draw a confident flat line at the bottom of a chart that
    // means "the server did not say", not "the server cached nothing".
    const facts = normaliseSummary({ queries: { total: 10 } });

    assert.equal(facts.queriesTotal, 10);
    assert.equal(facts.queriesCached, null);
    assert.equal(facts.uniqueClients, null);
  });

  it("does not coerce a numeric string", () => {
    const facts = normaliseSummary({ queries: { total: "12345" } });

    assert.equal(facts.queriesTotal, null);
  });

  it("does not coerce NaN or Infinity", () => {
    const facts = normaliseSummary({
      queries: { total: Number.NaN, cached: Number.POSITIVE_INFINITY },
    });

    assert.equal(facts.queriesTotal, null);
    assert.equal(facts.queriesCached, null);
  });

  it("rejects a body that is not an object", () => {
    for (const payload of ["a string", 42, null, [], true]) {
      assert.throws(() => normaliseSummary(payload), PiholePayloadError);
    }
  });

  it("rejects an object matching neither shape", () => {
    assert.throws(
      () => normaliseSummary({ something: "else" }),
      (error: unknown) =>
        error instanceof PiholePayloadError &&
        /did not match the v5 or v6 shape/.test(error.message),
    );
  });

  it("rejects a login page served where the API was expected", () => {
    // The most likely real cause: the URL points at /admin and the application answers HTML.
    assert.throws(() => normaliseSummary({ message: "Invalid password" }), PiholePayloadError);
  });
});

describe("normaliseTables", () => {
  it("reads upstreams from the v6 shape", () => {
    const tables = normaliseTables(
      {
        upstreams: {
          upstreams: [
            { ip: "10.0.0.1", name: "dns.google", port: 53, count: 900 },
            { ip: "10.0.0.2", name: "", port: 53, count: 100 },
          ],
        },
        domains: undefined,
        clients: undefined,
      },
      10,
    );

    assert.deepEqual(tables.topUpstreams, {
      id: "dns.topUpstreams",
      columns: ["ip", "name", "port", "queries"],
      rows: [
        { ip: "10.0.0.1", name: "dns.google", port: 53, queries: 900 },
        { ip: "10.0.0.2", name: "", port: 53, queries: 100 },
      ],
    });
  });

  it("reads upstreams from the v5 shape", () => {
    const tables = normaliseTables(
      {
        upstreams: {
          data: {
            forward_destinations: [{ ip: "10.0.0.1", name: "dns.google", port: 53, count: 900 }],
          },
        },
        domains: undefined,
        clients: undefined,
      },
      10,
    );

    assert.deepEqual(tables.topUpstreams?.rows, [
      { ip: "10.0.0.1", name: "dns.google", port: 53, queries: 900 },
    ]);
  });

  it("honours the top-N limit", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      ip: `10.0.0.${index}`,
      name: "",
      port: 53,
      count: index,
    }));

    const tables = normaliseTables(
      { upstreams: { upstreams: rows }, domains: undefined, clients: undefined },
      5,
    );

    assert.equal(tables.topUpstreams?.rows.length, 5);
  });

  it("drops a row with no count rather than reporting zero", () => {
    const tables = normaliseTables(
      {
        upstreams: {
          upstreams: [
            { ip: "10.0.0.1", name: "a", port: 53 },
            { ip: "10.0.0.2", name: "b", port: 53, count: 5 },
          ],
        },
        domains: undefined,
        clients: undefined,
      },
      10,
    );

    assert.deepEqual(
      tables.topUpstreams?.rows.map((row) => row["ip"]),
      ["10.0.0.2"],
    );
  });

  it("reads domains and clients", () => {
    const tables = normaliseTables(
      {
        upstreams: undefined,
        domains: {
          domains: [
            { domain: "ads.example", count: 500 },
            { domain: "", count: 3 },
          ],
        },
        clients: { clients: [{ ip: "192.168.1.10", name: "laptop", count: 250 }] },
      },
      10,
    );

    assert.deepEqual(tables.topDomains?.rows, [{ domain: "ads.example", queries: 500 }]);
    assert.deepEqual(tables.topClients?.rows, [
      { ip: "192.168.1.10", name: "laptop", queries: 250 },
    ]);
  });

  it("returns null for an absent table rather than an empty one", () => {
    const tables = normaliseTables(
      { upstreams: undefined, domains: undefined, clients: undefined },
      10,
    );

    assert.equal(tables.topUpstreams, null);
    assert.equal(tables.topDomains, null);
    assert.equal(tables.topClients, null);
  });

  it("survives a table endpoint that answers with something unexpected", () => {
    const tables = normaliseTables(
      { upstreams: "<html>error</html>", domains: { unexpected: true }, clients: null },
      10,
    );

    assert.equal(tables.topUpstreams, null);
    assert.equal(tables.topDomains, null);
    assert.equal(tables.topClients, null);
  });
});

describe("toMetrics", () => {
  it("emits the documented metric keys in a stable order", () => {
    const facts = normaliseSummary(V6_SUMMARY);
    const metrics = toMetrics(facts, new Map());

    assert.deepEqual(
      metrics.map((metric) => metric.metric),
      [
        "dns.queriesTotal",
        "dns.queriesBlocked",
        "dns.percentBlocked",
        "dns.queriesCached",
        "dns.queriesForwarded",
        "dns.uniqueClients",
        "dns.uniqueDomains",
        "dns.gravityDomainsBlocked",
        "dns.queryRate",
        "dns.blockedRate",
      ],
    );
  });

  it("carries the units a chart needs", () => {
    const metrics = toMetrics(normaliseSummary(V6_SUMMARY), new Map());
    const units = Object.fromEntries(metrics.map((metric) => [metric.metric, metric.unit]));

    assert.equal(units["dns.percentBlocked"], "%");
    assert.equal(units["dns.queryRate"], "q/s");
    assert.equal(units["dns.queriesTotal"], "");
  });

  it("carries the same metric keys from both versions", () => {
    const v5 = toMetrics(normaliseSummary(V5_SUMMARY), new Map());
    const v6 = toMetrics(normaliseSummary(V6_SUMMARY), new Map());

    assert.deepEqual(
      v5.map((metric) => [metric.metric, metric.label, metric.unit, metric.value]),
      v6.map((metric) => [metric.metric, metric.label, metric.unit, metric.value]),
    );
  });

  it("reports a rate as null when none was derived", () => {
    const metrics = toMetrics(normaliseSummary(V6_SUMMARY), new Map());

    assert.equal(metrics.find((metric) => metric.metric === "dns.queryRate")?.value, null);
  });

  it("uses a derived rate when one exists", () => {
    const facts = normaliseSummary(V6_SUMMARY);
    const metrics = toMetrics(facts, new Map([["dns.queriesTotal", 42]]));

    assert.equal(metrics.find((metric) => metric.metric === "dns.queryRate")?.value, 42);
  });
});

describe("cumulativeCounters", () => {
  it("exposes only the counters a rate can be derived from", () => {
    const counters = cumulativeCounters(normaliseSummary(V6_SUMMARY));

    assert.deepEqual(
      [...counters.keys()],
      [
        "dns.queriesTotal",
        "dns.queriesBlocked",
        "dns.queriesCached",
        "dns.queriesForwarded",
        "dns.uniqueDomains",
      ],
    );
  });

  it("does not derive a rate from a percentage", () => {
    // `percent_blocked` is derived by Pi-hole from two other counters; differencing it would
    // produce a rate of a ratio, which is meaningless.
    const counters = cumulativeCounters(normaliseSummary(V6_SUMMARY));

    assert.equal(counters.has("dns.percentBlocked"), false);
  });

  it("carries nulls through so an absent counter stays absent", () => {
    const counters = cumulativeCounters(normaliseSummary({ queries: { total: 5 } }));

    assert.equal(counters.get("dns.queriesTotal"), 5);
    assert.equal(counters.get("dns.queriesCached"), null);
  });
});
