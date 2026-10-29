import { isPeerToken } from "../../shared/peer-token.ts";
import { PeerUrlError, normalizePeerUrl, resolvePeerUrl } from "../../config/peer-url.ts";
import type { ResolvedPeerUrl } from "../../config/peer-url.ts";
import type { RemoteNodeConfig } from "../../config/remote-nodes.ts";
import type {
  PeerAddRequest,
  PeerInfoResponse,
  PeerSummary,
  PeerVerifyRequest,
} from "../../shared/api.ts";
import type { StoreStatus } from "../../store/json-document-store.ts";
import { HttpJsonReader, IntegrationError } from "../integrations/http-json-reader.ts";
import { createRemoteNodeCollector } from "../collectors/remote-node.ts";
import type { Collector } from "../collectors/types.ts";
import type { CollectorScheduler } from "../metrics/collector-scheduler.ts";
import {
  PeerStoreConflictError,
  mergeRemoteNodes,
  peerSummary,
  storedPeerToConfig,
} from "./peer-store.ts";
import type { JsonDocumentStore } from "../../store/json-document-store.ts";
import type { PeerDocument, StoredPeer } from "./peer-store.ts";

/**
 * The main node's peer registry.
 *
 * It owns the merged view of environment and stored peers, verifies candidates before they are
 * persisted, and keeps the scheduler in step without a restart. Reads are synchronous; mutations
 * are serialised so two concurrent adds cannot overwrite each other's document.
 */

const VERIFY_TIMEOUT_MS = 5_000;
const VERIFY_MAX_BYTES = 64 * 1024;

export class PeerVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerVerificationError";
  }
}

export class PeerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerValidationError";
  }
}

export class PeerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerNotFoundError";
  }
}

export type PeerManagerDeps = {
  environmentPeers: RemoteNodeConfig[];
  store: JsonDocumentStore<PeerDocument>;
  scheduler: CollectorScheduler;
  createCollector?: (config: RemoteNodeConfig) => Collector;
  verifyPeer?: (url: string, token: string) => Promise<PeerInfoResponse>;
  /** Test seam for the address policy. Production resolves and checks private ranges. */
  resolveUrl?: (url: string) => Promise<ResolvedPeerUrl>;
  now?: () => Date;
};

export type PeerManager = {
  list(): PeerSummary[];
  verify(input: PeerVerifyRequest): Promise<PeerInfoResponse>;
  add(input: PeerAddRequest): Promise<PeerSummary>;
  remove(id: string): Promise<PeerSummary>;
  storeStatus(): StoreStatus;
  peers(): RemoteNodeConfig[];
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function requireLabel(raw: string): string {
  const label = raw.trim();
  if (label.length === 0 || label.length > 64) {
    throw new PeerValidationError("label must be 1-64 characters");
  }
  return label;
}

function requireToken(raw: string): string {
  if (!isPeerToken(raw)) {
    throw new PeerValidationError(
      "token must be hlp_ followed by 43 base64url characters (32 random bytes)",
    );
  }
  return raw;
}

/**
 * Ask a candidate to identify itself.
 *
 * Shared by verification and every future health check. The request carries the token but the
 * response is reduced to the three public fields; a peer cannot smuggle a secret into the
 * stored document through this path.
 */
export async function fetchPeerInfo(
  url: string,
  token: string,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<PeerInfoResponse> {
  const reader = new HttpJsonReader({
    baseUrl: url,
    timeoutMs,
    maxBytes: VERIFY_MAX_BYTES,
    redirect: "error",
  });

  let payload: unknown;
  try {
    payload = await reader.getJson<unknown>("/api/peer/info", {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof IntegrationError) {
      if (error.reason === "auth") {
        throw new PeerVerificationError("The peer rejected the token.");
      }
      if (error.reason === "timeout" || error.reason === "unreachable") {
        throw new PeerVerificationError(`Could not reach the peer at ${url}.`);
      }
      if (error.reason === "malformed") {
        throw new PeerVerificationError("The address did not return a RackDeck peer response.");
      }
      if (error.reason === "status") {
        throw new PeerVerificationError(`The peer answered HTTP ${error.status ?? "an error"}.`);
      }
      throw new PeerVerificationError("The peer response was too large to verify.");
    }
    throw new PeerVerificationError("The peer could not be verified.");
  }

  if (typeof payload !== "object" || payload === null) {
    throw new PeerVerificationError("The address did not return a RackDeck peer response.");
  }
  const candidate = payload as Record<string, unknown>;
  if (
    candidate.role !== "peer" ||
    typeof candidate.version !== "string" ||
    candidate.version.length === 0 ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0
  ) {
    throw new PeerVerificationError("The address is not a RackDeck peer.");
  }

  return { role: "peer", version: candidate.version, id: candidate.id };
}

export async function createPeerManager(dependencies: PeerManagerDeps): Promise<PeerManager> {
  const { environmentPeers, store, scheduler } = dependencies;
  const createCollector = dependencies.createCollector ?? createRemoteNodeCollector;
  const verifyPeer = dependencies.verifyPeer ?? fetchPeerInfo;
  const resolveUrl = dependencies.resolveUrl ?? resolvePeerUrl;
  const now = dependencies.now ?? (() => new Date());

  async function canonicalUrl(raw: string): Promise<string> {
    try {
      return (await resolveUrl(raw)).url;
    } catch (error) {
      if (error instanceof PeerUrlError) {
        throw new PeerValidationError(error.message);
      }
      throw error;
    }
  }

  await store.load();

  let storedPeers: StoredPeer[] = store.get().peers;
  let configs: RemoteNodeConfig[] = mergeRemoteNodes(environmentPeers, storedPeers);
  const environmentIds = new Set(environmentPeers.map((peer) => peer.id));

  for (const config of configs) {
    scheduler.addCollector(createCollector(config));
  }

  let mutations: Promise<unknown> = Promise.resolve();

  function serialise<T>(operation: () => Promise<T>): Promise<T> {
    const run = mutations.then(operation, operation);
    mutations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function verifyCandidate(url: string, token: string): Promise<PeerInfoResponse> {
    let info: PeerInfoResponse;
    try {
      info = await verifyPeer(url, token);
    } catch (error) {
      if (error instanceof PeerVerificationError) throw error;
      throw new PeerVerificationError("The peer could not be verified.");
    }

    if (info.role !== "peer" || info.version.length === 0 || info.id.length === 0) {
      throw new PeerVerificationError("The address is not a RackDeck peer.");
    }
    return info;
  }

  function uniqueId(label: string): string {
    const base = `node-${slugify(label) || "peer"}`.slice(0, 64);
    const used = new Set(configs.map((peer) => peer.id));
    if (!used.has(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base}-${suffix}`.slice(0, 64);
      if (!used.has(candidate)) return candidate;
    }
  }

  return {
    list(): PeerSummary[] {
      return configs.map(peerSummary);
    },

    peers(): RemoteNodeConfig[] {
      return configs.map((peer) => ({ ...peer }));
    },

    storeStatus(): StoreStatus {
      return store.status();
    },

    async verify(input: PeerVerifyRequest): Promise<PeerInfoResponse> {
      const token = requireToken(input.token);
      const url = await canonicalUrl(input.url);
      return verifyCandidate(url, token);
    },

    async add(input: PeerAddRequest): Promise<PeerSummary> {
      const label = requireLabel(input.label);
      const token = requireToken(input.token);
      const url = await canonicalUrl(input.url);

      return serialise(async () => {
        if (configs.some((peer) => normalizePeerUrl(peer.url) === url)) {
          throw new PeerStoreConflictError("A peer with this URL is already configured.");
        }

        await verifyCandidate(url, token);

        const stored: StoredPeer = {
          id: uniqueId(label),
          label,
          url,
          token,
          timeoutMs: VERIFY_TIMEOUT_MS,
          createdAt: now().toISOString(),
        };

        const previousDocument: PeerDocument = {
          version: 1,
          peers: storedPeers.map((peer) => ({ ...peer })),
        };
        const nextDocument: PeerDocument = {
          version: 1,
          peers: [...storedPeers, stored],
        };

        await store.set(nextDocument);

        const config = storedPeerToConfig(stored);
        try {
          scheduler.addCollector(createCollector(config));
        } catch (error) {
          // Keep disk and memory aligned if registration fails after the write.
          await store.set(previousDocument).catch(() => undefined);
          throw error;
        }

        storedPeers = [...storedPeers, stored];
        configs = [...configs, config];
        return peerSummary(config);
      });
    },

    async remove(id: string): Promise<PeerSummary> {
      return serialise(async () => {
        const config = configs.find((peer) => peer.id === id);
        if (config === undefined) {
          throw new PeerNotFoundError(`No peer with id "${id}".`);
        }
        if (environmentIds.has(id) || !config.managed) {
          throw new PeerStoreConflictError(
            "This peer is managed by the environment and cannot be removed here.",
          );
        }

        const nextStored = storedPeers.filter((peer) => peer.id !== id);
        await store.set({ version: 1, peers: nextStored });

        scheduler.removeCollector(id);
        storedPeers = nextStored;
        configs = configs.filter((peer) => peer.id !== id);
        return peerSummary(config);
      });
    },
  };
}
