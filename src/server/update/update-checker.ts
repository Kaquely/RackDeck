import type { UpdateResponse } from "../../shared/api.ts";
import { compareSemver, normalizeVersion } from "./semver.ts";

/**
 * Opt-in, fail-soft update check against the public GitHub Releases API.
 *
 * The checker never blocks startup or a request. It keeps the last successful answer in
 * memory, sends no installation identifier, and degrades to `unknown` when GitHub is
 * unreachable. The dashboard only ever sees the small view returned by `view()`, never the
 * raw upstream payload.
 */

const GITHUB_API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type UpdateCheckerOptions = {
  currentVersion: string;
  repository: string;
  enabled: boolean;
  intervalMs: number;
  channel: "stable" | "prerelease";
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  staleAfterMs?: number;
  onError?: (error: unknown) => void;
};

export type UpdateChecker = {
  start: () => void;
  stop: () => void;
  /** Run one check immediately. Never rejects; failures leave the cache in place. */
  checkNow: () => Promise<void>;
  view: () => UpdateResponse;
};

type Release = {
  tagName: string;
  releaseUrl: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  draft: boolean;
};

type CachedRelease = Release & {
  checkedAt: number;
};

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  let cached: CachedRelease | null = null;
  let etag: string | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function view(): UpdateResponse {
    if (!options.enabled) {
      return {
        status: "disabled",
        currentVersion: options.currentVersion,
        latestVersion: null,
        releaseUrl: null,
        publishedAt: null,
        checkedAt: null,
        stale: false,
      };
    }

    if (cached === null) {
      return {
        status: "unknown",
        currentVersion: options.currentVersion,
        latestVersion: null,
        releaseUrl: null,
        publishedAt: null,
        checkedAt: null,
        stale: false,
      };
    }

    const comparison = compareSemver(cached.tagName, options.currentVersion);
    const newer = comparison !== null && comparison > 0;

    return {
      status: newer ? "available" : "current",
      currentVersion: options.currentVersion,
      latestVersion: normalizeVersion(cached.tagName),
      releaseUrl: cached.releaseUrl,
      publishedAt: cached.publishedAt,
      checkedAt: new Date(cached.checkedAt).toISOString(),
      stale: now() - cached.checkedAt > staleAfterMs,
    };
  }

  async function checkNow(): Promise<void> {
    if (!options.enabled) return;
    if (inFlight !== null) return inFlight;

    const run = performCheck().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  }

  async function performCheck(): Promise<void> {
    const endpoint =
      options.channel === "stable"
        ? `${GITHUB_API}/repos/${options.repository}/releases/latest`
        : `${GITHUB_API}/repos/${options.repository}/releases?per_page=10`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": `homelabmd/${options.currentVersion}`,
    };
    if (etag !== null) headers["If-None-Match"] = etag;

    try {
      const response = await fetchImpl(endpoint, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 304) {
        // The cached release is still current, but the freshness clock restarts.
        if (cached !== null) cached = { ...cached, checkedAt: now() };
        return;
      }

      if (!response.ok) return;

      const body = await readCapped(response, maxResponseBytes);
      const release = selectRelease(JSON.parse(body), options.channel);
      if (release === null) return;

      const comparison = compareSemver(release.tagName, options.currentVersion);
      if (comparison === null) return;

      etag = response.headers.get("etag");
      cached = { ...release, checkedAt: now() };
    } catch (error) {
      // Offline, timeout, malformed payload, or a rate limit: keep the last good answer.
      options.onError?.(error);
    }
  }

  function start(): void {
    if (!options.enabled || timer !== null) return;

    // Deliberately not awaited: a slow GitHub must never delay the port binding.
    void checkNow();
    timer = setInterval(() => {
      void checkNow();
    }, options.intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, checkNow, view };
}

function selectRelease(payload: unknown, channel: "stable" | "prerelease"): Release | null {
  if (channel === "stable") {
    return parseRelease(payload, { requireStable: true });
  }
  if (!Array.isArray(payload)) return null;
  for (const entry of payload) {
    const release = parseRelease(entry, { requireStable: false });
    if (release !== null) return release;
  }
  return null;
}

function parseRelease(payload: unknown, options: { requireStable: boolean }): Release | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;

  const record = payload as Record<string, unknown>;
  if (typeof record.tag_name !== "string") return null;
  if (record.draft === true) return null;
  if (options.requireStable && record.prerelease === true) return null;

  return {
    tagName: record.tag_name,
    releaseUrl: safeReleaseUrl(record.html_url),
    publishedAt: typeof record.published_at === "string" ? record.published_at : null,
    prerelease: record.prerelease === true,
    draft: record.draft === true,
  };
}

/** Only an https GitHub URL is ever surfaced to the browser. */
function safeReleaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  // `Response` is the platform fetch type; make the stream element type explicit so the
  // byte accounting below is checked rather than inferred as `any`.
  const stream = response.body as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`update response exceeded ${maxBytes} bytes`);
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return body + decoder.decode();
}
