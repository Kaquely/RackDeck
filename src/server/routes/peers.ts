import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type {
  PeerAddResponse,
  PeerDeleteResponse,
  PeerInfoResponse,
  PeersResponse,
  PeerVerifyResponse,
} from "../../shared/api.ts";
import {
  PeerNotFoundError,
  PeerValidationError,
  PeerVerificationError,
} from "../peers/peer-manager.ts";
import type { PeerManager } from "../peers/peer-manager.ts";
import { PeerStoreConflictError } from "../peers/peer-store.ts";

/** The peer's own identity. Mounted only on a peer and wrapped in authentication. */
export function peerInfoRouter(dependencies: { version: string; peerId: string }): Router {
  const router = Router();

  router.get("/peer/info", (_request, response) => {
    const body: PeerInfoResponse = {
      role: "peer",
      version: dependencies.version,
      id: dependencies.peerId,
    };
    response.status(200).json(body);
  });

  return router;
}

function readString(body: unknown, field: string): string {
  if (typeof body !== "object" || body === null) {
    throw new PeerValidationError("request body must be a JSON object");
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw new PeerValidationError(`${field} must be a string`);
  }
  return value;
}

function handleError(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof PeerValidationError) {
    response.status(400).json({ error: { code: "invalid_peer", message: error.message } });
    return;
  }
  if (error instanceof PeerStoreConflictError) {
    response.status(409).json({ error: { code: "peer_conflict", message: error.message } });
    return;
  }
  if (error instanceof PeerNotFoundError) {
    response.status(404).json({ error: { code: "peer_not_found", message: error.message } });
    return;
  }
  if (error instanceof PeerVerificationError) {
    response
      .status(502)
      .json({ error: { code: "peer_verification_failed", message: error.message } });
    return;
  }
  next(error);
}

/** Main-node peer management. The app mounts this only when the role is `main`. */
export function peersRouter(manager: PeerManager): Router {
  const router = Router();

  router.get("/peers", (_request, response) => {
    const body: PeersResponse = { peers: manager.list() };
    response.status(200).json(body);
  });

  router.post("/peers/verify", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const body: PeerVerifyResponse = await manager.verify({
        url: readString(request.body, "url"),
        token: readString(request.body, "token"),
      });
      response.status(200).json(body);
    } catch (error) {
      handleError(error, response, next);
    }
  });

  router.post("/peers", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const peer = await manager.add({
        label: readString(request.body, "label"),
        url: readString(request.body, "url"),
        token: readString(request.body, "token"),
      });
      const body: PeerAddResponse = { peer };
      response.status(201).json(body);
    } catch (error) {
      handleError(error, response, next);
    }
  });

  router.delete("/peers/:id", async (request: Request, response: Response, next: NextFunction) => {
    try {
      await manager.remove(String(request.params.id ?? ""));
      const body: PeerDeleteResponse = { removed: true };
      response.status(200).json(body);
    } catch (error) {
      handleError(error, response, next);
    }
  });

  return router;
}
