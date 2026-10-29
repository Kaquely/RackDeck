import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * Release asset contract.
 *
 * The installer verifies these files before it writes anything, so generating them is part of
 * the release surface, not an afterthought. This test runs the same script the workflow runs.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "release-assets.mjs");
const DIGEST = `sha256:${"a".repeat(64)}`;
const temporaryRoots: string[] = [];

after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function releaseDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "homelabmd-release-"));
  temporaryRoots.push(directory);
  return directory;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("scripts/release-assets.mjs", () => {
  it("writes the release assets with matching checksums", () => {
    const out = releaseDirectory();
    const result = run([
      "--version",
      "1.0.0",
      "--image",
      "ghcr.io/kaquely/rackdeck:1.0.0",
      "--digest",
      DIGEST,
      "--out",
      out,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const assets = [
      "install.sh",
      "compose.yaml",
      "casaos-compose.yaml",
      "get.sh",
      "docker-run.txt",
      "release.json",
      "SHA256SUMS",
    ];
    for (const name of assets) {
      assert.ok(existsSync(path.join(out, name)), `${name} was not generated`);
    }

    const sums = readFileSync(path.join(out, "SHA256SUMS"), "utf8");
    for (const name of assets.filter((asset) => asset !== "SHA256SUMS")) {
      const expected = sha256(path.join(out, name));
      assert.match(sums, new RegExp(`^${expected}  ${name}$`, "m"));
    }
  });

  it("writes a manifest the installer can consume", () => {
    const out = releaseDirectory();
    const result = run([
      "--version",
      "1.0.0",
      "--image",
      "ghcr.io/kaquely/rackdeck:1.0.0",
      "--digest",
      DIGEST,
      "--out",
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(readFileSync(path.join(out, "release.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.image, "ghcr.io/kaquely/rackdeck:1.0.0");
    assert.equal(manifest.image_repository, "ghcr.io/kaquely/rackdeck");
    assert.equal(manifest.image_tag, "1.0.0");
    assert.equal(manifest.digest, DIGEST);
    assert.equal(manifest.layout_version, 1);
    assert.match(String(manifest.install_sha256), /^[a-f0-9]{64}$/);
    assert.match(String(manifest.compose_sha256), /^[a-f0-9]{64}$/);
  });

  it("produces a pull-only compose without the source build block", () => {
    const out = releaseDirectory();
    const result = run([
      "--version",
      "1.0.0",
      "--image",
      "ghcr.io/kaquely/rackdeck:1.0.0",
      "--digest",
      DIGEST,
      "--out",
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const compose = readFileSync(path.join(out, "compose.yaml"), "utf8");
    assert.doesNotMatch(compose, /^\s+build:/m);
    assert.doesNotMatch(compose, /:latest\b/);
    assert.match(compose, /HOMELABMD_IMAGE_TAG:\?set HOMELABMD_IMAGE_TAG/);
    assert.match(compose, /container_name:\s*homelabmd/);
    assert.match(compose, /healthcheck:/);
  });

  it("produces a self-contained CasaOS import file", () => {
    const out = releaseDirectory();
    const result = run([
      "--version",
      "1.0.0",
      "--image",
      "ghcr.io/kaquely/rackdeck:1.0.0",
      "--digest",
      DIGEST,
      "--out",
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const compose = readFileSync(path.join(out, "casaos-compose.yaml"), "utf8");
    assert.match(compose, /image:\s*ghcr\.io\/kaquely\/rackdeck:1\.0\.0/);
    assert.doesNotMatch(compose, /:latest\b/);
    assert.doesNotMatch(compose, /external:\s*true/);
    assert.match(compose, /^x-casaos:/m);
    assert.match(compose, /HOMELABMD_UPDATE_REPOSITORY:\s*Kaquely\/RackDeck/);
  });

  it("produces a bootstrap and a Docker CLI command", () => {
    const out = releaseDirectory();
    const result = run([
      "--version",
      "1.0.0",
      "--image",
      "ghcr.io/kaquely/rackdeck:1.0.0",
      "--digest",
      DIGEST,
      "--out",
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const bootstrap = readFileSync(path.join(out, "get.sh"), "utf8");
    assert.match(bootstrap, /^#!\/bin\/sh/);
    assert.match(bootstrap, /releases\/latest/);
    assert.match(bootstrap, /SHA256SUMS/);
    assert.match(bootstrap, /DEFAULT_REPOSITORY="Kaquely\/RackDeck"/);
    assert.match(bootstrap, /--casaos/);

    const command = readFileSync(path.join(out, "docker-run.txt"), "utf8");
    assert.match(command, /docker run -d/);
    assert.match(command, /ghcr\.io\/kaquely\/rackdeck:1\.0\.0/);
    assert.match(command, /-p 3000:3000/);
    assert.match(command, /-v homelabmd-data:\/data/);
  });

  it("rejects an image tag that does not match the version", () => {
    const out = releaseDirectory();
    const result = run([
      "--version",
      "1.0.0",
      "--image",
      "ghcr.io/kaquely/rackdeck:1.0.1",
      "--digest",
      DIGEST,
      "--out",
      out,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match version/);
  });

  it("rejects a malformed digest", () => {
    const out = releaseDirectory();
    const result = run([
      "--version",
      "1.0.0",
      "--image",
      "ghcr.io/kaquely/rackdeck:1.0.0",
      "--digest",
      "sha256:not-a-digest",
      "--out",
      out,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid image digest/);
  });
});
