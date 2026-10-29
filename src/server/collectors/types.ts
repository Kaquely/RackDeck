import type { SourceStatus, TableData } from "../../shared/observations.ts";

/**
 * The collector contract.
 *
 * A collector is the only code permitted to touch the outside world. It returns normalized
 * samples, never a vendor payload, so a widget never needs to know where a number came from.
 * That is what lets the third-party integrations added later be purely additive.
 */

/** One numeric observation. `value: null` means "not measurable right now". */
export type MetricSample = {
  /** Dotted key unique within the source, for example `cpu.usage`. */
  metric: string;
  label: string;
  /** Display unit, for example `%`, `B/s`, `s`. Empty when unitless. */
  unit: string;
  value: number | null;
};

export type CollectorResult = {
  status: SourceStatus;
  metrics: MetricSample[];
  tables: TableData[];
};

export type Collector = {
  id: string;
  label: string;
  /** What kind of source this is, for example `host` or `docker`. */
  kind: string;
  collect: () => Promise<CollectorResult>;
};

/** A collector result for a source that produced nothing, used before the first cycle. */
export function emptyCollectorResult(): CollectorResult {
  return { status: "unavailable", metrics: [], tables: [] };
}
