import os from "node:os";
import si from "systeminformation";
import type { Systeminformation } from "systeminformation";
import type { TableData } from "../../shared/observations.ts";
import type { Collector, CollectorResult, MetricSample } from "./types.ts";
import { readProcNetDev, totalNonLoopback } from "./proc-net-dev.ts";

/**
 * The local machine.
 *
 * Sampling is tiered by measured cost, not by intuition. The 500 ms fast tier is built on
 * Node's built-in `os` module, which costs microseconds, so it adds no dependency and no
 * cross-platform penalty. The 5 s structural tier uses `systeminformation` for what actually
 * needs it: the filesystem table, the interface table and the process count.
 *
 * The tier split is based on measured cost: on the development machine
 * `systeminformation.networkStats()` costs about 6 seconds per call, which at a 500 ms
 * cadence would consume the entire scheduler.
 */

/** Structural metadata is re-read every N ticks: 10 ticks at 500 ms is 5 seconds. */
const SLOW_EVERY = 10;

/**
 * Every metric key and table id the host collector can publish.
 *
 * Declared as data so `defaultLayout()` can be checked against it. Without this, renaming a
 * metric would leave the shipped default layout pointing at a key that no longer exists and
 * the widget would silently render empty instead of failing.
 */
export const HOST_METRIC_KEYS = [
  "cpu.usage",
  "cpu.loadAverage",
  "memory.usage",
  "memory.usedBytes",
  "memory.totalBytes",
  "uptime.seconds",
  "network.rxBytesPerSecond",
  "network.txBytesPerSecond",
  "storage.usedPercent",
  "processes.total",
] as const;

export const HOST_TABLE_IDS = ["storage.disks", "network.interfaces"] as const;

export type HostMetricKey = (typeof HOST_METRIC_KEYS)[number];

type NetworkStatsData = Systeminformation.NetworkStatsData;

type Counters = { rxBytes: number; txBytes: number; at: number };

type SlowCache = {
  filesystems: TableData;
  interfaces: TableData;
  processTotal: number | null;
  /** Counters from the slow path, used as the rate fallback where /proc/net/dev is absent. */
  network: Counters | null;
  readAtTick: number;
};

export type CpuTimes = { idle: number; total: number };

export function createHostCollector(): Collector {
  // Held across calls deliberately: CPU usage and network throughput are both derived from
  // the difference between consecutive readings, and the slow tier is a cache.
  let previousCpu: CpuTimes | null = null;
  let previousFastNetwork: Counters | null = null;
  let previousSlowNetwork: Counters | null = null;
  let slow: SlowCache | null = null;
  let tick = 0;

  return {
    id: "host",
    label: "This machine",
    kind: "host",

    async collect(): Promise<CollectorResult> {
      const metrics: MetricSample[] = [];
      const now = Date.now();

      // --- fast tier: node:os, microseconds --------------------------------------
      const cpuTimes = readCpuTimes();
      const cpuUsage = cpuUsageBetween(previousCpu, cpuTimes);
      previousCpu = cpuTimes;

      const totalBytes = os.totalmem();
      const freeBytes = os.freemem();
      const usedBytes = Math.max(0, totalBytes - freeBytes);

      metrics.push(
        sample("cpu.usage", "CPU usage", "%", cpuUsage),
        sample("cpu.loadAverage", "Load average (1m)", "", firstPositive(os.loadavg())),
        sample("memory.usage", "Memory used", "%", percentage(usedBytes, totalBytes)),
        sample("memory.usedBytes", "Memory used", "bytes", usedBytes),
        sample("memory.totalBytes", "Memory total", "bytes", totalBytes),
        sample("uptime.seconds", "Uptime", "s", os.uptime()),
      );

      // --- network fast path: /proc/net/dev, one small file read on Linux ----------
      const procCounters = await readProcNetDev();
      let rxRate: number | null = null;
      let txRate: number | null = null;

      if (procCounters !== null) {
        const totals = { ...totalNonLoopback(procCounters), at: now };
        rxRate = deriveDirectionalRate(totals, previousFastNetwork, "rx");
        txRate = deriveDirectionalRate(totals, previousFastNetwork, "tx");
        previousFastNetwork = totals;
      }

      // --- slow tier: systeminformation -------------------------------------------
      const refreshedSlow = slow === null || tick % SLOW_EVERY === 0;
      if (refreshedSlow) {
        // `networkStats` is the most expensive call in the collector, so it is made exactly
        // once per slow cycle and reused for both the interface table and the off-Linux
        // rate fallback.
        const [filesystems, processes, networkStats] = await Promise.all([
          readFilesystems(),
          si.processes().then(
            (info) => info.all,
            () => null,
          ),
          si.networkStats().catch(() => [] as NetworkStatsData[]),
        ]);

        slow = {
          filesystems,
          interfaces: interfacesTable(networkStats),
          processTotal: processes,
          network: countersFromStats(networkStats, now),
          readAtTick: tick,
        };
      }
      tick += 1;

      const cache = slow;
      if (cache === null) {
        // Unreachable: the block above always populates `slow` on the first tick. Guarded so
        // the type is narrowed rather than asserted.
        return { status: "ok", metrics, tables: [] };
      }

      if (procCounters === null) {
        // No /proc/net/dev on this platform, so the rate can only be measured on a slow
        // cycle. The metrics are appended *only* when a fresh measurement exists: appending
        // a null on every fast cycle would put nine gaps between every real point, which
        // renders as a broken line rather than a coarser one.
        if (refreshedSlow) {
          rxRate = deriveDirectionalRate(cache.network, previousSlowNetwork, "rx");
          txRate = deriveDirectionalRate(cache.network, previousSlowNetwork, "tx");
          previousSlowNetwork = cache.network;
          metrics.push(
            sample("network.rxBytesPerSecond", "Network receive", "B/s", rxRate),
            sample("network.txBytesPerSecond", "Network transmit", "B/s", txRate),
          );
        }
      } else {
        metrics.push(
          sample("network.rxBytesPerSecond", "Network receive", "B/s", rxRate),
          sample("network.txBytesPerSecond", "Network transmit", "B/s", txRate),
        );
      }

      metrics.push(
        sample(
          "storage.usedPercent",
          "Disk usage (busiest mount)",
          "%",
          aggregateDiskUsage(cache.filesystems),
        ),
        sample("processes.total", "Processes", "", cache.processTotal),
      );

      return { status: "ok", metrics, tables: [cache.filesystems, cache.interfaces] };
    },
  };
}

/**
 * Cumulative CPU tick counters across all cores.
 *
 * `os.cpus()` reports total time spent in each state since boot. Differencing those counters
 * is how usage is derived, at a fraction of a millisecond per sample.
 */
export function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * CPU usage percentage between two readings.
 *
 * The first reading has no predecessor, so it yields null rather than a fabricated 0 or 100.
 * A zero-length window also yields null, because the alternative is a division by zero
 * dressed up as data.
 */
export function cpuUsageBetween(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (previous === null) return null;

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;

  const usage = (1 - idleDelta / totalDelta) * 100;
  if (!Number.isFinite(usage)) return null;
  return clamp(usage, 0, 100);
}

export type Direction = "rx" | "tx";

/**
 * Rate for one direction, in bytes per second.
 *
 * Null when there is no predecessor (the first sample), when no time has passed, or when the
 * counter went backwards. A backwards counter means the interface reset, and a negative rate
 * would be nonsense; null renders as a gap, which is honest.
 */
export function deriveDirectionalRate(
  current: Counters | null,
  previous: Counters | null,
  direction: Direction,
): number | null {
  if (current === null || previous === null) return null;

  const elapsedSeconds = (current.at - previous.at) / 1000;
  if (elapsedSeconds <= 0) return null;

  const key = direction === "rx" ? "rxBytes" : "txBytes";
  const delta = current[key] - previous[key];
  if (delta < 0) return null;

  return delta / elapsedSeconds;
}

function sample(
  metric: string,
  label: string,
  unit: string,
  value: number | null | undefined,
): MetricSample {
  return {
    metric,
    label,
    unit,
    // Absent and non-finite readings become null, never 0. Zero would render as a perfectly
    // healthy value on a gauge, which is a lie the operator cannot detect.
    value: typeof value === "number" && Number.isFinite(value) ? value : null,
  };
}

function percentage(part: number, total: number): number | null {
  if (total <= 0) return null;
  return (part / total) * 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function firstPositive(values: number[]): number | null {
  const first = values[0];
  // Windows reports [0, 0, 0] because load average does not apply there. Publishing that 0
  // would pin a bullet chart to zero on a perfectly healthy machine.
  if (typeof first !== "number" || !Number.isFinite(first) || first <= 0) return null;
  return first;
}

function countersFromStats(stats: NetworkStatsData[], at: number): Counters | null {
  if (stats.length === 0) return null;
  let rxBytes = 0;
  let txBytes = 0;
  for (const entry of stats) {
    if (entry.operstate === "unknown") continue;
    rxBytes += entry.rx_bytes ?? 0;
    txBytes += entry.tx_bytes ?? 0;
  }
  return { rxBytes, txBytes, at };
}

async function readFilesystems(): Promise<TableData> {
  const size = await si.fsSize().catch(() => []);

  const rows = size
    // Entries with no size are synthetic or unmounted and only add noise to the table.
    .filter((entry) => entry.size > 0)
    .map((entry) => ({
      mount: entry.mount,
      type: entry.type,
      sizeBytes: entry.size,
      usedBytes: entry.used,
      availableBytes: entry.available,
      usedPercent: entry.use,
    }));

  return {
    id: "storage.disks",
    columns: ["mount", "type", "sizeBytes", "usedBytes", "availableBytes", "usedPercent"],
    rows,
  };
}

function interfacesTable(stats: NetworkStatsData[]): TableData {
  const rows = stats
    .filter((entry) => entry.operstate !== "unknown")
    .map((entry) => ({
      interface: entry.iface,
      state: entry.operstate,
      rxBytes: entry.rx_bytes ?? 0,
      txBytes: entry.tx_bytes ?? 0,
      rxErrors: entry.rx_errors ?? 0,
      txErrors: entry.tx_errors ?? 0,
    }));

  return {
    id: "network.interfaces",
    columns: ["interface", "state", "rxBytes", "txBytes", "rxErrors", "txErrors"],
    rows,
  };
}

function aggregateDiskUsage(filesystems: TableData): number | null {
  let worst: number | null = null;
  for (const row of filesystems.rows) {
    const value = row.usedPercent;
    if (typeof value === "number" && Number.isFinite(value) && (worst === null || value > worst)) {
      worst = value;
    }
  }
  return worst;
}
