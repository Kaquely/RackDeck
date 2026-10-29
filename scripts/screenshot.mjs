import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Visual verification of the dashboard in a real browser.
 *
 * Everything else about the UI is verified programmatically — the renderers are executed
 * against a real DOM and the built bundle is driven over HTTP — but none of that proves the
 * page *looks* right. This script closes that gap: it starts the real server, opens the real
 * bundle in Chromium, waits for live data, and captures each tab.
 *
 * It also reports console errors and failed requests, because a screenshot that looks fine
 * while the console is full of errors is not a passing result.
 *
 * Usage: node scripts/screenshot.mjs [outputDir]
 */

const outputDir = process.argv[2] ?? path.join(process.cwd(), "tmp", "screenshots");
const PORT = 4310;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(outputDir, { recursive: true });
const dataDir = mkdtempSync(path.join(tmpdir(), "homelabmd-shot-"));

const { spawn } = await import("node:child_process");

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function waitForData(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/readings`);
      if (response.ok) {
        const snapshot = await response.json();
        if (snapshot.series.length > 0) return snapshot;
      }
    } catch {
      // The server may not be listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("the server produced no readings within the timeout");
}

log("starting the server");
const server = spawn(process.execPath, ["src/main.ts"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    HOMELABMD_HOST: "127.0.0.1",
    HOMELABMD_DATA_DIR: dataDir,
    HOMELABMD_STATIC_DIR: "dist/web",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let failures = 0;

try {
  const snapshot = await waitForData();
  log(`readings ready: ${snapshot.series.length} series, ${snapshot.tables.length} tables`);

  log("launching Chromium");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });

  await page.goto(BASE, { waitUntil: "networkidle" });

  // Wait for real chart geometry rather than a fixed sleep, so the capture is not racy.
  await page.waitForSelector(".widget", { timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".chart, .data-table, .widget__message").length > 0,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1500);

  const tabNames = await page.$$eval(".tab:not(.tab--add):not(.tab--rename)", (nodes) =>
    nodes.map((node) => node.textContent?.replace("×", "").trim() ?? ""),
  );
  log(`tabs found: ${tabNames.join(", ")}`);

  for (let index = 0; index < tabNames.length; index += 1) {
    if (index > 0) {
      // Selected by text rather than nth-of-type: nth-of-type counts every button sibling,
      // including the Rename control, which made the index off by one.
      await page.locator(".tab:not(.tab--add):not(.tab--rename)").nth(index).click();
      await page.waitForTimeout(1200);
      const active = await page.$eval(".tab--active", (node) => node.textContent?.trim());
      if (!active?.startsWith(tabNames[index] ?? "")) {
        throw new Error(`expected tab "${tabNames[index]}" to be active, got "${active}"`);
      }
    }

    const name = (tabNames[index] || `tab-${index}`).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const file = path.join(outputDir, `tab-${index + 1}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(`captured ${file}`);
  }

  // What did the page actually contain?
  const summary = await page.evaluate(() => ({
    widgets: document.querySelectorAll(".widget").length,
    charts: document.querySelectorAll(".chart").length,
    tables: document.querySelectorAll(".data-table").length,
    paths: document.querySelectorAll("path").length,
    rects: document.querySelectorAll("rect").length,
    pills: [...document.querySelectorAll(".status__pill")].map((node) => node.textContent?.trim()),
    saveState: document.querySelector("#save-state")?.textContent?.trim(),
    messages: [...document.querySelectorAll(".widget__message")].map((node) =>
      node.textContent?.trim(),
    ),
    values: [...document.querySelectorAll(".widget__value")].map((node) =>
      node.textContent?.trim(),
    ),
    summaries: [...document.querySelectorAll(".visually-hidden")].map((node) =>
      node.textContent?.trim(),
    ),
  }));

  log("");
  log("=== what the page rendered ===");
  log(`widgets ${summary.widgets}, charts ${summary.charts}, tables ${summary.tables}`);
  log(`svg paths ${summary.paths}, rects ${summary.rects}`);
  log(`status pills: ${JSON.stringify(summary.pills)}`);
  log(`save state: ${summary.saveState || "(idle)"}`);
  log(`values: ${JSON.stringify(summary.values)}`);
  log(`messages: ${JSON.stringify(summary.messages)}`);
  log(`first summary: ${summary.summaries[0] ?? "(none)"}`);

  // A narrow viewport to check consistency across devices.
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(800);
  const narrow = path.join(outputDir, "narrow-420px.png");
  await page.screenshot({ path: narrow, fullPage: true });
  log(`captured ${narrow}`);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  log(`horizontal overflow at 420px: ${overflow}`);

  log("");
  log(`console errors: ${consoleErrors.length}`);
  for (const error of consoleErrors) log(`  ${error}`);
  log(`failed requests: ${failedRequests.length}`);
  for (const failure of failedRequests) log(`  ${failure}`);

  if (consoleErrors.length > 0 || failedRequests.length > 0) failures = 1;
  if (summary.widgets === 0) {
    log("FAIL: no widgets rendered");
    failures = 1;
  }

  await browser.close();
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  failures = 1;
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

log("");
log(`SCREENSHOT VERIFICATION: ${failures === 0 ? "PASSED" : "FAILED"}`);
process.exit(failures);
