#!/usr/bin/env node
/**
 * Security audit gate.
 *
 * `npm audit` has two very different failure modes:
 *
 *   1. It found a high or critical vulnerability. The build must stop.
 *   2. The npm advisory service is unavailable. The build did not learn anything about the
 *      dependency tree, so treating that as a vulnerability is false, but treating it as a
 *      clean audit is worse.
 *
 * This wrapper keeps the distinction. It retries availability failures, then reports a loud
 * warning and exits 0 for the normal gate. `--strict` turns the same condition into a failure
 * and is used by the release workflow, so an image cannot be published during an outage.
 */
import { spawnSync } from "node:child_process";

const strict = process.argv.includes("--strict");
const attempts = 3;
const retryDelayMs = 3_000;
const auditCommand = "npm audit --json --audit-level=high";

const env = {
  ...process.env,
  // Keep an outage cheap to detect. `npm audit` otherwise waits five minutes per attempt.
  npm_config_fetch_timeout: process.env.npm_config_fetch_timeout ?? "30000",
  npm_config_fetch_retries: "0",
};

let lastUnavailable = "";

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  // A single fixed command string keeps the Windows `.cmd` shim working without passing
  // unescaped arguments through a shell.
  const result = spawnSync(auditCommand, {
    encoding: "utf8",
    env,
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });

  if (result.error !== undefined) {
    console.error(`Security audit could not start: ${result.error.message}`);
    process.exit(1);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const report = parseReport(stdout);
  const counts = report?.metadata?.vulnerabilities;

  if (counts !== undefined) {
    const high = counts.high ?? 0;
    const critical = counts.critical ?? 0;

    if (high > 0 || critical > 0) {
      console.error(
        `Security audit found ${high} high and ${critical} critical vulnerability(ies).`,
      );
      console.error(stdout.trim());
      process.exit(1);
    }

    if (result.status === 0) {
      console.log("Security audit: no high or critical vulnerabilities.");
      process.exit(0);
    }
  }

  if (!isUnavailable(stdout, stderr)) {
    console.error(stderr.trim() || stdout.trim() || "npm audit failed without a report.");
    process.exit(result.status ?? 1);
  }

  lastUnavailable = (stderr.trim() || stdout.trim()).slice(0, 2_000);
  if (attempt < attempts) {
    console.warn(
      `Security audit advisory endpoint unavailable (attempt ${attempt}/${attempts}); retrying.`,
    );
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

const message =
  "Security audit could not reach the npm advisory endpoint. No vulnerability result is available.";
console.warn(message);
console.warn(lastUnavailable);

if (strict) {
  console.error("Strict audit: refusing to continue without a security audit result.");
  process.exit(1);
}

console.warn(
  "Continuing without an audit result. The release workflow runs `npm run security:audit:strict`.",
);
process.exit(0);

function parseReport(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

function isUnavailable(stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  return /audit endpoint returned an error|network timeout|Service Unavailable|\b503\b|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(
    text,
  );
}
