import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HttpJsonReader,
  IntegrationError,
  normaliseBaseUrl,
  redactUrl,
} from "../../src/server/integrations/http-json-reader.ts";

/**
 * The transport is where the read-only promise is enforced structurally, so it is tested for
 * what it *cannot* do as well as what it can.
 */

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Build a reader with a stub fetch, recording every request it was asked to make. */
function readerWith(
  respond: (url: string, init: RequestInit) => Promise<Response> | Response,
  overrides: { maxBytes?: number; fetchFn?: typeof fetch } = {},
): { reader: HttpJsonReader; calls: { url: string; method: string | undefined }[] } {
  const calls: { url: string; method: string | undefined }[] = [];
  const asUrl = (input: string | URL | Request): string =>
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = asUrl(input);
    calls.push({ url, method: init.method });
    return await respond(url, init);
  }) as typeof fetch;

  return {
    reader: new HttpJsonReader({
      baseUrl: "http://pihole.test:8080",
      timeoutMs: 1_000,
      fetchFn: overrides.fetchFn ?? fetchFn,
      ...(overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes }),
    }),
    calls,
  };
}

describe("normaliseBaseUrl", () => {
  it("adds a trailing slash so relative paths append", () => {
    assert.equal(normaliseBaseUrl("http://pi.hole:8080", "V"), "http://pi.hole:8080/");
  });

  it("keeps a path prefix", () => {
    assert.equal(normaliseBaseUrl("https://pi.hole/admin", "V"), "https://pi.hole/admin/");
  });

  it("does not double a trailing slash", () => {
    assert.equal(normaliseBaseUrl("http://pi.hole/", "V"), "http://pi.hole/");
  });

  it("rejects a URL that has lost its scheme", () => {
    // "pi.hole:8080" parses — as the scheme "pi.hole" with the path "8080" — so the scheme check
    // is what catches it, and the message has to explain that rather than just quoting the scheme.
    assert.throws(
      () => normaliseBaseUrl("pi.hole:8080", "MY_VAR"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /MY_VAR/);
        assert.match(error.message, /http or https URL including a scheme/);
        return true;
      },
    );
  });

  it("rejects a genuinely unparseable URL", () => {
    assert.throws(
      () => normaliseBaseUrl("not a url at all", "MY_VAR"),
      /MY_VAR must be an absolute/,
    );
  });

  it("rejects a non-http scheme", () => {
    // A file:// or gopher:// base would let a misconfiguration read the local filesystem.
    assert.throws(
      () => normaliseBaseUrl("file:///etc/passwd", "MY_VAR"),
      /http or https URL including a scheme/,
    );
    assert.throws(
      () => normaliseBaseUrl("ftp://pi.hole", "MY_VAR"),
      /http or https URL including a scheme/,
    );
  });
});

describe("redactUrl", () => {
  it("keeps only the origin", () => {
    assert.equal(redactUrl("http://pi.hole:8080/admin/api/stats"), "http://pi.hole:8080");
  });

  it("removes embedded credentials", () => {
    // An operator may legitimately write `http://user:pass@pi.hole`. Echoing that into an
    // error message would put a credential in a log line.
    assert.equal(redactUrl("http://user:sup3rsecret@pi.hole/admin"), "http://pi.hole");
  });

  it("survives an unparseable url", () => {
    assert.equal(redactUrl("not a url"), "(unparseable url)");
  });
});

describe("HttpJsonReader", () => {
  it("exposes exactly one data method, and it reads", () => {
    // The structural guarantee behind the read-only promise: there is no method a collector
    // could use to mutate anything.
    const { reader } = readerWith(() => jsonResponse({ ok: true }));

    const members = Object.getOwnPropertyNames(HttpJsonReader.prototype).filter(
      (name) => name !== "constructor" && !name.startsWith("#"),
    );
    assert.deepEqual(
      members.filter((name) => typeof reader[name as "getJson"] === "function"),
      ["getJson"],
    );
  });

  it("always issues GET", async () => {
    const { reader, calls } = readerWith(() => jsonResponse({}));

    await reader.getJson("api/stats/summary");

    assert.deepEqual(calls, [{ url: "http://pihole.test:8080/api/stats/summary", method: "GET" }]);
  });

  it("issues GET even when headers are supplied", async () => {
    const { reader, calls } = readerWith(() => jsonResponse({}));

    await reader.getJson("api/stats/summary", { headers: { cookie: "sid=abc" } });

    assert.equal(calls[0]?.method, "GET");
  });

  it("treats a leading slash as relative to the base", async () => {
    const { reader, calls } = readerWith(() => jsonResponse({}));

    await reader.getJson("/api/stats/summary");

    assert.equal(calls[0]?.url, "http://pihole.test:8080/api/stats/summary");
  });

  it("resolves against a base path", async () => {
    const calls: string[] = [];
    const fetchFn = ((url: string | URL) => {
      calls.push(url instanceof URL ? url.href : url);
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;
    const reader = new HttpJsonReader({
      baseUrl: "http://pi.hole/admin",
      timeoutMs: 1_000,
      fetchFn,
    });

    await reader.getJson("api/stats/summary");

    assert.deepEqual(calls, ["http://pi.hole/admin/api/stats/summary"]);
  });

  it("returns the parsed body", async () => {
    const { reader } = readerWith(() => jsonResponse({ total: 12 }));

    assert.deepEqual(await reader.getJson("api/stats/summary"), { total: 12 });
  });

  it("passes headers through to the request", async () => {
    let seen: unknown;
    const fetchFn = ((_url: string | URL, init: RequestInit = {}) => {
      seen = init.headers;
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;
    const reader = new HttpJsonReader({ baseUrl: "http://pi.hole", timeoutMs: 1_000, fetchFn });

    await reader.getJson("api/auth", { headers: { cookie: "sid=xyz" } });

    assert.deepEqual(seen, { cookie: "sid=xyz" });
  });

  it("follows redirects by default and can reject them instead", async () => {
    const seen: (RequestInit["redirect"] | undefined)[] = [];
    const fetchFn = ((_url: string | URL, init: RequestInit = {}) => {
      seen.push(init.redirect);
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;

    const follow = new HttpJsonReader({ baseUrl: "http://pi.hole", timeoutMs: 1_000, fetchFn });
    await follow.getJson("api/stats/summary");

    const reject = new HttpJsonReader({
      baseUrl: "http://pi.hole",
      timeoutMs: 1_000,
      redirect: "error",
      fetchFn,
    });
    await reject.getJson("api/stats/summary");

    assert.deepEqual(seen, ["follow", "error"]);
  });

  describe("failures", () => {
    it("reports an unreachable host without leaking the URL's credentials", async () => {
      const leaky = new HttpJsonReader({
        baseUrl: "http://user:secret@pi.hole:8080",
        timeoutMs: 1_000,
        fetchFn: () => Promise.reject(new TypeError("fetch failed")),
      });

      await assert.rejects(leaky.getJson("api/stats/summary"), (error: unknown) => {
        assert.ok(error instanceof IntegrationError);
        assert.equal(error.reason, "unreachable");
        assert.ok(
          !error.message.includes("secret"),
          `message leaked a credential: ${error.message}`,
        );
        return true;
      });
    });

    it("reports a non-2xx status without echoing the body", async () => {
      // Another application's error page can contain markup, an HTML login form, or a
      // credential. None of it belongs in a log line.
      const { reader } = readerWith(
        () =>
          new Response("<html>token=abc123</html>", {
            status: 500,
            statusText: "Internal Server Error",
          }),
      );

      await assert.rejects(reader.getJson("api/stats/summary"), (error: unknown) => {
        assert.ok(error instanceof IntegrationError);
        assert.equal(error.reason, "status");
        assert.equal(error.status, 500);
        assert.ok(!error.message.includes("abc123"));
        return true;
      });
    });

    it("reports unparseable JSON", async () => {
      const { reader } = readerWith(() => new Response("<html>not json</html>", { status: 200 }));

      await assert.rejects(reader.getJson("api/stats/summary"), (error: unknown) => {
        assert.ok(error instanceof IntegrationError);
        assert.equal(error.reason, "malformed");
        return true;
      });
    });

    it("aborts a stalled request and reports a timeout", async () => {
      const fetchFn = ((_url: string | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch;
      const reader = new HttpJsonReader({
        baseUrl: "http://pi.hole",
        timeoutMs: 20,
        fetchFn,
      });

      await assert.rejects(reader.getJson("api/stats/summary"), (error: unknown) => {
        assert.ok(error instanceof IntegrationError);
        assert.equal(error.reason, "timeout");
        return true;
      });
    });

    it("refuses an oversized response instead of buffering it", async () => {
      const { reader } = readerWith(() => new Response("x".repeat(10_000), { status: 200 }), {
        maxBytes: 1_000,
      });

      await assert.rejects(reader.getJson("api/stats/summary"), (error: unknown) => {
        assert.ok(error instanceof IntegrationError);
        assert.equal(error.reason, "too-large");
        return true;
      });
    });

    it("accepts a response exactly at the cap", async () => {
      const payload = JSON.stringify({ total: 1 });
      const { reader } = readerWith(() => new Response(payload, { status: 200 }), {
        maxBytes: payload.length,
      });

      assert.deepEqual(await reader.getJson("api/stats/summary"), { total: 1 });
    });

    it("handles a response with no body", async () => {
      const { reader } = readerWith(() => new Response(null, { status: 204 }));

      await assert.rejects(reader.getJson("api/stats/summary"), IntegrationError);
    });
  });
});
