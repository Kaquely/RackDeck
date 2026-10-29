import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { PeerUrlShapeError, parsePeerUrlShape } from "../shared/peer-url.ts";

/**
 * The address policy for peer nodes.
 *
 * A peer is a machine on the same LAN or tailnet. Allowing an arbitrary URL would turn the
 * main node into an SSRF probe and could send a peer token to a public host, so every
 * candidate must resolve only to private, carrier-grade NAT or unique-local addresses.
 */

export type PeerUrlErrorReason = "invalid" | "unresolvable" | "disallowed-address";

export class PeerUrlError extends Error {
  readonly reason: PeerUrlErrorReason;

  constructor(reason: PeerUrlErrorReason, message: string) {
    super(message);
    this.name = "PeerUrlError";
    this.reason = reason;
  }
}

const allowed = new BlockList();
allowed.addSubnet("10.0.0.0", 8, "ipv4");
allowed.addSubnet("172.16.0.0", 12, "ipv4");
allowed.addSubnet("192.168.0.0", 16, "ipv4");
allowed.addSubnet("100.64.0.0", 10, "ipv4");
allowed.addSubnet("fc00::", 7, "ipv6");

/** The documented ranges, exported for error messages and tests. */
export const ALLOWED_PEER_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
] as const;

function withoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Normalise an address for the matcher.
 *
 * Node reports an IPv4 client as `::ffff:192.168.0.5` when the listener is dual-stack. The
 * allowlist and the URL policy both want the IPv4 form, so strip the mapped prefix before
 * checking the family.
 */
function normaliseAddress(raw: string): { address: string; family: "ipv4" | "ipv6" } | null {
  const address = raw.split("%")[0] ?? raw;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) {
    return { address: mapped[1], family: "ipv4" };
  }
  const family = isIP(address);
  if (family === 4) return { address, family: "ipv4" };
  if (family === 6) return { address, family: "ipv6" };
  return null;
}

export function isAllowedPeerAddress(raw: string): boolean {
  const normalised = normaliseAddress(raw);
  if (normalised === null) return false;
  return allowed.check(normalised.address, normalised.family);
}

function assertHostnameAllowed(hostname: string): void {
  if (isIP(hostname) !== 0) {
    if (!isAllowedPeerAddress(hostname)) {
      throw new PeerUrlError(
        "disallowed-address",
        `address "${hostname}" is not in a private, CGNAT or unique-local range`,
      );
    }
  }
}

/** Apply the shared shape rules, translating the shared error into a policy error. */
function parseShape(raw: string): URL {
  try {
    return parsePeerUrlShape(raw);
  } catch (error) {
    if (error instanceof PeerUrlShapeError) {
      throw new PeerUrlError("invalid", error.message);
    }
    throw error;
  }
}

export function parsePeerUrl(raw: string): URL {
  const parsed = parseShape(raw);
  assertHostnameAllowed(withoutBrackets(parsed.hostname));
  return parsed;
}

/**
 * Shape-only canonicalisation for duplicate checks and storage.
 *
 * It deliberately does not apply the address policy: an environment peer is checked before
 * every collection, and a stored peer is checked before it is saved. Merging only needs one
 * spelling of a destination so two entries are not treated as different.
 */
export function canonicalPeerUrl(raw: string): string {
  return parseShape(raw).origin;
}

export function normalizePeerUrl(raw: string): string {
  return canonicalPeerUrl(raw);
}

export type ResolvedPeerUrl = {
  /** Canonical origin used for storage and comparison. */
  url: string;
  /** Every address returned for the host; literals return a single entry. */
  addresses: string[];
};

export type PeerResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<{ address: string; family: number }[]>;

/**
 * Resolve a candidate URL and require every address to be local.
 *
 * A hostname can return both a private and a public address; rejecting on any public answer
 * avoids a client that silently picks the public one. DNS rebinding after this check remains
 * a residual risk and is documented in the change design.
 *
 * `resolver` is injectable so the policy can be tested without depending on the host's DNS.
 */
export async function resolvePeerUrl(
  raw: string,
  resolver: PeerResolver = lookup,
): Promise<ResolvedPeerUrl> {
  const parsed = parsePeerUrl(raw);
  const hostname = withoutBrackets(parsed.hostname);

  if (isIP(hostname) !== 0) {
    return { url: parsed.origin, addresses: [hostname] };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw new PeerUrlError("unresolvable", `could not resolve host "${hostname}"`);
  }

  if (answers.length === 0) {
    throw new PeerUrlError("unresolvable", `host "${hostname}" has no addresses`);
  }

  for (const answer of answers) {
    if (!isAllowedPeerAddress(answer.address)) {
      throw new PeerUrlError(
        "disallowed-address",
        `host "${hostname}" resolves to "${answer.address}", which is not in a private, CGNAT or unique-local range`,
      );
    }
  }

  return { url: parsed.origin, addresses: answers.map((answer) => answer.address) };
}
