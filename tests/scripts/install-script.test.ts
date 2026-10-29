import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Shell-level checks for scripts/install.sh.
 *
 * CI runs these on Linux, where the installer is executed by the Bash that will run it in
 * production. On a Windows workstation without a usable Bash the execution tests are skipped;
 * the text contract in tests/contract/deployment-contract.test.ts still runs everywhere.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "install.sh");

function findBash(): string | null {
  const candidates = [
    process.env.BASH,
    "bash",
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && !result.stdout.includes("WSL")) {
      return candidate;
    }
  }
  return null;
}

const bash = findBash();
const skip = bash === null ? "bash is not available on this host" : false;

function run(args: string[]) {
  assert.ok(bash, "bash is required for this test");
  return spawnSync(bash, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, HOMELABMD_IMAGE_TAG: "" },
  });
}

describe("scripts/install.sh execution", () => {
  it("has valid shell syntax", { skip }, () => {
    const result = spawnSync(bash as string, ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("prints help without touching the host", { skip }, () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /install\.sh install/);
  });

  it("prints the CLI version when --version has no value", { skip }, () => {
    const result = run(["--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });

  it("renders a generic dry-run with the exact image tag", { skip }, () => {
    const result = run([
      "install",
      "--dry-run",
      "--image",
      "homelabmd:1.0.0-local-test",
      "--prefix",
      "/tmp/homelabmd-test",
      "--role",
      "peer",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HOMELABMD_IMAGE_TAG=1\.0\.0-local-test/);
    assert.match(result.stdout, /container_name: homelabmd/);
    assert.match(result.stdout, /HOMELABMD_ROLE=peer/);
    assert.match(result.stdout, /healthcheck:/);
  });

  it("renders CasaOS metadata when --casaos is used", { skip }, () => {
    const result = run([
      "install",
      "--dry-run",
      "--casaos",
      "--image",
      "homelabmd:1.0.0-local-test",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /x-casaos:/);
    assert.match(result.stdout, /store_app_id: homelabmd/);
  });

  it("rejects an invalid version before touching the host", { skip }, () => {
    const result = run(["install", "--dry-run", "--version", "not-a-version"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid version/);
  });

  it("rejects latest as an image tag", { skip }, () => {
    const result = run(["install", "--dry-run", "--image", "homelabmd:latest"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /latest/);
  });

  it("rejects --image combined with an explicit version", { skip }, () => {
    const result = run([
      "install",
      "--dry-run",
      "--image",
      "homelabmd:1.0.0-local-test",
      "--version",
      "1.0.0",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mutually exclusive/);
  });

  it("refuses to update a host with no deployment", { skip }, () => {
    const result = run([
      "update",
      "--dry-run",
      "--image",
      "homelabmd:1.0.0-local-test",
      "--prefix",
      "/tmp/homelabmd-empty",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no deployment/);
  });

  it("refuses to own the CasaOS directory and a custom prefix at once", { skip }, () => {
    const result = run(["install", "--dry-run", "--casaos", "--prefix", "/tmp/homelabmd-test"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mutually exclusive/);
  });
});

describe("repository files", () => {
  it("ships an executable installer source", () => {
    assert.ok(existsSync(SCRIPT));
  });
});
