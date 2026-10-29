import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError, loadConfig } from "../../src/config/environment.ts";
import { logStartup } from "../../src/main.ts";
import { generatePeerToken } from "../../src/shared/peer-token.ts";

const TOKEN = generatePeerToken();

function peer(env: Record<string, string | undefined> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    HOMELABMD_ROLE: "peer",
    HOMELABMD_PEER_TOKEN: TOKEN,
    ...env,
  });
}

describe("node role configuration", () => {
  it("defaults to main", () => {
    const config = loadConfig({ NODE_ENV: "test" });

    assert.equal(config.role, "main");
    assert.equal(config.peerToken, null);
    assert.equal(config.peerAllowedIps, null);
    assert.equal(config.peerId, null);
    assert.match(config.peersFile, /peers\.json$/);
  });

  it("accepts main and peer explicitly", () => {
    assert.equal(loadConfig({ NODE_ENV: "test", HOMELABMD_ROLE: "main" }).role, "main");
    assert.equal(peer().role, "peer");
  });

  it("rejects an unknown role and names the variable", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "test", HOMELABMD_ROLE: "worker" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.variable, "HOMELABMD_ROLE");
        assert.match(error.message, /HOMELABMD_ROLE/);
        return true;
      },
    );
  });
});

describe("peer token configuration", () => {
  it("requires a token on a peer", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "test", HOMELABMD_ROLE: "peer" }),
      /HOMELABMD_PEER_TOKEN/,
    );
  });

  it("rejects a malformed token on a peer", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "test",
          HOMELABMD_ROLE: "peer",
          HOMELABMD_PEER_TOKEN: "hlp_short",
        }),
      /HOMELABMD_PEER_TOKEN/,
    );
  });

  it("accepts a valid token on a peer", () => {
    assert.equal(peer().peerToken, TOKEN);
  });

  it("rejects peer-only settings on a main node", () => {
    for (const variable of [
      "HOMELABMD_PEER_TOKEN",
      "HOMELABMD_PEER_ALLOWED_IPS",
      "HOMELABMD_PEER_ID",
    ]) {
      const value =
        variable === "HOMELABMD_PEER_TOKEN"
          ? TOKEN
          : variable === "HOMELABMD_PEER_ALLOWED_IPS"
            ? "192.168.0.10"
            : "node-main";
      assert.throws(
        () => loadConfig({ NODE_ENV: "test", HOMELABMD_ROLE: "main", [variable]: value }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.equal(error.variable, variable);
          return true;
        },
        variable,
      );
    }
  });
});

describe("peer allowlist configuration", () => {
  it("accepts addresses and CIDR blocks", () => {
    const config = peer({
      HOMELABMD_PEER_ALLOWED_IPS: "192.168.0.10, 100.64.0.0/10, fd00::/8, ::ffff:10.0.0.1",
    });

    assert.deepEqual(config.peerAllowedIps, [
      "192.168.0.10",
      "100.64.0.0/10",
      "fd00::/8",
      "::ffff:10.0.0.1",
    ]);
  });

  it("rejects malformed entries", () => {
    for (const value of [
      "not-an-ip",
      "10.0.0.0/33",
      "fd00::/129",
      "10.0.0.0/",
      "10.0.0.0/8/8",
      "10.0.0.0/abc",
      ",",
    ]) {
      assert.throws(
        () => peer({ HOMELABMD_PEER_ALLOWED_IPS: value }),
        /HOMELABMD_PEER_ALLOWED_IPS/,
        value,
      );
    }
  });
});

describe("peer identity configuration", () => {
  it("derives a stable id when none is given", () => {
    const config = peer();
    assert.ok(config.peerId !== null);
    assert.match(config.peerId, /^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  it("accepts an explicit id", () => {
    assert.equal(peer({ HOMELABMD_PEER_ID: "immich-node" }).peerId, "immich-node");
  });

  it("rejects an invalid id", () => {
    for (const value of ["Immich", "-node", "node_1", "a".repeat(65)]) {
      assert.throws(() => peer({ HOMELABMD_PEER_ID: value }), /HOMELABMD_PEER_ID/, value);
    }
  });
});

describe("peer store configuration", () => {
  it("rejects a file name with a directory component", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "test", HOMELABMD_PEERS_FILE: "../peers.json" }),
      /HOMELABMD_PEERS_FILE/,
    );
  });

  it("places the peer file beside the layout file", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      HOMELABMD_DATA_DIR: "runtime",
      HOMELABMD_LAYOUT_FILE: "dashboard.json",
      HOMELABMD_PEERS_FILE: "nodes.json",
    });

    assert.match(config.peersFile, /runtime[\\/]nodes\.json$/);
    assert.match(config.layoutFile, /runtime[\\/]dashboard\.json$/);
  });
});

describe("startup logging", () => {
  it("captures role, token presence and allowlist size without the token", () => {
    const config = peer({ HOMELABMD_PEER_ALLOWED_IPS: "192.168.1.10,100.64.0.10" });
    const lines: string[] = [];

    logStartup(config, { pihole: null }, [], (line) => lines.push(line));
    const output = lines.join("\n");

    assert.match(output, /role=peer/);
    assert.match(output, /token=present/);
    assert.match(output, /allowlist=2/);
    assert.equal(output.includes(TOKEN), false);
  });

  it("captures the peer count without any peer token on a main node", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const token = generatePeerToken();
    const lines: string[] = [];

    logStartup(
      config,
      { pihole: null },
      [
        {
          id: "node-a",
          label: "A",
          url: "http://192.168.0.20:3000/",
          timeoutMs: 5000,
          token,
          managed: true,
        },
      ],
      (line) => lines.push(line),
    );
    const output = lines.join("\n");

    assert.match(output, /role=main/);
    assert.match(output, /peers=node-a at http:\/\/192\.168\.0\.20:3000 \(auth=token\)/);
    assert.equal(output.includes(token), false);
  });
});
