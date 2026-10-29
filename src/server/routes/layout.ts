import { Router } from "express";
import type { LayoutResponse } from "../../shared/api.ts";
import { validateLayout } from "../../shared/layout.ts";
import type { Layout } from "../../shared/layout.ts";
import { StoreValidationError } from "../../store/json-document-store.ts";
import type { JsonDocumentStore } from "../../store/json-document-store.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function layoutRouter(store: JsonDocumentStore<Layout>): Router {
  const router = Router();

  router.get("/layout", (_request, response) => {
    const body: LayoutResponse = { layout: store.get() };
    response.status(200).json(body);
  });

  /**
   * Replace the whole layout document.
   *
   * Validation is all-or-nothing. A partially applied layout would leave the dashboard in a
   * state the user cannot repair through the UI, so an invalid document is rejected whole
   * and stored state is left untouched. The stored document is echoed back so the client can
   * confirm what was actually saved rather than assuming its input was normalised.
   */
  router.put("/layout", async (request, response) => {
    // Express types `body` as `any`. It is narrowed to `unknown` before any inspection, and
    // the layout may be sent bare or wrapped in `{ layout }`, so the endpoint is pleasant to
    // call from curl as well as from the app.
    const rawBody: unknown = request.body;
    const candidate = isRecord(rawBody) && "layout" in rawBody ? rawBody.layout : rawBody;

    const result = validateLayout(candidate);
    if (!result.ok) {
      response.status(400).json({
        error: {
          code: "invalid_layout",
          message: "The layout document is not valid.",
          details: result.errors,
        },
      });
      return;
    }

    try {
      await store.set(result.value);
    } catch (error) {
      if (error instanceof StoreValidationError) {
        response.status(400).json({
          error: {
            code: "invalid_layout",
            message: "The layout document is not valid.",
            details: error.errors,
          },
        });
        return;
      }
      throw error;
    }

    const body: LayoutResponse = { layout: store.get() };
    response.status(200).json(body);
  });

  return router;
}
