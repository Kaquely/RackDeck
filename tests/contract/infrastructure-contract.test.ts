import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Infrastructure contract.
 *
 * The container image is built by the release workflow, not by these tests. These tests stand
 * in for the part of the build that can be checked without a container runtime: every path the
 * Dockerfile copies or executes must exist, the health check must name a real endpoint, the
 * compose file must agree with the code and with `.env.example`, and the release workflow must
 * verify the tag before it publishes.
 *
 * A Dockerfile that references a renamed file fails here, in CI, rather than at `docker build`
 * on the operator's machine.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative: string): boolean => existsSync(path.join(ROOT, relative));

const dockerfile = read(path.join("infra", "Dockerfile"));
const compose = read(path.join("infra", "compose.yaml"));
const envExample = read(".env.example");
const packageJson = read("package.json");

describe("infra/Dockerfile", () => {
  it("uses the Node major the project requires", () => {
    const manifest = JSON.parse(packageJson) as { engines?: { node?: string } };
    const required = manifest.engines?.node ?? "";
    const major = /^>=(\d+)/.exec(required)?.[1];

    assert.ok(major, `could not read a Node major from engines.node: ${required}`);
    for (const stage of dockerfile.match(/^FROM\s+(\S+)/gm) ?? []) {
      assert.match(stage, new RegExp(`^FROM\\s+node:${major}`), `stage does not use node:${major}`);
    }
  });

  it("copies only paths that exist", () => {
    // A COPY of a path that no longer exists is the most common way a Dockerfile rots.
    const copies = [...dockerfile.matchAll(/^COPY\s+(?:--[\w-]+(?:=\S+)?\s+)*(\S+)/gm)]
      .map((match) => match[1])
      .filter((source): source is string => source !== undefined)
      .filter((source) => !source.startsWith("/") && source !== ".");

    assert.ok(copies.length > 0, "expected the Dockerfile to copy something");

    for (const source of copies) {
      assert.ok(exists(source), `Dockerfile copies "${source}", which does not exist`);
    }
  });

  it("copies the backend as source, with no compiled output", () => {
    assert.match(dockerfile, /COPY\s+--chown=node:node\s+src\s+\.\/src/);
    // There is deliberately no `tsc` build stage; Node strips the types.
    assert.doesNotMatch(dockerfile, /RUN\s+.*\btsc\b/, "the backend must not be compiled");
  });

  it("starts the process from a file that exists", () => {
    const entry = /CMD\s+\[\s*"node"\s*,\s*"([^"]+)"/.exec(dockerfile);
    assert.ok(entry?.[1], "could not find the CMD entry point");

    const relative = String(entry[1]);
    assert.ok(exists(relative), `CMD points at "${relative}", which does not exist`);
  });

  it("installs production dependencies in the runtime stage", () => {
    assert.match(dockerfile, /npm ci --omit=dev/);
  });

  it("does not run dependency install scripts", () => {
    // Matches the .npmrc posture: no install script from any dependency runs at build time.
    for (const line of dockerfile.split("\n").filter((entry) => entry.startsWith("RUN npm ci"))) {
      assert.match(line, /--ignore-scripts/, `npm ci without --ignore-scripts: ${line}`);
    }
  });

  it("runs as a non-root user", () => {
    assert.match(dockerfile, /^USER\s+(?!root)\S+/m);
  });

  it("never mounts the Docker socket", () => {
    // The product observes; a root-equivalent host socket is not a trade worth making.
    assert.doesNotMatch(dockerfile, /docker\.sock/);
    assert.doesNotMatch(compose, /docker\.sock/);
  });

  it("declares a health check against an endpoint that exists", () => {
    assert.match(dockerfile, /HEALTHCHECK/);
    assert.match(dockerfile, /\/api\/health/);

    // The endpoint must actually be routed, or the container reports unhealthy forever.
    assert.match(read(path.join("src", "server", "routes", "status.ts")), /"\/health"/);
    assert.match(read(path.join("src", "server", "app.ts")), /healthRouter/);
  });

  it("persists the only durable state", () => {
    assert.match(dockerfile, /VOLUME\s+\["\/data"\]/);
    assert.match(dockerfile, /HOMELABMD_DATA_DIR=\/data/);
  });

  it("bakes release metadata into the image", () => {
    assert.match(dockerfile, /ARG APP_VERSION/);
    assert.match(dockerfile, /ARG APP_REVISION/);
    assert.match(dockerfile, /org\.opencontainers\.image\.version/);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision/);
    assert.match(dockerfile, /HOMELABMD_COMMIT/);
  });
});

describe("infra/compose.yaml", () => {
  it("points at a Dockerfile that exists", () => {
    const referenced = /dockerfile:\s*(\S+)/.exec(compose)?.[1];
    assert.ok(referenced !== undefined, "no dockerfile referenced");
    assert.ok(exists(referenced), `compose references a missing ${referenced}`);
  });

  it("declares a memory limit", () => {
    assert.match(compose, /mem_limit:/);
  });

  it("restarts unless explicitly stopped", () => {
    assert.match(compose, /restart:\s*unless-stopped/);
  });

  it("mounts a named volume for the layout", () => {
    assert.match(compose, /volumes:/);
    assert.match(compose, /-?\s*homelabmd-data:\/data|homelabmd-data:\/data/);
  });

  it("does not publish a port by default in a way that contradicts the documentation", () => {
    // The port is published for LAN access because there is no authentication; the file must
    // say so, because an operator who misses that note is running an open metrics endpoint.
    assert.match(compose, /no authentication/i);
  });

  it("uses only variables that are documented", () => {
    const referenced = new Set(
      [...compose.matchAll(/\$\{([A-Z0-9_]+)[^}]*\}/g)]
        .map((match) => match[1])
        .filter((name): name is string => name !== undefined),
    );

    assert.ok(referenced.size > 0, "expected compose to reference variables");

    for (const name of referenced) {
      // Container-internal variables are set directly, not from the operator's environment.
      if (["HOMELABMD_DATA_DIR", "HOMELABMD_STATIC_DIR"].includes(name)) continue;
      assert.ok(
        envExample.includes(name),
        `compose uses \${${name}}, which .env.example does not document`,
      );
    }
  });

  it("pins an exact release image and never uses latest", () => {
    assert.match(
      compose,
      /image:\s*\$\{HOMELABMD_IMAGE_REPOSITORY:-ghcr\.io\/kaquely\/rackdeck\}:\$\{HOMELABMD_IMAGE_TAG:\?set HOMELABMD_IMAGE_TAG\}/,
    );
    assert.doesNotMatch(compose, /:latest\b/);
    assert.match(envExample, /HOMELABMD_IMAGE_REPOSITORY=ghcr\.io\/kaquely\/rackdeck/);
    assert.match(envExample, /HOMELABMD_IMAGE_TAG=\s*$/m);
    assert.match(envExample, /HOMELABMD_UPDATE_CHECK=github/);
    assert.match(envExample, /HOMELABMD_UPDATE_CHECK_INTERVAL_MS=21600000/);
  });

  it("agrees with the application defaults for the sampling interval", () => {
    // If compose and the code disagreed about the cadence, the dashboard would refresh at a
    // different rate than the server samples, and nothing else would notice.
    assert.match(compose, /HOMELABMD_METRICS_INTERVAL_MS.*500/);
    assert.match(read(path.join("src", "config", "environment.ts")), /500/);
  });
});

describe("release automation", () => {
  const release = read(path.join(".github", "workflows", "release.yml"));

  it("verifies the tag against package.json before publishing", () => {
    assert.match(release, /package\.json.*version|version.*package\.json/s);
    assert.match(release, /npm run verify/);
    assert.match(release, /needs:\s*\[validate, quality\]/);
  });

  it("publishes one exact version tag and never latest", () => {
    assert.match(
      release,
      /tags:\s*\$\{\{\s*env\.IMAGE\s*\}\}:\$\{\{\s*needs\.validate\.outputs\.version\s*\}\}/,
    );
    assert.doesNotMatch(release, /:latest\b/);
    assert.match(release, /provenance:\s*true/);
    assert.match(release, /sbom:\s*true/);
    assert.match(release, /platforms:\s*linux\/amd64,linux\/arm64/);
  });

  it("publishes and verifies the install assets", () => {
    assert.match(release, /release-assets\.mjs/);
    assert.match(release, /gh release upload/);
    assert.match(release, /install\.sh/);
    assert.match(release, /compose\.yaml/);
    assert.match(release, /casaos-compose\.yaml/);
    assert.match(release, /get\.sh/);
    assert.match(release, /docker-run\.txt/);
    assert.match(release, /release\.json/);
    assert.match(release, /SHA256SUMS/);
    assert.match(release, /sha256sum -c/);
  });
});
