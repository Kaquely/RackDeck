import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PeerUrlError,
  isAllowedPeerAddress,
  parsePeerUrl,
  resolvePeerUrl,
} from "../../src/config/peer-url.ts";
import { PeerUrlShapeError, parsePeerUrlShape } from "../../src/shared/peer-url.ts";

const privateAnswer = [{ address: "192.168.1.20", family: 4 }];

describe("peer URL shape", () => {
  it("accepts a root http or https URL and canonicalises it", () => {
    assert.equal(parsePeerUrlShape("http://192.168.0.10:3000").origin, "http://192.168.0.10:3000");
    assert.equal(parsePeerUrlShape("https://peer.lan/").origin, "https://peer.lan");
    assert.equal(parsePeerUrl("http://100.64.0.5:3000/").origin, "http://100.64.0.5:3000");
  });

  it("rejects credentials, query strings, fragments and paths", () => {
    for (const url of [
      "http://user:pass@192.168.0.10:3000",
      "http://192.168.0.10:3000/?x=1",
      "http://192.168.0.10:3000/#x",
      "http://192.168.0.10:3000/api",
      "ftp://192.168.0.10:3000",
      "192.168.0.10:3000",
      "http://192.168.0.10:0",
    ]) {
      assert.throws(() => parsePeerUrlShape(url), PeerUrlShapeError, url);
    }
  });
});

describe("peer address policy", () => {
  it("allows private, CGNAT and unique-local addresses", () => {
    for (const address of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "100.64.0.1",
      "100.127.255.254",
      "fd00::1",
      "fc00::1",
      "::ffff:192.168.0.1",
    ]) {
      assert.equal(isAllowedPeerAddress(address), true, address);
    }
  });

  it("rejects loopback, link-local, metadata, public and special addresses", () => {
    for (const address of [
      "127.0.0.1",
      "127.0.0.53",
      "169.254.1.1",
      "169.254.169.254",
      "8.8.8.8",
      "1.1.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "fe80::1",
      "2001:db8::1",
      "ff02::1",
      "not-an-ip",
    ]) {
      assert.equal(isAllowedPeerAddress(address), false, address);
    }
  });

  it("rejects a public literal at parse time", () => {
    assert.throws(
      () => parsePeerUrl("http://8.8.8.8:3000"),
      (error: unknown) => {
        assert.ok(error instanceof PeerUrlError);
        assert.equal(error.reason, "disallowed-address");
        return true;
      },
    );
  });
});

describe("peer URL resolution", () => {
  it("accepts a hostname whose every answer is private", async () => {
    const result = await resolvePeerUrl("http://peer.lan:3000", () =>
      Promise.resolve([
        { address: "192.168.1.20", family: 4 },
        { address: "fd00::20", family: 6 },
      ]),
    );

    assert.equal(result.url, "http://peer.lan:3000");
    assert.deepEqual(result.addresses, ["192.168.1.20", "fd00::20"]);
  });

  it("rejects a hostname with any public answer", async () => {
    await assert.rejects(
      () =>
        resolvePeerUrl("http://peer.lan:3000", () =>
          Promise.resolve([
            { address: "192.168.1.20", family: 4 },
            { address: "203.0.113.10", family: 4 },
          ]),
        ),
      (error: unknown) => {
        assert.ok(error instanceof PeerUrlError);
        assert.equal(error.reason, "disallowed-address");
        return true;
      },
    );
  });

  it("rejects a loopback hostname such as localhost", async () => {
    await assert.rejects(
      () =>
        resolvePeerUrl("http://localhost:3000", () =>
          Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
        ),
      (error: unknown) => {
        assert.ok(error instanceof PeerUrlError);
        assert.equal(error.reason, "disallowed-address");
        return true;
      },
    );
  });

  it("rejects an unresolved hostname", async () => {
    await assert.rejects(
      () => resolvePeerUrl("http://missing.lan:3000", () => Promise.reject(new Error("ENOTFOUND"))),
      (error: unknown) => {
        assert.ok(error instanceof PeerUrlError);
        assert.equal(error.reason, "unresolvable");
        return true;
      },
    );
  });

  it("rejects an empty DNS answer", async () => {
    await assert.rejects(
      () =>
        resolvePeerUrl("http://empty.lan:3000", () => Promise.resolve(privateAnswer.slice(0, 0))),
      /has no addresses/,
    );
  });

  it("returns a literal address without asking DNS", async () => {
    let asked = false;
    const result = await resolvePeerUrl("http://10.0.0.5:3000", () => {
      asked = true;
      return Promise.resolve(privateAnswer);
    });

    assert.equal(asked, false);
    assert.deepEqual(result.addresses, ["10.0.0.5"]);
  });
});
