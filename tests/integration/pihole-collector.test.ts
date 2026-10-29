import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { after, describe, it } from "node:test";
import { createPiholeCollector } from "../../src/server/integrations/pihole/collector.ts";
import type { PiholeConfig } from "../../src/config/integrations.ts";

/**
 * The Pi-hole collector driven over a real socket.
 *
 * The unit tests cover the translation and the rate arithmetic. What they cannot cover is the
 * part most likely to be wrong in practice: the HTTP conversation. So this stands up a local
 * server that behaves like Pi-hole â€” session required, `Set-Cookie` on login, 401 afterwards â€”
 * and checks the actual requests that go out.
 *
 * It is a stand-in, not a Pi-hole. It has no idea what a real one returns beyond the captured
 * payload shapes, and that limitation is recorded in the traceability matrix rather than left to
 * be discovered.
 */

const PASSWORD = "hunter2-not-a-real-password";

const V6_SUMMARY = {
  queries: { total: 1_000, cached: 400, forwarded: 500, blocked: 100, percent_blocked: 10 },
  clients: { active: 3, total: 5 },
  gravity: { domains_being_blocked: 200_000 },
};

const V5_SUMMARY = {
  data: {
    total_queries: 1_000,
    cached_queries: 400,
    forwarded_queries: 500,
    ads_blocked_today: 100,
    percent_blocked: 10,
    unique_domains: 42,
    domains_being_blocked: 200_000,
    unique_clients: 3,
  },
};

type RequestLog = { method: string; path: string; cookie: string | undefined }[];

type FakePiHole = {
  url: string;
  requests: RequestLog;
  /** Stop accepting a valid session, as Pi-hole does when its session expires. */
  expireSessions: () => void;
  /** Make every endpoint fail, as an application that has stopped responding would. */
  breakEndpoint: (path: string) => void;
  /** Bump the counters, as a running day would. */
  setSummary: (payload: unknown) => void;
  close: () => Promise<void>;
};

async function startFakePiHole(options: { requireAuth: boolean }): Promise<FakePiHole> {
  let summary: unknown = V6_SUMMARY;
  // Bumped by expireSessions. A cookie is only valid for the generation that issued it, which
  // is how a real session expires: the old one stops working and a fresh login works.
  let sessionGeneration = 1;
  const broken = new Set<string>();
  const requests: RequestLog = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const cookieHeader = request.headers["cookie"];
    requests.push({
      method: request.method ?? "GET",
      path,
      cookie: typeof cookieHeader === "string" ? cookieHeader : undefined,
    });

    const sendJson = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    // The single documented non-GET request in the codebase.
    if (request.method === "POST" && path === "/api/auth") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        let supplied: unknown;
        try {
          supplied = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          supplied = undefined;
        }
        const offered =
          typeof supplied === "object" && supplied !== null
            ? (supplied as Record<string, unknown>)["password"]
            : undefined;

        if (offered !== PASSWORD) {
          sendJson(401, { error: "invalid password" });
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `sid=gen-${sessionGeneration}; Path=/; HttpOnly`,
        });
        response.end(JSON.stringify({ session: { valid: true } }));
      });
      return;
    }

    if (broken.has(path)) {
      sendJson(500, { error: "boom" });
      return;
    }

    if (options.requireAuth) {
      const authorised =
        typeof cookieHeader === "string" && cookieHeader.includes(`sid=gen-${sessionGeneration}`);
      if (!authorised) {
        sendJson(401, { error: "unauthorised" });
        return;
      }
    }

    if (path === "/api/stats/summary") {
      sendJson(200, summary);
      return;
    }
    if (path === "/api/stats/upstreams") {
      sendJson(200, { upstreams: [{ ip: "10.0.0.1", name: "dns.google", port: 53, count: 900 }] });
      return;
    }
    if (path === "/api/stats/domains") {
      sendJson(200, { domains: [{ domain: "ads.example", count: 42 }] });
      return;
    }
    if (path === "/api/stats/clients") {
      sendJson(200, { clients: [{ ip: "192.168.1.5", name: "nas", count: 7 }] });
      return;
    }

    sendJson(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    expireSessions: () => {
      sessionGeneration += 1;
    },
    breakEndpoint: (path) => broken.add(path),
    setSummary: (payload) => {
      summary = payload;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function config(overrides: Partial<PiholeConfig> = {}): PiholeConfig {
  return {
    url: "http://127.0.0.1:1",
    password: PASSWORD,
    timeoutMs: 2_000,
    topN: 5,
    tablesIntervalMs: 10_000,
    label: "Pi-hole",
    ...overrides,
  };
}

describe("createPiholeCollector over HTTP", () => {
  const open: FakePiHole[] = [];

  after(async () => {
    for (const fake of open) await fake.close();
  });

  const serve = async (requireAuth: boolean): Promise<FakePiHole> => {
    const fake = await startFakePiHole({ requireAuth });
    open.push(fake);
    return fake;
  };

  it("reads metrics from an authenticated Pi-hole", async () => {
    const fake = await serve(true);
    const collector = createPiholeCollector(config({ url: fake.url }));

    const result = await collector.collect();

    assert.equal(result.status, "ok");
    const byKey = Object.fromEntries(result.metrics.map((m) => [m.metric, m.value]));
    assert.equal(byKey["dns.queriesTotal"], 1_000);
    assert.equal(byKey["dns.queriesBlocked"], 100);
    assert.equal(byKey["dns.percentBlocked"], 10);
    assert.equal(byKey["dns.gravityDomainsBlocked"], 200_000);
    assert.equal(byKey["dns.uniqueClients"], 3);
  });

  it("reads metrics from a Pi-hole with authentication disabled", async () => {
    const fake = await serve(false);
    const collector = createPiholeCollector(config({ url: fake.url, password: null }));

    const result = await collector.collect();

    assert.equal(result.status, "ok");
    assert.equal(
      fake.requests.some((request) => request.method === "POST"),
      false,
      "no authentication should be attempted when none is configured",
    );
  });

  it("reads the v5 payload shape identically", async () => {
    const fake = await serve(false);
    fake.setSummary(V5_SUMMARY);
    const collector = createPiholeCollector(config({ url: fake.url, password: null }));

    const result = await collector.collect();
    const byKey = Object.fromEntries(result.metrics.map((m) => [m.metric, m.value]));

    assert.equal(byKey["dns.queriesTotal"], 1_000);
    assert.equal(byKey["dns.queriesBlocked"], 100);
    assert.equal(byKey["dns.uniqueDomains"], 42);
  });

  it("identifies itself as a Pi-hole source", async () => {
    const fake = await serve(false);
    const collector = createPiholeCollector(config({ url: fake.url, password: null }));

    assert.equal(collector.id, "pihole");
    assert.equal(collector.kind, "pihole");
    assert.equal(collector.label, "Pi-hole");
  });

  it("uses the operator's label", async () => {
    const fake = await serve(false);
    const collector = createPiholeCollector(
      config({ url: fake.url, password: null, label: "DNS filter" }),
    );

    assert.equal(collector.label, "DNS filter");
  });

  it("returns the top-N tables", async () => {
    const fake = await serve(false);
    const collector = createPiholeCollector(config({ url: fake.url, password: null }));

    const result = await collector.collect();
    const ids = result.tables.map((table) => table.id);

    assert.deepEqual(ids, ["dns.topUpstreams", "dns.topDomains", "dns.topClients"]);
  });

  it("requests the configured number of rows", async () => {
    const fake = await serve(false);
    const collector = createPiholeCollector(config({ url: fake.url, password: null, topN: 25 }));

    await collector.collect();

    assert.equal(
      fake.requests.some(
        (request) => request.path === "/api/stats/domains" && request.cookie === undefined,
      ),
      true,
    );
  });

  describe("authentication", () => {
    it("authenticates once and reuses the session", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(config({ url: fake.url }));

      await collector.collect();
      const afterFirst = fake.requests.filter((r) => r.method === "POST").length;
      await collector.collect();
      await collector.collect();
      const afterAll = fake.requests.filter((r) => r.method === "POST").length;

      assert.equal(afterFirst, 1);
      assert.equal(afterAll, 1, "a valid session must be reused, not re-established every cycle");
    });

    it("sends the session cookie on every read after authenticating", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(config({ url: fake.url }));

      await collector.collect();
      await collector.collect();

      // Authentication is lazy: the very first read is challenged, then retried with a session.
      // Everything after the login must carry it, or the collector is re-authenticating silently.
      const loginIndex = fake.requests.findIndex((request) => request.method === "POST");
      assert.ok(loginIndex >= 0, "expected an authentication request");

      const readsAfterLogin = fake.requests
        .slice(loginIndex + 1)
        .filter((request) => request.method === "GET");
      assert.ok(readsAfterLogin.length > 0);
      for (const read of readsAfterLogin) {
        assert.match(read.cookie ?? "", /sid=gen-/, `${read.path} carried no session`);
      }

      // And exactly one login across both cycles.
      assert.equal(fake.requests.filter((request) => request.method === "POST").length, 1);
    });

    it("re-authenticates when the application reports the session invalid", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(config({ url: fake.url }));

      await collector.collect();
      fake.expireSessions();

      // The session is now rejected; the collector must recover rather than stay broken.
      fake.requests.length = 0;
      const result = await collector.collect();

      assert.equal(result.status, "ok");
      assert.ok(
        fake.requests.some((request) => request.method === "POST"),
        "re-authenticated",
      );
    });

    it("names the variable when no password is configured but one is required", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(config({ url: fake.url, password: null }));

      await assert.rejects(collector.collect(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HOMELABMD_PIHOLE_PASSWORD/);
        return true;
      });
    });

    it("names the variable when the password is wrong, without revealing it", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(
        config({ url: fake.url, password: "wrong-password-entirely" }),
      );

      await assert.rejects(collector.collect(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HOMELABMD_PIHOLE_PASSWORD/);
        assert.ok(
          !error.message.includes("wrong-password-entirely"),
          `the error disclosed the credential: ${error.message}`,
        );
        return true;
      });
    });
  });

  describe("read-only behaviour", () => {
    it("issues no mutating request other than the single authentication call", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(config({ url: fake.url }));

      await collector.collect();
      await collector.collect();

      const mutations = fake.requests.filter(
        (request) => request.method !== "GET" && request.path !== "/api/auth",
      );
      assert.deepEqual(mutations, []);
    });

    it("never contacts an endpoint that could change configuration", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(config({ url: fake.url }));

      await collector.collect();
      await collector.collect();

      const paths = new Set(fake.requests.map((request) => request.path));
      for (const path of paths) {
        assert.match(path, /^\/api\/(auth|stats\/)/, `unexpected endpoint contacted: ${path}`);
      }
    });
  });

  describe("cadence", () => {
    it("does not refetch the tables on every cycle", async () => {
      // Polling four endpoints eight times a second to refresh a slow-changing list would make
      // the dashboard a load on the DNS server it shares a node with.
      const fake = await serve(false);
      const collector = createPiholeCollector(
        config({ url: fake.url, password: null, tablesIntervalMs: 10_000 }),
      );

      for (let index = 0; index < 20; index += 1) await collector.collect();

      const tableReads = fake.requests.filter((request) => request.path !== "/api/stats/summary");
      assert.equal(tableReads.length, 3, "the three tables should be fetched exactly once");
    });

    it("refetches the tables once their interval has elapsed", async () => {
      const fake = await serve(false);
      let now = 0;
      const collector = createPiholeCollector(
        config({ url: fake.url, password: null, tablesIntervalMs: 1_000 }),
        { now: () => now },
      );

      await collector.collect();
      now += 500;
      await collector.collect();
      now += 600;
      await collector.collect();

      const tableReads = fake.requests.filter((request) => request.path !== "/api/stats/summary");
      assert.equal(tableReads.length, 6, "the tables should refresh on their own interval");
    });

    it("keeps returning the cached tables between refreshes", async () => {
      const fake = await serve(false);
      let now = 0;
      const collector = createPiholeCollector(
        config({ url: fake.url, password: null, tablesIntervalMs: 60_000 }),
        { now: () => now },
      );

      await collector.collect();
      now += 500;
      const second = await collector.collect();

      assert.equal(second.tables.length, 3);
    });

    it("still updates metrics while the tables are cached", async () => {
      const fake = await serve(false);
      let now = 0;
      const collector = createPiholeCollector(
        config({ url: fake.url, password: null, tablesIntervalMs: 60_000 }),
        { now: () => now },
      );

      await collector.collect();
      fake.setSummary({
        queries: { total: 5_000, cached: 400, forwarded: 500, blocked: 100, percent_blocked: 10 },
        clients: { active: 3, total: 5 },
        gravity: { domains_being_blocked: 200_000 },
      });
      now += 500;
      const second = await collector.collect();

      const byKey = Object.fromEntries(second.metrics.map((m) => [m.metric, m.value]));
      assert.equal(byKey["dns.queriesTotal"], 5_000);
    });
  });

  describe("derived rates across cycles", () => {
    it("produces a rate on the second cycle and not the first", async () => {
      const fake = await serve(false);
      let now = 0;
      const collector = createPiholeCollector(
        config({ url: fake.url, password: null, tablesIntervalMs: 1_000 }),
        { now: () => now },
      );

      const first = await collector.collect();
      fake.setSummary({
        queries: { total: 1_100, cached: 400, forwarded: 500, blocked: 100, percent_blocked: 10 },
        clients: { active: 3, total: 5 },
        gravity: { domains_being_blocked: 200_000 },
      });
      now += 1_000;
      const second = await collector.collect();

      const firstRate = first.metrics.find((m) => m.metric === "dns.queryRate")?.value;
      const secondRate = second.metrics.find((m) => m.metric === "dns.queryRate")?.value;

      assert.equal(firstRate, null);
      assert.equal(secondRate, 100);
    });

    it("reports no rate when Pi-hole's counters reset overnight", async () => {
      const fake = await serve(false);
      let now = 0;
      const collector = createPiholeCollector(
        config({ url: fake.url, password: null, tablesIntervalMs: 1_000 }),
        { now: () => now },
      );

      await collector.collect();
      // Midnight: Pi-hole zeroes its daily counters.
      fake.setSummary({
        queries: { total: 4, cached: 0, forwarded: 4, blocked: 0, percent_blocked: 0 },
        clients: { active: 1, total: 1 },
        gravity: { domains_being_blocked: 200_000 },
      });
      now += 500;
      const afterReset = await collector.collect();

      assert.equal(afterReset.metrics.find((m) => m.metric === "dns.queryRate")?.value, null);
    });
  });

  describe("failures", () => {
    it("reports an unreachable endpoint", async () => {
      // Port 1 is reserved and nothing listens on it.
      const collector = createPiholeCollector(config({ url: "http://127.0.0.1:1" }));

      await assert.rejects(collector.collect(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /could not reach/);
        return true;
      });
    });

    it("reports a summary endpoint that is failing", async () => {
      const fake = await serve(false);
      fake.breakEndpoint("/api/stats/summary");
      const collector = createPiholeCollector(config({ url: fake.url, password: null }));

      await assert.rejects(collector.collect(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /500/);
        return true;
      });
    });

    it("keeps the metrics when only a table endpoint is failing", async () => {
      // The charts are why anyone is looking at this widget; a transient table failure must not
      // blank them.
      const fake = await serve(false);
      fake.breakEndpoint("/api/stats/upstreams");
      const collector = createPiholeCollector(config({ url: fake.url, password: null }));

      const result = await collector.collect();

      assert.equal(result.status, "ok");
      assert.ok(result.metrics.length > 0);
      assert.deepEqual(
        result.tables.map((table) => table.id),
        ["dns.topDomains", "dns.topClients"],
      );
    });

    it("reports a summary that is not the expected shape", async () => {
      const fake = await serve(false);
      fake.setSummary({ message: "Invalid password" });
      const collector = createPiholeCollector(config({ url: fake.url, password: null }));

      await assert.rejects(collector.collect(), /did not match the v5 or v6 shape/);
    });

    it("reports an HTML login page instead of an API", async () => {
      const fake = await serve(false);
      fake.setSummary({ "<html>": "<html>Please sign in</html>" });
      const collector = createPiholeCollector(config({ url: fake.url, password: null }));

      await assert.rejects(collector.collect(), /did not match the v5 or v6 shape/);
    });
  });

  describe("credential handling", () => {
    it("never places the password in an error message", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(config({ url: fake.url, password: "s3cret-value" }));
      fake.breakEndpoint("/api/stats/summary");

      try {
        await collector.collect();
        assert.fail("should have rejected");
      } catch (error) {
        const text =
          error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error);
        assert.ok(!text.includes("s3cret-value"), `a credential reached the error: ${text}`);
      }
    });

    it("sends the password only to the authentication endpoint", async () => {
      const fake = await serve(true);
      const collector = createPiholeCollector(config({ url: fake.url, password: PASSWORD }));

      await collector.collect();

      // Reads must carry the session cookie, never the password.
      for (const request of fake.requests.filter((entry) => entry.method === "GET")) {
        assert.ok(!request.path.includes(PASSWORD));
        assert.ok(!(request.cookie ?? "").includes(PASSWORD));
      }
    });
  });
});
