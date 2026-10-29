import { IntegrationError, redactUrl } from "../http-json-reader.ts";
import { normaliseBaseUrl } from "../http-json-reader.ts";

/**
 * Pi-hole session establishment.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE DOCUMENTED READ-ONLY EXCEPTION.
 *
 * The product promises not to change anything it observes. `HttpJsonReader` enforces that
 * structurally: it has exactly one method and it issues one verb, so no collector can express a
 * mutation.
 *
 * Pi-hole v6 removed the `?auth=` query parameter that v5 accepted, so a session has to be
 * created. That is why this function exists, here, as the single place in the codebase that
 * sends a non-GET request to an observed system. It is deliberately not a method on the reader,
 * so it cannot be reached by accident from a collector.
 *
 * Creating a session changes no observed state: not DNS configuration, not a blocklist, not a
 * client, not a query counter. It is what a browser does when a person logs in to look at a
 * graph. The read-only guarantee is therefore "no request that changes the observed system's
 * state", with this request named as the exception, rather than being weakened into something
 * that would let any future integration mutate anything.
 *
 * ---------------------------------------------------------------------------
 */

/** Named in error messages so the operator knows which variable to fix. The value is never used. */
export const PIHOLE_PASSWORD_VARIABLE = "HOMELABMD_PIHOLE_PASSWORD";

export type EstablishSessionOptions = {
  baseUrl: string;
  /** Secret. Used in the request body only; never logged, never placed in an error message. */
  password: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};

/** Pull the `sid` cookie out of a `Set-Cookie` header, if there is one. */
export function extractSid(setCookie: string | null): string | null {
  if (setCookie === null) return null;
  for (const part of setCookie.split(";")) {
    const [name, ...rest] = part.split("=");
    if (name?.trim() === "sid") {
      return rest.join("=").trim();
    }
  }
  return null;
}

/**
 * Establish a session and return the `sid` cookie value, or null if the deployment does not use
 * cookie sessions (for example a passwordless API).
 */
export async function establishSession(options: EstablishSessionOptions): Promise<string | null> {
  const base = normaliseBaseUrl(options.baseUrl, "HOMELABMD_PIHOLE_URL");
  const url = new URL("api/auth", base).href;
  const doFetch = options.fetchFn ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ password: options.password }),
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new IntegrationError(
        "timeout",
        `Pi-hole at ${redactUrl(url)} did not respond to authentication within ${options.timeoutMs}ms`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new IntegrationError(
      "unreachable",
      `could not reach Pi-hole at ${redactUrl(url)}: ${detail}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Names the variable and says nothing about its value. A wrong password is the single most
    // likely cause, and the message has to be actionable without ever being a disclosure.
    throw new IntegrationError(
      "auth",
      `Pi-hole rejected the authentication request (HTTP ${response.status}); check ${PIHOLE_PASSWORD_VARIABLE}`,
    );
  }

  return extractSid(response.headers.get("set-cookie"));
}
