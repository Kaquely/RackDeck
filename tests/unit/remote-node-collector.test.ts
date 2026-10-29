import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRemoteNodeCollector } from "../../src/server/collectors/remote-node.ts";
import { IntegrationError } from "../../src/server/integrations/http-json-reader.ts";

type CollectorResult = {
  status: string;
  metrics: { metric: string; value: number | null }[];
  tables: { id: string }[];
};

const peerSnapshot = {
  generatedAt: 1,
  intervalMs: 500,
  sources: [{ id: "host", label: "Peer", kind: "host", status: "ok", lastSampleAt: 1 }],
  series: [
    {
      sourceId: "host",
      metric: "cpu.usage",
      label: "CPU usage",
      unit: "%",
      status: "ok",
      samples: [{ t: 1, v: 42 }],
    },
  ],
  tables: [{ id: "storage.disks", columns: ["mount"], rows: [{ mount: "/" }] }],
};

describe("createRemoteNodeCollector", () => {
  it("normalises a reachable peer using only GET", async () => {
    type Observation = { method?: string; url: string };
    const observed: Observation[] = [];
    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://192.168.0.5:3000",
        label: "Peer",
        timeoutMs: 100,
        token: null,
        managed: false,
      },
      {
        fetchFn: (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          observed.push({ method: init?.method, url });
          return Promise.resolve(
            new Response(JSON.stringify(peerSnapshot), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        },
      },
    );

    const result = await (collector.collect as () => Promise<CollectorResult>)();

    assert.equal(result.status, "ok");
    assert.equal(result.metrics[0]!.metric, "cpu.usage");
    assert.equal(result.metrics[0]!.value, 42);
    assert.equal(result.tables[0]!.id, "storage.disks");
    assert.equal(observed[0]!.method, "GET");
    assert.match(observed[0]!.url, /\/api\/readings/);
  });

  it("keeps null metric values null", async () => {
    const snapshot = JSON.parse(JSON.stringify(peerSnapshot)) as {
      series: { samples: { t: number; v: number | null }[] }[];
    };
    snapshot.series[0]!.samples = [{ t: 1, v: null }];

    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://192.168.0.5:3000",
        label: "Peer",
        timeoutMs: 100,
        token: null,
        managed: false,
      },
      { fetchFn: () => Promise.resolve(new Response(JSON.stringify(snapshot), { status: 200 })) },
    );

    const result = await (collector.collect as () => Promise<CollectorResult>)();
    assert.equal(result.metrics[0]!.value, null);
  });

  it("throws for malformed JSON", async () => {
    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://192.168.0.5:3000",
        label: "Peer",
        timeoutMs: 100,
        token: null,
        managed: false,
      },
      { fetchFn: () => Promise.resolve(new Response("not-json", { status: 200 })) },
    );

    await assert.rejects(
      () => (collector.collect as () => Promise<CollectorResult>)(),
      /not JSON/i,
    );
  });

  it("throws for an invalid shape", async () => {
    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://192.168.0.5:3000",
        label: "Peer",
        timeoutMs: 100,
        token: null,
        managed: false,
      },
      {
        fetchFn: () =>
          Promise.resolve(new Response(JSON.stringify({ wrong: true }), { status: 200 })),
      },
    );

    await assert.rejects(
      () => (collector.collect as () => Promise<CollectorResult>)(),
      /invalid readings payload/i,
    );
  });

  it("surfaces peer status as unavailable on HTTP failure", async () => {
    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://192.168.0.5:3000",
        label: "Peer",
        timeoutMs: 100,
        token: null,
        managed: false,
      },
      { fetchFn: () => Promise.resolve(new Response("oops", { status: 500 })) },
    );

    await assert.rejects(() => (collector.collect as () => Promise<CollectorResult>)());
  });

  it("sends the bearer token and rejects redirects", async () => {
    const token = `hlp_${"a".repeat(43)}`;
    let observed: RequestInit | undefined;

    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://192.168.0.5:3000",
        label: "Peer",
        timeoutMs: 100,
        token,
        managed: true,
      },
      {
        fetchFn: (_input, init) => {
          observed = init;
          return Promise.resolve(
            new Response(JSON.stringify(peerSnapshot), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        },
      },
    );

    await (collector.collect as () => Promise<CollectorResult>)();

    const headers = new Headers(observed?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(observed?.redirect, "error");
    assert.equal(observed?.method, "GET");
  });

  it("omits the Authorization header when the peer has no token", async () => {
    let observed: RequestInit | undefined;

    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://192.168.0.5:3000",
        label: "Peer",
        timeoutMs: 100,
        token: null,
        managed: false,
      },
      {
        fetchFn: (_input, init) => {
          observed = init;
          return Promise.resolve(new Response(JSON.stringify(peerSnapshot), { status: 200 }));
        },
      },
    );

    await (collector.collect as () => Promise<CollectorResult>)();

    assert.equal(new Headers(observed?.headers).has("authorization"), false);
  });

  it("maps a 401 to an authentication failure", async () => {
    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://192.168.0.5:3000",
        label: "Peer",
        timeoutMs: 100,
        token: `hlp_${"b".repeat(43)}`,
        managed: true,
      },
      { fetchFn: () => Promise.resolve(new Response("unauthorised", { status: 401 })) },
    );

    await assert.rejects(
      () => (collector.collect as () => Promise<CollectorResult>)(),
      (error: unknown) => {
        assert.ok(error instanceof IntegrationError);
        assert.equal(error.reason, "auth");
        assert.equal(error.status, 401);
        return true;
      },
    );
  });

  it("never contacts a peer whose URL the policy rejects", async () => {
    let contacted = false;

    const collector = createRemoteNodeCollector(
      {
        id: "node-peer",
        url: "http://127.0.0.1:3000",
        label: "Peer",
        timeoutMs: 100,
        token: null,
        managed: false,
      },
      {
        resolveUrl: () => Promise.reject(new Error("loopback is not allowed")),
        fetchFn: () => {
          contacted = true;
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
      },
    );

    await assert.rejects(
      () => (collector.collect as () => Promise<CollectorResult>)(),
      /peer URL rejected/,
    );
    assert.equal(contacted, false);
  });
});
