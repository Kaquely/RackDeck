import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isLoopback,
  parseProcNetDev,
  totalNonLoopback,
} from "../../src/server/collectors/proc-net-dev.ts";
import { cpuUsageBetween, deriveDirectionalRate } from "../../src/server/collectors/host.ts";

/** A realistic `/proc/net/dev` excerpt, captured from a Linux host. */
const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  120000    900    0    0    0     0          0         0   120000    900    0    0    0     0       0          0
  eth0: 5000000  40000    1    2    0     0          0        50  3000000  30000    3    4    0     0       0          0
  eth1:    1000     10    0    0    0     0          0         0     2000     20    0    0    0     0       0          0
`;

describe("parseProcNetDev", () => {
  it("parses every interface", () => {
    const counters = parseProcNetDev(PROC_NET_DEV);

    assert.deepEqual(counters, [
      { iface: "lo", rxBytes: 120000, txBytes: 120000 },
      { iface: "eth0", rxBytes: 5000000, txBytes: 3000000 },
      { iface: "eth1", rxBytes: 1000, txBytes: 2000 },
    ]);
  });

  it("skips the header and blank lines", () => {
    const counters = parseProcNetDev(PROC_NET_DEV);
    assert.equal(counters.length, 3);
  });

  it("returns an empty list for empty input", () => {
    assert.deepEqual(parseProcNetDev(""), []);
    assert.deepEqual(parseProcNetDev("\n\n"), []);
  });

  it("skips a malformed line rather than throwing", () => {
    const text =
      "Inter-|   Receive\n face |bytes\ngarbage line without a colon\n  eth0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0\n";
    const counters = parseProcNetDev(text);

    assert.deepEqual(counters, [{ iface: "eth0", rxBytes: 10, txBytes: 20 }]);
  });

  it("handles an interface name that itself contains a colon", () => {
    // VLAN sub-interfaces are named eth0:1, so the split must use the last colon.
    const text = "  eth0:1:  500 5 0 0 0 0 0 0  400 4 0 0 0 0 0 0\n";
    const counters = parseProcNetDev(text);

    assert.deepEqual(counters, [{ iface: "eth0:1", rxBytes: 500, txBytes: 400 }]);
  });

  it("skips a line whose counters are not numbers", () => {
    const text = "  eth0:  abc 1 0 0 0 0 0 0  def 1 0 0 0 0 0 0\n";
    assert.deepEqual(parseProcNetDev(text), []);
  });
});

describe("isLoopback", () => {
  it("identifies loopback interfaces", () => {
    assert.equal(isLoopback("lo"), true);
    assert.equal(isLoopback("lo0"), false);
    assert.equal(isLoopback("lo:1"), true);
    assert.equal(isLoopback("eth0"), false);
  });
});

describe("totalNonLoopback", () => {
  it("excludes loopback traffic", () => {
    // Loopback would otherwise dominate the figure and make the chart useless.
    const totals = totalNonLoopback(parseProcNetDev(PROC_NET_DEV));

    assert.equal(totals.rxBytes, 5001000);
    assert.equal(totals.txBytes, 3002000);
  });

  it("returns zeroes when there are no counters", () => {
    assert.deepEqual(totalNonLoopback([]), { rxBytes: 0, txBytes: 0 });
  });
});

describe("cpuUsageBetween", () => {
  it("returns null for the first reading", () => {
    // No predecessor means genuinely unknown, not zero.
    assert.equal(cpuUsageBetween(null, { idle: 100, total: 200 }), null);
  });

  it("returns null when no time has passed", () => {
    assert.equal(cpuUsageBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 }), null);
  });

  it("returns 0 when all time was idle", () => {
    const usage = cpuUsageBetween({ idle: 100, total: 200 }, { idle: 150, total: 250 });

    assert.ok(usage !== null);
    assert.ok(Math.abs(usage) < 1e-9, `expected ~0, got ${usage}`);
  });

  it("returns 100 when no time was idle", () => {
    const usage = cpuUsageBetween({ idle: 100, total: 200 }, { idle: 100, total: 300 });

    assert.ok(usage !== null);
    assert.ok(Math.abs(usage - 100) < 1e-9, `expected ~100, got ${usage}`);
  });

  it("computes a partial load", () => {
    // 50 of 100 ticks busy.
    const usage = cpuUsageBetween({ idle: 100, total: 200 }, { idle: 150, total: 300 });

    assert.ok(usage !== null);
    assert.ok(Math.abs(usage - 50) < 1e-9, `expected 50, got ${usage}`);
  });

  it("clamps a value outside 0..100 rather than publishing nonsense", () => {
    // Idle delta larger than total delta should be impossible, but a bad counter must not
    // put -50 on a gauge.
    const usage = cpuUsageBetween({ idle: 100, total: 200 }, { idle: 300, total: 250 });

    assert.ok(usage !== null);
    assert.ok(usage >= 0 && usage <= 100, `expected a clamped value, got ${usage}`);
  });
});

describe("deriveDirectionalRate", () => {
  const previous = { rxBytes: 1000, txBytes: 2000, at: 0 };

  it("returns null without a previous reading", () => {
    assert.equal(
      deriveDirectionalRate({ rxBytes: 5000, txBytes: 5000, at: 2000 }, null, "rx"),
      null,
    );
  });

  it("returns null when the current reading is absent", () => {
    assert.equal(deriveDirectionalRate(null, previous, "rx"), null);
  });

  it("returns null when no time has elapsed", () => {
    assert.equal(
      deriveDirectionalRate({ rxBytes: 5000, txBytes: 5000, at: 0 }, previous, "rx"),
      null,
    );
  });

  it("divides the delta by the elapsed seconds", () => {
    // 4000 bytes in 2 seconds.
    const rate = deriveDirectionalRate({ rxBytes: 5000, txBytes: 6000, at: 2000 }, previous, "rx");

    assert.equal(rate, 2000);
  });

  it("computes each direction independently", () => {
    const current = { rxBytes: 5000, txBytes: 4000, at: 1000 };

    assert.equal(deriveDirectionalRate(current, previous, "rx"), 4000);
    assert.equal(deriveDirectionalRate(current, previous, "tx"), 2000);
  });

  it("returns zero when the counter did not move", () => {
    // No traffic is a real, reportable value, distinct from "unknown": time passed and the
    // counter genuinely did not change.
    const rate = deriveDirectionalRate({ rxBytes: 1000, txBytes: 2000, at: 2000 }, previous, "rx");

    assert.equal(rate, 0);
  });

  it("returns null when time passed but no predecessor existed", () => {
    // Distinct from a zero rate: there is nothing to difference against.
    assert.equal(
      deriveDirectionalRate({ rxBytes: 1000, txBytes: 2000, at: 2000 }, null, "rx"),
      null,
    );
  });

  it("returns null when the counter went backwards", () => {
    // An interface cycling resets its counter. A negative rate would be nonsense.
    const rate = deriveDirectionalRate({ rxBytes: 10, txBytes: 10, at: 2000 }, previous, "rx");

    assert.equal(rate, null);
  });
});
