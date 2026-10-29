import { createRequire } from "node:module";

/**
 * Application version, read from `package.json` so it can never drift from the released
 * version. Falls back to `0.0.0-unknown` rather than throwing, because a missing manifest
 * must not stop the dashboard from starting.
 */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require("../../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

function readBuildString(variable: string, fallback: string): string {
  const raw = process.env[variable]?.trim();
  return raw === undefined || raw.length === 0 ? fallback : raw;
}

export const APP_VERSION = readVersion();

/**
 * The source revision embedded at image build time. A local `node src/main.ts` run has no
 * revision, so `unknown` is the honest answer rather than a fabricated hash.
 */
export const APP_COMMIT = readBuildString("HOMELABMD_COMMIT", "unknown");

/** The release channel the running build belongs to. */
export const APP_CHANNEL = readBuildString("HOMELABMD_CHANNEL", "stable");

export type BuildInfo = {
  version: string;
  commit: string;
  channel: string;
};

export function buildInfo(): BuildInfo {
  return {
    version: APP_VERSION,
    commit: APP_COMMIT,
    channel: APP_CHANNEL,
  };
}
