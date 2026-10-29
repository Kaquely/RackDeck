import { readFile } from "node:fs/promises";

/**
 * Network byte counters from `/proc/net/dev`.
 *
 * Node exposes interface addresses but never byte counters, so on Linux — the deployment
 * target — the kernel file is the only cheap source of a real throughput figure. Reading one
 * small file is roughly three orders of magnitude cheaper than the cross-platform alternative
 * measured at ~6 s per call.
 *
 * The parser is a pure function so it can be tested on any platform, including a Windows
 * development machine that has no `/proc` at all.
 */

export type InterfaceCounters = {
  iface: string;
  rxBytes: number;
  txBytes: number;
};

/**
 * Parse `/proc/net/dev` into per-interface counters.
 *
 * The format is two header lines followed by one line per interface:
 *
 * ```text
 * Inter-|   Receive                          |  Transmit
 *  face |bytes packets errs drop fifo frame compressed multicast|bytes packets ...
 *    lo: 1234 10 0 0 0 0 0 0                   1234 10 0 0 0 0 0 0
 *  eth0: 9999 20 0 0 0 0 0 0                   8888 15 0 0 0 0 0 0
 * ```
 */
export function parseProcNetDev(text: string): InterfaceCounters[] {
  const out: InterfaceCounters[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // Skip the two header lines and blank lines.
    if (line.length === 0) continue;
    if (line.startsWith("Inter-")) continue;
    if (line.startsWith("face")) continue;

    // The separator between the interface name and its counters is a colon, and the
    // interface name itself may contain a colon (eth0:1), so split on the last one.
    const separator = line.lastIndexOf(":");
    if (separator < 0) continue;

    const iface = line.slice(0, separator).trim();
    const fields = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/);

    // Receive: bytes packets errs drop fifo frame compressed multicast
    // Transmit: bytes packets errs drop fifo colls carrier compressed
    const rxBytes = Number.parseInt(fields[0] ?? "", 10);
    const txBytes = Number.parseInt(fields[8] ?? "", 10);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;

    out.push({ iface, rxBytes, txBytes });
  }

  return out;
}

/** True when this interface is loopback and should be excluded from a homelab total. */
export function isLoopback(iface: string): boolean {
  return iface === "lo" || iface.startsWith("lo:");
}

/**
 * Total receive and transmit bytes across non-loopback interfaces.
 *
 * Loopback is excluded because intra-node traffic would otherwise dominate the figure and
 * make the chart meaningless for the thing the operator cares about: traffic to and from
 * other machines.
 */
export function totalNonLoopback(counters: InterfaceCounters[]): {
  rxBytes: number;
  txBytes: number;
} {
  let rxBytes = 0;
  let txBytes = 0;
  for (const entry of counters) {
    if (isLoopback(entry.iface)) continue;
    rxBytes += entry.rxBytes;
    txBytes += entry.txBytes;
  }
  return { rxBytes, txBytes };
}

/**
 * Read the current counters, or null when `/proc/net/dev` is unavailable.
 *
 * A null result is not an error: it means the platform has no such file, and the caller
 * falls back to the slow-tier path.
 */
export async function readProcNetDev(): Promise<InterfaceCounters[] | null> {
  try {
    return parseProcNetDev(await readFile("/proc/net/dev", "utf8"));
  } catch {
    return null;
  }
}
