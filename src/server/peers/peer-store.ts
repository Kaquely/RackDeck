import { isPeerToken } from "../../shared/peer-token.ts";
import { normalizePeerUrl, parsePeerUrl } from "../../config/peer-url.ts";
import type { RemoteNodeConfig } from "../../config/remote-nodes.ts";
import type { PeerSummary } from "../../shared/api.ts";
import { JsonDocumentStore } from "../../store/json-document-store.ts";
import type { Validator } from "../../store/json-document-store.ts";

/**
 * The durable peer list.
 *
 * Only peers added through the dashboard live here. Environment-configured peers remain the
 * bootstrap path and are merged at startup. The document carries a token, so it is written with
 * mode 0600 and never projected into an HTTP response.
 */

export const PEER_STORE_VERSION = 1;

export type StoredPeer = {
  id: string;
  label: string;
  url: string;
  token: string;
  timeoutMs: number;
  createdAt: string;
};

export type PeerDocument = {
  version: typeof PEER_STORE_VERSION;
  peers: StoredPeer[];
};

export const EMPTY_PEER_DOCUMENT: PeerDocument = { version: PEER_STORE_VERSION, peers: [] };

export class PeerStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerStoreConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStoredPeer(input: unknown, index: number): string[] {
  if (!isRecord(input)) return [`peers[${index}] must be an object`];

  const errors: string[] = [];
  const id = input.id;
  if (typeof id !== "string" || !/^node-[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    errors.push(`peers[${index}].id must match node-<slug>`);
  }

  const label = input.label;
  if (typeof label !== "string" || label.trim().length === 0 || label.length > 64) {
    errors.push(`peers[${index}].label must be 1-64 characters`);
  }

  const url = input.url;
  if (typeof url !== "string") {
    errors.push(`peers[${index}].url must be a string`);
  } else {
    try {
      parsePeerUrl(url);
    } catch (error) {
      errors.push(
        `peers[${index}].url is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const token = input.token;
  if (typeof token !== "string" || !isPeerToken(token)) {
    errors.push(`peers[${index}].token must be a valid peer token`);
  }

  const timeoutMs = input.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  ) {
    errors.push(`peers[${index}].timeoutMs must be an integer between 100 and 60000`);
  }

  const createdAt = input.createdAt;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    errors.push(`peers[${index}].createdAt must be an ISO timestamp`);
  }

  return errors;
}

export const validatePeerDocument: Validator<PeerDocument> = (input) => {
  if (!isRecord(input)) {
    return { ok: false, errors: ["document must be an object"] };
  }

  const errors: string[] = [];
  if (input.version !== PEER_STORE_VERSION) {
    errors.push(`version must be ${PEER_STORE_VERSION}`);
  }
  if (!Array.isArray(input.peers)) {
    errors.push("peers must be an array");
    return { ok: false, errors };
  }

  input.peers.forEach((peer, index) => {
    errors.push(...validateStoredPeer(peer, index));
  });

  if (errors.length > 0) return { ok: false, errors };

  const peers = input.peers as StoredPeer[];
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const peer of peers) {
    if (ids.has(peer.id)) errors.push(`duplicate peer id "${peer.id}"`);
    ids.add(peer.id);

    let normalized: string;
    try {
      normalized = normalizePeerUrl(peer.url);
    } catch {
      continue;
    }
    if (urls.has(normalized)) errors.push(`duplicate peer URL "${normalized}"`);
    urls.add(normalized);
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, value: { version: PEER_STORE_VERSION, peers } };
};

export function createPeerStore(filePath: string): JsonDocumentStore<PeerDocument> {
  return new JsonDocumentStore<PeerDocument>({
    filePath,
    fallback: () => ({ ...EMPTY_PEER_DOCUMENT, peers: [] }),
    validate: validatePeerDocument,
    fileMode: 0o600,
    strict: true,
  });
}

export function storedPeerToConfig(peer: StoredPeer): RemoteNodeConfig {
  return {
    id: peer.id,
    label: peer.label,
    url: normalizePeerUrl(peer.url),
    timeoutMs: peer.timeoutMs,
    token: peer.token,
    managed: true,
  };
}

export function peerSummary(peer: RemoteNodeConfig): PeerSummary {
  return {
    id: peer.id,
    label: peer.label,
    url: peer.url,
    managed: peer.managed,
    hasToken: peer.token !== null,
  };
}

/**
 * Merge environment peers with stored peers.
 *
 * A duplicate id or URL is a configuration ambiguity, not something to resolve silently: the
 * source would either flap between two tokens or appear twice under one identity.
 */
export function mergeRemoteNodes(
  environmentPeers: RemoteNodeConfig[],
  storedPeers: StoredPeer[],
): RemoteNodeConfig[] {
  const merged = [...environmentPeers, ...storedPeers.map(storedPeerToConfig)];
  const ids = new Set<string>();
  const urls = new Set<string>();

  for (const peer of merged) {
    if (ids.has(peer.id)) {
      throw new PeerStoreConflictError(
        `peer id "${peer.id}" is configured more than once (environment and peers.json)`,
      );
    }
    ids.add(peer.id);

    const normalized = normalizePeerUrl(peer.url);
    if (urls.has(normalized)) {
      throw new PeerStoreConflictError(
        `peer URL "${normalized}" is configured more than once (environment and peers.json)`,
      );
    }
    urls.add(normalized);
  }

  return merged;
}
