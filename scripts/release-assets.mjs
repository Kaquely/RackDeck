#!/usr/bin/env node
/**
 * Build the files a release publishes beside the container image:
 *
 *   install.sh          the host-side installer/updater
 *   compose.yaml        the deployment contract, without the source-checkout build block
 *   casaos-compose.yaml a self-contained file for the CasaOS Import dialog
 *   get.sh              a bootstrap that resolves and runs the latest installer
 *   docker-run.txt      a copy-paste command for the CasaOS Docker CLI tab
 *   release.json        the machine-readable manifest consumed by the installer
 *   SHA256SUMS          checksums for the files above
 *
 * The script is deterministic for a given version, image, digest, repository and source
 * tree. It is exercised by tests/scripts/release-assets.test.ts and invoked by the release
 * workflow.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..");

function fail(message) {
  console.error(`release-assets: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    version: "",
    image: "",
    digest: "",
    repository: process.env.GITHUB_REPOSITORY || "Kaquely/RackDeck",
    out: join(repositoryRoot, "release-assets"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--version":
        options.version = value ?? "";
        index += 1;
        break;
      case "--image":
        options.image = value ?? "";
        index += 1;
        break;
      case "--digest":
        options.digest = value ?? "";
        index += 1;
        break;
      case "--repository":
        options.repository = value ?? "";
        index += 1;
        break;
      case "--out":
        options.out = value ?? "";
        index += 1;
        break;
      default:
        fail(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function validate(options) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(options.version)) {
    fail(`invalid version: ${options.version || "(missing)"}`);
  }
  if (!/^[a-z0-9./_-]+:\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(options.image)) {
    fail(`invalid image reference: ${options.image || "(missing)"}`);
  }
  const imageTag = options.image.slice(options.image.lastIndexOf(":") + 1);
  if (imageTag !== options.version) {
    fail(`image tag '${imageTag}' does not match version '${options.version}'`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(options.digest)) {
    fail(`invalid image digest: ${options.digest || "(missing)"}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    fail(`invalid repository: ${options.repository || "(missing)"}`);
  }
  if (!options.out) {
    fail("--out must not be empty");
  }
}

async function layoutVersion() {
  const source = await readFile(join(repositoryRoot, "src/shared/layout.ts"), "utf8");
  const match = /export const LAYOUT_VERSION = (\d+);/.exec(source);
  if (!match) {
    fail("could not read LAYOUT_VERSION from src/shared/layout.ts");
  }
  return Number(match[1]);
}

function releaseCompose(source) {
  // The source compose keeps a `build:` block so a checkout can be exercised with
  // `docker compose up --build`. The release asset is pull-only: an operator has no source
  // tree, and a stale build block would be misleading.
  const withoutBuild = source.replace(/^ {4}build:\n(?: {6}.*\n)+/m, "");
  if (!withoutBuild.includes("HOMELABMD_IMAGE_TAG:?")) {
    fail("compose.yaml must require HOMELABMD_IMAGE_TAG");
  }
  const imageLine = withoutBuild.split("\n").find((line) => line.trimStart().startsWith("image:"));
  if (!imageLine || imageLine.includes(":latest")) {
    fail("compose.yaml must name an exact image and must not use latest");
  }
  return withoutBuild;
}

function casaosCompose(template, options) {
  const owner = options.repository.split("/")[0];
  const rendered = template
    .replaceAll("__IMAGE__", options.image)
    .replaceAll("__REPOSITORY__", options.repository)
    .replaceAll("__OWNER__", owner);

  if (rendered.includes("__")) {
    fail("casaos-compose.yaml still contains an unresolved placeholder");
  }
  if (/:latest\b/.test(rendered)) {
    fail("casaos-compose.yaml must not use latest");
  }
  if (/external:\s*true/.test(rendered)) {
    fail("casaos-compose.yaml must let Compose create the volume");
  }
  if (!/^x-casaos:/m.test(rendered)) {
    fail("casaos-compose.yaml must carry CasaOS metadata");
  }
  return rendered;
}

function bootstrap(source, options) {
  const rendered = source.replace(
    /^DEFAULT_REPOSITORY=.*$/m,
    `DEFAULT_REPOSITORY="${options.repository}"`,
  );
  if (!rendered.includes(`DEFAULT_REPOSITORY="${options.repository}"`)) {
    fail("get.sh does not expose a DEFAULT_REPOSITORY assignment");
  }
  return rendered;
}

function dockerRun(options) {
  return [
    "docker run -d \\",
    "  --name homelabmd \\",
    "  --restart unless-stopped \\",
    "  -p 3000:3000 \\",
    "  -v homelabmd-data:/data \\",
    "  --memory 300m \\",
    "  --memory-reservation 192m \\",
    "  -e HOMELABMD_ROLE=main \\",
    `  -e HOMELABMD_UPDATE_REPOSITORY=${options.repository} \\`,
    `  ${options.image}`,
    "",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validate(options);

  await mkdir(options.out, { recursive: true });

  const installerSource = await readFile(join(repositoryRoot, "scripts/install.sh"), "utf8");
  const composeSource = await readFile(join(repositoryRoot, "infra/compose.yaml"), "utf8");
  const compose = releaseCompose(composeSource);

  const casaosTemplate = await readFile(
    join(repositoryRoot, "deploy/casaos/import.template.yaml"),
    "utf8",
  );
  const casaos = casaosCompose(casaosTemplate, options);

  const bootstrapSource = await readFile(join(repositoryRoot, "scripts/get.sh"), "utf8");
  const get = bootstrap(bootstrapSource, options);
  const runCommand = dockerRun(options);

  const installerPath = join(options.out, "install.sh");
  const composePath = join(options.out, "compose.yaml");
  const casaosPath = join(options.out, "casaos-compose.yaml");
  const getPath = join(options.out, "get.sh");
  const dockerRunPath = join(options.out, "docker-run.txt");
  const manifestPath = join(options.out, "release.json");
  const sumsPath = join(options.out, "SHA256SUMS");

  await writeFile(installerPath, installerSource, "utf8");
  await writeFile(composePath, compose, "utf8");
  await writeFile(casaosPath, casaos, "utf8");
  await writeFile(getPath, get, "utf8");
  await writeFile(dockerRunPath, runCommand, "utf8");
  if (process.platform !== "win32") {
    await chmod(installerPath, 0o755);
    await chmod(getPath, 0o755);
  }

  const installSha = sha256(installerSource);
  const composeSha = sha256(compose);
  const casaosSha = sha256(casaos);
  const getSha = sha256(get);
  const dockerRunSha = sha256(runCommand);
  const layout = await layoutVersion();

  const manifest = {
    version: options.version,
    image: options.image,
    image_repository: options.image.slice(0, options.image.lastIndexOf(":")),
    image_tag: options.version,
    digest: options.digest,
    layout_version: layout,
    minimum_supported_layout_version: layout,
    breaking: false,
    install_sha256: installSha,
    compose_sha256: composeSha,
    casaos_compose_sha256: casaosSha,
    get_sha256: getSha,
    docker_run_sha256: dockerRunSha,
  };

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestText, "utf8");

  const manifestSha = sha256(manifestText);
  const sums = [
    `${installSha}  install.sh`,
    `${composeSha}  compose.yaml`,
    `${casaosSha}  casaos-compose.yaml`,
    `${getSha}  get.sh`,
    `${dockerRunSha}  docker-run.txt`,
    `${manifestSha}  release.json`,
    "",
  ].join("\n");
  await writeFile(sumsPath, sums, "utf8");

  process.stdout.write(
    `${JSON.stringify({
      out: options.out,
      files: [
        "install.sh",
        "compose.yaml",
        "casaos-compose.yaml",
        "get.sh",
        "docker-run.txt",
        "release.json",
        "SHA256SUMS",
      ],
      version: options.version,
      repository: options.repository,
      image: options.image,
      digest: options.digest,
      layoutVersion: layout,
      sha256: {
        install: installSha,
        compose: composeSha,
        casaosCompose: casaosSha,
        get: getSha,
        dockerRun: dockerRunSha,
        manifest: manifestSha,
      },
    })}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
