import type {
  ReadingsSnapshot,
  SourceInfo,
  SourceStatus,
  TableData,
} from "../../shared/observations.ts";
import type { MetricSample } from "../collectors/types.ts";
import { SampleRing } from "./sample-ring.ts";

/**
 * The in-memory observation store.
 *
 * The scheduler writes into it on a timer; HTTP handlers read from it. Because the
 * scheduler is the only writer and Node is single-threaded there is no data race, but a read
 * that interleaved with a write could still observe a half-updated series. The snapshot is
 * therefore built in full and swapped in with a single assignment, so a reader always sees a
 * complete, self-consistent view.
 */

type SourceEntry = {
  info: SourceInfo;
  /** Metric key to its ring. */
  rings: Map<string, SampleRing>;
  /** Static metadata per metric, so the renderer has labels and units without a lookup table. */
  descriptors: Map<string, { label: string; unit: string }>;
  /** Latest table data only. A table is a structure, not a trend. */
  tables: Map<string, TableData>;
};

export class SnapshotStore {
  readonly historyLength: number;
  readonly intervalMs: number;

  #sources = new Map<string, SourceEntry>();
  #cached: ReadingsSnapshot;

  constructor(options: { historyLength: number; intervalMs: number }) {
    this.historyLength = options.historyLength;
    this.intervalMs = options.intervalMs;
    this.#cached = this.#build(Date.now());
  }

  /** Register a source so it appears in health and readings before its first collection. */
  register(source: { id: string; label: string; kind: string }): void {
    if (this.#sources.has(source.id)) return;
    this.#sources.set(source.id, {
      info: {
        id: source.id,
        label: source.label,
        kind: source.kind,
        status: "unavailable",
        lastSampleAt: null,
      },
      rings: new Map(),
      descriptors: new Map(),
      tables: new Map(),
    });
    this.#cached = this.#build(Date.now());
  }

  /** Record a successful collection for one source. */
  record(sourceId: string, metrics: MetricSample[], tables: TableData[], at: number): void {
    const entry = this.#entryFor(sourceId);
    if (!entry) return;

    for (const metric of metrics) {
      let ring = entry.rings.get(metric.metric);
      if (ring === undefined) {
        ring = new SampleRing(this.historyLength);
        entry.rings.set(metric.metric, ring);
      }
      entry.descriptors.set(metric.metric, { label: metric.label, unit: metric.unit });
      ring.push({ t: at, v: metric.value });
    }

    // Replace rather than append: a table is the current structure, not a history.
    for (const table of tables) {
      entry.tables.set(table.id, table);
    }

    entry.info.status = "ok";
    entry.info.lastSampleAt = at;
    delete entry.info.error;

    // The cache is only ever replaced wholesale, so a concurrent reader sees either the
    // previous complete snapshot or this one, never a half-written series.
    this.#cached = this.#build(at);
  }

  /** Mark a source as failed without touching any other source or any retained history. */
  markUnavailable(sourceId: string, error: string, at: number): void {
    const entry = this.#sources.get(sourceId);
    if (!entry) return;

    entry.info.status = "unavailable";
    entry.info.error = error;
    if (entry.info.lastSampleAt === null) {
      // Only stamp the time when nothing was ever collected, so `lastSampleAt` keeps
      // meaning "last time this source produced data" rather than "last time we failed".
      entry.info.lastSampleAt = at;
    }
    this.#cached = this.#build(at);
  }

  markStatus(sourceId: string, status: SourceStatus, error?: string): void {
    const entry = this.#sources.get(sourceId);
    if (!entry) return;

    entry.info.status = status;
    if (error === undefined) {
      delete entry.info.error;
    } else {
      entry.info.error = error;
    }
    this.#cached = this.#build(Date.now());
  }

  /** Remove a source after its collector is unregistered. Returns false when it was absent. */
  unregister(sourceId: string): boolean {
    const removed = this.#sources.delete(sourceId);
    if (removed) {
      this.#cached = this.#build(Date.now());
    }
    return removed;
  }

  listSources(): SourceInfo[] {
    return [...this.#sources.values()].map((entry) => ({ ...entry.info }));
  }

  /** The current snapshot. A single field read, so a caller never sees a partial update. */
  snapshot(): ReadingsSnapshot {
    return this.#cached;
  }

  /** Total retained samples, exposed so a test can assert memory does not grow with uptime. */
  retainedSampleCount(): number {
    let total = 0;
    for (const entry of this.#sources.values()) {
      for (const ring of entry.rings.values()) total += ring.size;
    }
    return total;
  }

  #entryFor(sourceId: string): SourceEntry | undefined {
    return this.#sources.get(sourceId);
  }

  #build(generatedAt: number): ReadingsSnapshot {
    const sources: SourceInfo[] = [];
    const series: ReadingsSnapshot["series"] = [];
    const tables: TableData[] = [];

    for (const entry of this.#sources.values()) {
      sources.push({ ...entry.info });

      for (const [metric, ring] of entry.rings) {
        const descriptor = entry.descriptors.get(metric);
        series.push({
          sourceId: entry.info.id,
          metric,
          label: descriptor?.label ?? metric,
          unit: descriptor?.unit ?? "",
          status: entry.info.status,
          samples: ring.toArray(),
          ...(entry.info.error === undefined ? {} : { error: entry.info.error }),
        });
      }

      for (const table of entry.tables.values()) {
        tables.push(table);
      }
    }

    return { generatedAt, intervalMs: this.intervalMs, sources, series, tables };
  }
}
