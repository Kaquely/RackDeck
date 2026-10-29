import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Deployment contract for the one-command install.
 *
 * These are text-level checks, deliberately: the installer is a Bash script that runs on the
 * host, not inside the Node test process. The behaviour that needs a real shell is exercised
 * in tests/scripts/install-script.test.ts; this file pins the contract that makes that script
 * safe to reason about: exact tags, one compose owner, a healthcheck, and no Docker socket.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const installer = read(path.join("scripts", "install.sh"));
const bootstrap = read(path.join("scripts", "get.sh"));
const compose = read(path.join("infra", "compose.yaml"));
const casaos = read(path.join("deploy", "casaos", "docker-compose.yml"));
const casaosImport = read(path.join("deploy", "casaos", "import.template.yaml"));
const envExample = read(".env.example");
const releaseAssets = read(path.join("scripts", "release-assets.mjs"));

describe("scripts/install.sh", () => {
  it("is a Bash script with strict failure handling", () => {
    assert.match(installer, /^#!\/usr\/bin\/env bash/m);
    assert.match(installer, /set -euo pipefail/);
  });

  it("implements the four operator commands", () => {
    for (const command of ["install", "update", "rollback", "status"]) {
      assert.match(installer, new RegExp(`\\b${command}\\)`));
    }
  });

  it("supports the documented flags", () => {
    for (const flag of [
      "--version",
      "--to",
      "--image",
      "--casaos",
      "--role",
      "--prefix",
      "--check",
      "--dry-run",
      "--json",
      "--replace-owner",
    ]) {
      assert.ok(installer.includes(flag), `installer does not handle ${flag}`);
    }
  });

  it("uses the mandatory image tag instead of a stale default", () => {
    assert.match(installer, /HOMELABMD_IMAGE_TAG/);
    assert.match(installer, /HOMELABMD_IMAGE_REPOSITORY/);
    assert.doesNotMatch(installer, /HOMELABMD_IMAGE_TAG:-/);
  });

  it("verifies health and the running version before reporting success", () => {
    assert.match(installer, /\/api\/health/);
    assert.match(installer, /\/api\/version/);
    assert.match(installer, /verify_version/);
    assert.match(installer, /wait_healthy/);
  });

  it("verifies release assets and the image digest", () => {
    assert.match(installer, /SHA256SUMS/);
    assert.match(installer, /sha256sum|shasum/);
    assert.match(installer, /verify_checksums/);
    assert.match(installer, /verify_digest/);
    assert.match(installer, /HOMELABMD_RELEASE_BASE_URL/);
  });

  it("locks concurrent updates and backs up before changing files", () => {
    assert.match(installer, /flock/);
    assert.match(installer, /backup_deployment/);
    assert.match(installer, /restore_backup/);
    assert.match(installer, /ensure_volume/);
  });

  it("writes the environment file with mode 600", () => {
    assert.match(installer, /chmod 600 "\$ENV_FILE"/);
  });

  it("does not mount the Docker socket into the application", () => {
    assert.doesNotMatch(installer, /docker\.sock/);
  });

  it("owns the CasaOS app directory only when asked", () => {
    assert.match(installer, /\/var\/lib\/casaos\/apps\/homelabmd/);
    assert.match(installer, /x-casaos/);
  });
});

describe("infra/compose.yaml", () => {
  it("requires an explicit image tag", () => {
    assert.match(compose, /HOMELABMD_IMAGE_TAG:\?set HOMELABMD_IMAGE_TAG/);
    assert.doesNotMatch(compose, /HOMELABMD_IMAGE_TAG:-/);
  });

  it("has one predictable container name and a healthcheck", () => {
    assert.match(compose, /container_name:\s*homelabmd/);
    assert.match(compose, /healthcheck:/);
    assert.match(compose, /\/api\/health/);
    assert.match(compose, /external:\s*true/);
  });

  it("does not use latest or the Docker socket", () => {
    assert.doesNotMatch(compose, /:latest\b/);
    assert.doesNotMatch(compose, /docker\.sock/);
  });
});

describe("scripts/get.sh", () => {
  it("is a POSIX bootstrap that resolves and verifies the latest release", () => {
    assert.match(bootstrap, /^#!\/bin\/sh/m);
    assert.match(bootstrap, /releases\/latest/);
    assert.match(bootstrap, /SHA256SUMS/);
    assert.match(bootstrap, /install\.sh/);
    assert.match(bootstrap, /--casaos/);
  });
});

describe("deploy/casaos/import.template.yaml", () => {
  it("is a self-contained import file with CasaOS metadata", () => {
    assert.match(casaosImport, /^x-casaos:/m);
    assert.match(casaosImport, /image:\s*__IMAGE__/);
    assert.match(casaosImport, /HOMELABMD_UPDATE_REPOSITORY:\s*__REPOSITORY__/);
    assert.doesNotMatch(casaosImport, /external:\s*true/);
  });
});

describe("deploy/casaos/docker-compose.yml", () => {
  it("is a standalone CasaOS compose with metadata", () => {
    assert.match(casaos, /^x-casaos:/m);
    assert.match(casaos, /store_app_id:\s*homelabmd/);
    assert.match(casaos, /main:\s*homelabmd/);
  });

  it("uses the same exact-tag and health contract as the generic compose", () => {
    assert.match(casaos, /HOMELABMD_IMAGE_TAG:\?set HOMELABMD_IMAGE_TAG/);
    assert.match(casaos, /container_name:\s*homelabmd/);
    assert.match(casaos, /healthcheck:/);
    assert.match(casaos, /external:\s*true/);
    assert.doesNotMatch(casaos, /:latest\b/);
  });

  it("does not bind the Docker volume directory or the socket", () => {
    assert.doesNotMatch(casaos, /\/var\/lib\/docker\/volumes/);
    assert.doesNotMatch(casaos, /docker\.sock/);
  });
});

describe(".env.example", () => {
  it("documents the required image repository and tag", () => {
    assert.match(envExample, /HOMELABMD_IMAGE_REPOSITORY=ghcr\.io\/kaquely\/rackdeck/);
    assert.match(envExample, /HOMELABMD_IMAGE_TAG=\s*$/m);
  });

  it("documents the peer token as a secret", () => {
    assert.match(envExample, /HOMELABMD_PEER_TOKEN/);
    assert.match(envExample, /SECRET/);
  });
});

describe("scripts/release-assets.mjs", () => {
  it("produces the install assets and a checksum file", () => {
    for (const name of [
      "install.sh",
      "compose.yaml",
      "casaos-compose.yaml",
      "get.sh",
      "docker-run.txt",
      "release.json",
      "SHA256SUMS",
    ]) {
      assert.ok(releaseAssets.includes(name), `release-assets.mjs does not mention ${name}`);
    }
  });

  it("strips the source-checkout build block from the release compose", () => {
    assert.match(releaseAssets, /build:/);
    assert.match(releaseAssets, /withoutBuild|replace/);
  });
});
