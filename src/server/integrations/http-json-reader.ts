/**
 * The one way this product reads an observed system.
 *
 * `HttpJsonReader` has a single public method and it issues a single verb. There is no
 * `post`, no `put`, no `delete` and no escape hatch: a collector that wants data calls
 * `getJson` and cannot express anything else. That is deliberate. The product's defining
 * promise is that it cannot change anything it observes, and a promise enforced only by
 * convention is a promise a future contributor breaks by accident.
 *
 * The documented exception — establishing an authentication session — deliberately does not
 * live here. It is a separate, named function in the Pi-hole integration, so the exception is
 * visible in exactly one place and cannot be reached from a generic reader.
 */

/** Why a request failed, in terms a caller can branch on. */
export type IntegrationErrorReason =
  "unreachable" | "status" | "malformed" | "too-large" | "timeout" | "auth";

export class IntegrationError extends Error {
  readonly reason: IntegrationErrorReason;
  /** HTTP status, when the failure was a non-2xx response. */
  readonly status?: number;

  constructor(reason: IntegrationErrorReason, message: string, status?: number) {
    super(message);
    this.name = "IntegrationError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Strip credentials and query strings from a URL before it appears in a message.
 *
 * An operator may legitimately have written `http://user:pass@pi.hole/admin`, and an error
 * message that echoes the URL verbatim would then disclose a credential in a log line or in the
 * browser. Only the origin is ever shown.
 */
export function redactUrl(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * The shape this module needs from a stream reader.
 *
 * Declared locally because `Response.body` resolves without a typed reader under this project's
 * lib set, and destructuring `any` defeats the type safety the rest of the file relies on.
 */
interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

/** Validate a base URL and normalise it so relative paths append rather than replace. */
export function normaliseBaseUrl(raw: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${variable} must be an absolute http or https URL, received "${raw}". Example: http://pihole.lan:8080`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${variable} must be an http or https URL including a scheme, received the "${parsed.protocol.replace(":", "")}" scheme from "${raw}". Example: http://pihole.lan:8080`,
    );
  }

  // A trailing slash makes `new URL(path, base)` append instead of replacing the last segment,
  // which is what an operator expects from a base URL that includes a path prefix.
  const withSlash = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return `${parsed.origin}${withSlash}`;
}

export type RedirectPolicy = "error" | "follow" | "manual";

export type HttpJsonReaderOptions = {
  baseUrl: string;
  timeoutMs: number;
  /** Cap on the response body. Guards against an application returning something enormous. */
  maxBytes?: number;
  /**
   * Redirect policy. Peer collectors use `error`: a redirect could otherwise forward an
   * Authorization header to a host the operator did not choose.
   */
  redirect?: RedirectPolicy;
  /** Injectable so tests can drive failures without a socket. */
  fetchFn?: typeof fetch;
  /** Injectable so tests can drive timeouts deterministically. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

const DEFAULT_MAX_BYTES = 1_048_576;

export class HttpJsonReader {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #redirect: RedirectPolicy;
  readonly #fetch: typeof fetch;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;

  constructor(options: HttpJsonReaderOptions) {
    this.#baseUrl = normaliseBaseUrl(options.baseUrl, "integration baseUrl");
    this.#timeoutMs = options.timeoutMs;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#redirect = options.redirect ?? "follow";
    this.#fetch = options.fetchFn ?? globalThis.fetch;
    this.#setTimeout = options.setTimeoutFn ?? setTimeout;
    this.#clearTimeout = options.clearTimeoutFn ?? clearTimeout;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * Read JSON with a GET request.
   *
   * The response is streamed with a byte cap enforced *while* reading, so an oversized body is
   * refused rather than buffered and then measured — the difference between a bounded process
   * and one that briefly holds whatever the other end chose to send.
   */
  async getJson<T>(path: string, options: { headers?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ""), this.#baseUrl).href;

    const controller = new AbortController();
    // Not unref'd: the caller awaits this, so the timer must keep the loop alive until the
    // request settles one way or the other.
    const timer = this.#setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        // A caller may supply headers — an application session cookie, for instance — but the
        // verb stays GET no matter what is passed in.
        headers: options.headers,
        signal: controller.signal,
        redirect: this.#redirect,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new IntegrationError(
          "timeout",
          `no response from ${redactUrl(url)} within ${this.#timeoutMs}ms`,
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new IntegrationError("unreachable", `could not reach ${redactUrl(url)}: ${detail}`);
    } finally {
      this.#clearTimeout(timer);
    }

    if (!response.ok) {
      // Deliberately does not echo the body. An error page from another application can contain
      // markup, credentials, or an HTML login form, and none of that belongs in a log line.
      throw new IntegrationError(
        "status",
        `${redactUrl(url)} answered ${response.status} ${response.statusText}`.trimEnd(),
        response.status,
      );
    }

    const body = await this.#readBounded(url, response);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new IntegrationError("malformed", `${redactUrl(url)} returned a body that is not JSON`);
    }
  }

  async #readBounded(url: string, response: Response): Promise<string> {
    const body = response.body;
    // A response with no stream is legal in tests and for a zero-length body.
    if (body === null) return "";

    const reader: ByteStreamReader = body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let received = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;

        received += value.byteLength;
        if (received > this.#maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new IntegrationError(
            "too-large",
            `${redactUrl(url)} returned more than ${this.#maxBytes} bytes`,
          );
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally {
      reader.releaseLock();
    }

    return chunks.join("");
  }
}
