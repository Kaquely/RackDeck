import type { ErrorRequestHandler, RequestHandler } from "express";
import type { NodeEnv } from "../../config/environment.ts";

/**
 * Terminal 404 for unmatched routes.
 *
 * Registered after every API route, so a typo in an API path is reported as JSON rather than
 * being swallowed by the SPA fallback, which would return `200` with an HTML page and send a
 * confused client into a parse error.
 */
export function notFoundHandler(): RequestHandler {
  return (request, response) => {
    response.status(404).json({
      error: {
        code: "not_found",
        message: `No route matches ${request.method} ${request.path}`,
      },
    });
  };
}

/**
 * Centralised error handler.
 *
 * In production an unexpected error is reported by code only: stack traces and driver
 * messages can disclose paths and integration details, and the dashboard may be reachable
 * from the LAN without authentication.
 */
export function errorHandler(nodeEnv: NodeEnv): ErrorRequestHandler {
  return (error, _request, response, _next) => {
    if (response.headersSent) return;

    const isProduction = nodeEnv === "production";

    if (isBodyParseError(error)) {
      response.status(400).json({
        error: { code: "invalid_json", message: "Request body is not valid JSON" },
      });
      return;
    }

    if (isPayloadTooLarge(error)) {
      response.status(413).json({
        error: { code: "payload_too_large", message: "Request body is too large" },
      });
      return;
    }

    if (isProduction) {
      console.error("Unhandled request error", error);
      response.status(500).json({
        error: { code: "internal_error", message: "An unexpected error occurred" },
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    response.status(500).json({
      error: { code: "internal_error", message },
    });
  };
}

function hasType(error: unknown, type: string): boolean {
  return typeof error === "object" && error !== null && (error as { type?: string }).type === type;
}

function isBodyParseError(error: unknown): boolean {
  return hasType(error, "entity.parse.failed");
}

function isPayloadTooLarge(error: unknown): boolean {
  return hasType(error, "entity.too.large");
}
