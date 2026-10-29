import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

/**
 * End-to-end verification of the Pi-hole integration.
 *
 * The unit tests prove the translation; the integration tests prove the HTTP conversation over a
 * real socket. Neither proves the integration is *visible*, which is the thing that actually
 * matters to an operator: that the metrics reach the dashboard, that a layout can display them,
 * and that none of it costs a credential.
 *
 * So this runs the whole product — a stand-in Pi-hole, the real server, the real bundle in a real
 * browser — and captures what the dashboard shows.
 *
 * The Pi-hole is a stand-in, not a real one. That limitation is real and is recorded in the
 * traceability matrix rather than glossed over.
 */

const PASSWORD = "e2e-password-must-never-appear";
const DASHBOARD_PORT = 4320;

const log = (message) => {
  process.stdout.write(`${message}\n`);
};

const SUMMARY = {
  queries: {
    total: 48_213,
    cached: 19_004,
    forwarded: 25_800,
    blocked: 3_409,
    percent_blocked: 7.1,
    unique_domains: 1_284,
  },
  clients: { active: 11, total: 14 },
  gravity: { domains_being_blocked: 214_887 },
};

let queryTotal = SUMMARY.queries.total;

function startStandInPiHole() {
  const requests = [];
  const server = createServer((request, response) => {
    const route = (request.url ?? "/").split("?")[0] ?? "/";
    requests.push({ method: request.method, path: route });

    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };

    if (request.method === "POST" && route === "/api/auth") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        let offered;
        try {
          offered = JSON.parse(Buffer.concat(chunks).toString("utf8")).password;
        } catch {
          offered = undefined;
        }
        if (offered !== PASSWORD) return send(401, { error: "invalid password" });
        send(200, { session: { valid: true } }, { "set-cookie": "sid=e2e; Path=/" });
      });
      return;
    }

    const cookie = request.headers.cookie;
    if (typeof cookie !== "string" || !cookie.includes("sid=e2e")) {
      return send(401, { error: "unauthorised" });
    }

    if (route === "/api/stats/summary") {
      // A running day, so the derived rate is a real number rather than a null.
      return send(200, {
        ...SUMMARY,
        queries: { ...SUMMARY.queries, total: queryTotal, cached: SUMMARY.queries.cached + 40 },
      });
    }
    if (route === "/api/stats/upstreams") {
      return send(200, {
        upstreams: [
          { ip: "10.0.0.1", name: "dns.google", port: 53, count: 14_200 },
          { ip: "10.0.0.2", name: "cloudflare-dns.com", port: 53, count: 9_100 },
          { ip: "10.0.0.3", name: "", port: 53, count: 2_500 },
        ],
      });
    }
    if (route === "/api/stats/domains") {
      return send(200, {
        domains: [
          { domain: "ads.doubleclick.net", count: 1_204 },
          { domain: "telemetry.example.com", count: 812 },
          { domain: "tracker.adservice.net", count: 604 },
        ],
      });
    }
    if (route === "/api/stats/clients") {
      return send(200, {
        clients: [
          { ip: "192.168.1.10", name: "laptop", count: 12_400 },
          { ip: "192.168.1.11", name: "phone", count: 9_800 },
          { ip: "192.168.1.20", name: "nas", count: 6_100 },
        ],
      });
    }
    send(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        tick: () => {
          // Roughly 12 queries a second, so the rate chart has something to draw.
          queryTotal += 6;
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

let failures = 0;
const fail = (message) => {
  log(`FAIL: ${message}`);
  failures += 1;
};

const piHole = await startStandInPiHole();

// Roughly 60 queries a second, so the derived rate is a real number and the captured chart
// shows an actual curve rather than a flat line at zero.
const ticker = setInterval(() => piHole.tick(), 100);
const dataDir = mkdtempSync(path.join(tmpdir(), "homelabmd-e2e-"));
const outputDir = path.join(process.cwd(), "tmp", "screenshots");
mkdirSync(outputDir, { recursive: true });

log(`stand-in Pi-hole listening on ${piHole.url}`);
log("starting the dashboard pointed at it");

const server = spawn(process.execPath, ["src/main.ts"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(DASHBOARD_PORT),
    HOMELABMD_HOST: "127.0.0.1",
    HOMELABMD_DATA_DIR: dataDir,
    HOMELABMD_STATIC_DIR: "dist/web",
    HOMELABMD_PIHOLE_URL: piHole.url,
    HOMELABMD_PIHOLE_PASSWORD: PASSWORD,
    HOMELABMD_PIHOLE_TABLES_INTERVAL_MS: "2000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

const base = `http://127.0.0.1:${DASHBOARD_PORT}`;

async function waitForPiHoleMetrics(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/readings`);
      if (response.ok) {
        const snapshot = await response.json();
        const series = (snapshot.series ?? []).filter((entry) => entry.sourceId === "pihole");
        if (series.length > 0) return snapshot;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("no Pi-hole metrics within the timeout");
}

try {
  // Give the derived rate several readings to difference against.
  await waitForPiHoleMetrics();
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  const readings = await (await fetch(`${base}/api/readings`)).json();

  log("");
  log("=== what the API exposes ===");

  const source = readings.sources.find((entry) => entry.id === "pihole");
  if (source === undefined) {
    fail("no Pi-hole source in the snapshot");
  } else {
    log(
      `source: id=${source.id} kind=${source.kind} label="${source.label}" status=${source.status}`,
    );
  }

  const piholeSeries = readings.series.filter((entry) => entry.sourceId === "pihole");
  log(`pi-hole series: ${piholeSeries.length}`);
  for (const entry of piholeSeries) {
    const latest = entry.samples.at(-1);
    log(`  ${entry.metric.padEnd(26)} ${String(latest?.v ?? "null").padStart(10)} ${entry.unit}`);
  }

  const expected = [
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
  ];
  const keys = piholeSeries.map((entry) => entry.metric).sort();
  for (const metric of expected) {
    if (!keys.includes(metric)) fail(`missing metric ${metric}`);
  }

  const rate = piholeSeries.find((entry) => entry.metric === "dns.queryRate");
  if (rate === undefined) {
    fail("no query rate series");
  } else if ((rate.samples.at(-1)?.v ?? null) === null) {
    fail("the query rate never became measurable, so the derivation is not running");
  }

  const tables = readings.tables.filter((entry) => entry.id.startsWith("dns."));
  log(
    `pi-hole tables: ${tables.map((entry) => `${entry.id}(${entry.rows.length} rows)`).join(", ")}`,
  );
  for (const id of ["dns.topUpstreams", "dns.topDomains", "dns.topClients"]) {
    if (!tables.some((entry) => entry.id === id)) fail(`missing table ${id}`);
  }

  log("");
  log("=== credential containment ===");

  for (const endpoint of [
    "/api/health",
    "/api/readings",
    "/api/config",
    "/api/layout",
    "/api/sources",
  ]) {
    const body = await (await fetch(`${base}${endpoint}`)).text();
    if (body.includes(PASSWORD)) fail(`${endpoint} disclosed the credential`);
  }
  if (serverOutput.includes(PASSWORD)) {
    fail(`the server log disclosed the credential: ${serverOutput}`);
  } else {
    log("no credential in any response or in the server log");
  }
  // The startup line reports that a password is set, without saying what it is.
  const integrationLine = serverOutput.split("\n").find((line) => line.includes("integrations="));
  log(`startup says: ${integrationLine?.trim() ?? "(missing)"}`);

  log("");
  log("=== request discipline ===");
  const authRequests = piHole.requests.filter((entry) => entry.method === "POST");
  const nonGet = piHole.requests.filter(
    (entry) => entry.method !== "GET" && entry.method !== "POST",
  );
  log(`total requests to Pi-hole: ${piHole.requests.length}`);
  log(`authentication requests: ${authRequests.length}`);
  log(`mutating requests: ${nonGet.length}`);
  if (nonGet.length > 0) fail(`mutating requests reached Pi-hole: ${JSON.stringify(nonGet)}`);
  // One login for many cycles is the point of session reuse.
  if (authRequests.length !== 1)
    fail(`expected exactly 1 authentication, got ${authRequests.length}`);

  log("");
  log("=== the dashboard as an operator sees it ===");

  // A layout that actually shows the integration, saved through the real API so the validation
  // path is exercised rather than bypassed.
  const layout = {
    version: 1,
    activeTabId: "dns",
    tabs: [
      {
        id: "dns",
        name: "DNS",
        widgets: [
          {
            id: "w-rate",
            type: "line",
            title: "Queries per second",
            sourceId: "pihole",
            metrics: ["dns.queryRate"],
            span: 2,
            unit: "q/s",
          },
          {
            id: "w-blocked",
            type: "gauge",
            title: "Percent blocked",
            sourceId: "pihole",
            metrics: ["dns.percentBlocked"],
            span: 1,
            min: 0,
            max: 100,
          },
          {
            id: "w-total",
            type: "bullet",
            title: "Queries today",
            sourceId: "pihole",
            metrics: ["dns.queriesTotal"],
            span: 1,
          },
          {
            id: "w-domains",
            type: "table",
            title: "Top blocked domains",
            sourceId: "pihole",
            metrics: ["dns.topDomains"],
            span: 2,
          },
          {
            id: "w-upstreams",
            type: "table",
            title: "Top upstreams",
            sourceId: "pihole",
            metrics: ["dns.topUpstreams"],
            span: 2,
          },
          {
            id: "w-clients",
            type: "table",
            title: "Top clients",
            sourceId: "pihole",
            metrics: ["dns.topClients"],
            span: 4,
          },
        ],
      },
    ],
  };

  const saveResponse = await fetch(`${base}/api/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(layout),
  });
  if (!saveResponse.ok) {
    fail(`saving the layout answered ${saveResponse.status}: ${await saveResponse.text()}`);
  } else {
    log("layout saved through the real API");
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".widget", { timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".data-table, .chart, .widget__message").length >= 6,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(2_000);

  const rendered = await page.evaluate(() => ({
    pills: [...document.querySelectorAll(".status__pill")].map((n) => n.textContent?.trim()),
    titles: [...document.querySelectorAll(".widget__title")].map((n) => n.textContent?.trim()),
    values: [...document.querySelectorAll(".widget__value")].map((n) => n.textContent?.trim()),
    tables: document.querySelectorAll(".data-table").length,
    rows: [...document.querySelectorAll(".data-table tbody tr")].length,
    paths: document.querySelectorAll("path").length,
    messages: [...document.querySelectorAll(".widget__message")].map((n) => n.textContent?.trim()),
  }));

  log(`status pills: ${JSON.stringify(rendered.pills)}`);
  log(`widget titles: ${JSON.stringify(rendered.titles)}`);
  log(`widget values: ${JSON.stringify(rendered.values)}`);
  log(`tables: ${rendered.tables}, table rows: ${rendered.rows}, svg paths: ${rendered.paths}`);
  if (rendered.messages.length > 0) log(`widget messages: ${JSON.stringify(rendered.messages)}`);

  if (!rendered.pills.some((pill) => /Pi-hole/i.test(pill ?? ""))) {
    fail("the Pi-hole source is not shown in the dashboard header");
  }
  if (rendered.tables !== 3) fail(`expected 3 tables rendered, got ${rendered.tables}`);
  if (rendered.rows === 0) fail("the tables rendered no rows");
  if (rendered.messages.length > 0)
    fail(`widgets reported messages: ${rendered.messages.join("; ")}`);

  const capture = path.join(outputDir, "pihole-integration.png");
  await page.screenshot({ path: capture, fullPage: true });
  log(`captured ${capture}`);

  if (consoleErrors.length > 0) {
    for (const error of consoleErrors) log(`  console error: ${error}`);
    fail(`${consoleErrors.length} console errors`);
  }

  await browser.close();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  log(serverOutput);
} finally {
  clearInterval(ticker);
  server.kill();
  await piHole.close();
  rmSync(dataDir, { recursive: true, force: true });
}

log("");
log(`INTEGRATION E2E: ${failures === 0 ? "PASSED" : `FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
