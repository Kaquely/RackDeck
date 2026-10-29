/**
 * Peer URL shape validation, shared by the server and the dashboard.
 *
 * This module intentionally contains no DNS or `net` imports. The browser can reject a
 * malformed address before a round trip, while the server remains the authority for the
 * address policy (private, CGNAT and unique-local ranges).
 */

export class PeerUrlShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerUrlShapeError";
  }
}

/**
 * Validate the shape of a peer base URL and return the parsed URL.
 *
 * A peer is served at its root, so a path prefix is rejected rather than guessed at. The
 * canonical form is the origin, which drops a trailing slash.
 */
export function parsePeerUrlShape(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PeerUrlShapeError("must be an absolute http or https URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PeerUrlShapeError("must use the http or https scheme");
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new PeerUrlShapeError("must not contain a username or password");
  }

  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new PeerUrlShapeError("must not contain a query string or fragment");
  }

  if (parsed.pathname !== "/") {
    throw new PeerUrlShapeError("must point at the peer root (path /)");
  }

  if (parsed.port === "0") {
    throw new PeerUrlShapeError("must not use port 0");
  }

  return parsed;
}
