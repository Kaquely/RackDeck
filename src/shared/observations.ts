/**
 * The observation model.
 *
 * Everything the product displays passes through these types, regardless of whether it came
 * from the local machine, the Docker daemon or a third-party application. A widget never
 * needs to know which source produced a number.
 */

/**
 * Health of a data source.
 *
 * `degraded` means the source answered but something is wrong with part of it;
 * `unavailable` means it could not be reached. They are distinct so the UI can tell the user
 * whether to check the network or to check the application.
 */
export const SOURCE_STATUSES = ["ok", "degraded", "unavailable", "disabled"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** One observation of one metric at one instant. `null` means "not measurable right now". */
export type Sample = {
  /** Epoch milliseconds. */
  t: number;
  v: number | null;
};

/**
 * A bounded time series for a single metric.
 *
 * `samples` is oldest-first and bounded by the configured history length, so memory cannot
 * grow with uptime.
 */
export type Series = {
  sourceId: string;
  /** Dotted metric key, for example `cpu.usage`. Unique within a source. */
  metric: string;
  label: string;
  /** Display unit, for example `%`, `B/s`. Empty when the metric is unitless. */
  unit: string;
  status: SourceStatus;
  samples: Sample[];
  /** Present when `status` is not `ok`; safe to show to the user. */
  error?: string;
};

export type SourceInfo = {
  id: string;
  label: string;
  /** What kind of source this is, for example `host` or `docker`. */
  kind: string;
  status: SourceStatus;
  /** Epoch milliseconds of the last successful sample, or null if never. */
  lastSampleAt: number | null;
  error?: string;
};

/**
 * Categorical data for the table widget.
 *
 * Numeric series cannot express a disk or a network interface, which is why the table chart
 * form needs its own shape. Tables hold only the latest collection: a table is a snapshot of
 * a structure, not a trend, so retaining history for it would waste memory without ever being
 * drawn.
 */
export type TableData = {
  /** Stable identifier, referenced by a widget as a metric key. */
  id: string;
  columns: string[];
  rows: Record<string, string | number>[];
};

export type ReadingsSnapshot = {
  /** Epoch milliseconds at which this snapshot was assembled. */
  generatedAt: number;
  /** Configured sampling interval, so the client can detect drift. */
  intervalMs: number;
  sources: SourceInfo[];
  series: Series[];
  tables: TableData[];
};

/** An empty snapshot, used before any collector has produced a sample. */
export function emptySnapshot(intervalMs: number): ReadingsSnapshot {
  return { generatedAt: Date.now(), intervalMs, sources: [], series: [], tables: [] };
}
