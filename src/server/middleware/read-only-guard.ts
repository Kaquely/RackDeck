import type { NextFunction, Request, Response } from "express";

/**
 * Enforce the read-only contract at the routing layer.
 *
 * The product observes systems and must never mutate them. Express would answer `404` to a
 * `POST` on a path that only has a `GET` handler, which is an unhelpful way to say "no" and
 * is easy to overlook. This guard answers `405` with a correct `Allow` header instead, and it
 * makes the guarantee a property of the route table that the contract tests can assert,
 * rather than a convention a future contributor has to remember.
 *
 * `/api/layout` is the single writable resource, and it is the product's own document, not
 * an observed system.
 */

/** Observed data and version metadata: readable, never writable. */
const READ_ONLY_PATHS = ["/api/readings", "/api/sources", "/api/version", "/api/update"] as const;

/** The product's own document: readable and replaceable, never partially mutated. */
const LAYOUT_METHODS = new Set(["GET", "HEAD", "PUT"]);

/** Peer management is product-owned configuration, not observed data. */
const PEER_COLLECTION_METHODS = new Set(["GET", "HEAD", "POST"]);
const PEER_VERIFY_METHODS = new Set(["POST"]);
const PEER_RECORD_METHODS = new Set(["DELETE"]);

function matchesPath(requestPath: string, base: string): boolean {
  return requestPath === base || requestPath.startsWith(`${base}/`);
}

function deny(response: Response, allow: string): void {
  response.set("Allow", allow);
  response.status(405).json({
    error: {
      code: "method_not_allowed",
      message: "This product is read-only. Observed data cannot be modified.",
    },
  });
}

export function enforceReadOnlyApi(request: Request, response: Response, next: NextFunction): void {
  const { method, path: requestPath } = request;

  for (const base of READ_ONLY_PATHS) {
    if (!matchesPath(requestPath, base)) continue;
    if (method === "GET" || method === "HEAD") {
      next();
      return;
    }
    deny(response, "GET, HEAD");
    return;
  }

  if (matchesPath(requestPath, "/api/layout")) {
    if (LAYOUT_METHODS.has(method)) {
      next();
      return;
    }
    response.set("Allow", "GET, HEAD, PUT");
    response.status(405).json({
      error: {
        code: "method_not_allowed",
        message: "The layout is replaced as a whole document; it cannot be patched or deleted.",
      },
    });
    return;
  }

  if (requestPath === "/api/peers") {
    if (PEER_COLLECTION_METHODS.has(method)) {
      next();
      return;
    }
    deny(response, "GET, HEAD, POST");
    return;
  }

  if (requestPath === "/api/peers/verify") {
    if (PEER_VERIFY_METHODS.has(method)) {
      next();
      return;
    }
    deny(response, "POST");
    return;
  }

  if (requestPath.startsWith("/api/peers/")) {
    if (PEER_RECORD_METHODS.has(method)) {
      next();
      return;
    }
    deny(response, "DELETE");
    return;
  }

  next();
}
