import type { SourceInfo } from "../shared/observations.ts";

/**
 * How a source should be presented.
 *
 * A source that has never produced a sample is **not** the same thing as a source that is
 * failing, and the API cannot say so through `status` alone: a freshly registered source is
 * `unavailable` with no error until its first cycle completes. Conflating the two means an
 * operator sees a red "Unavailable" while the collector is merely still starting, which is
 * exactly the kind of false alarm that destroys trust in a health display.
 *
 * `lastSampleAt` is the unambiguous signal: `null` means no sample has ever arrived, whatever
 * `status` says. Doing this on the client needs no contract change.
 */

export type SourceView = {
  /** Text for the pill. Never a bare failure when the truth is "not yet". */
  label: string;
  /** Visual severity, applied as a class rather than as colour alone. */
  tone: "ok" | "starting" | "warn";
  /** Present only when there is a real reason to show. */
  detail?: string;
};

export type OverallView = {
  label: string;
  tone: "ok" | "starting" | "warn";
};

export function describeSource(source: SourceInfo): SourceView {
  if (source.status === "disabled") {
    return { label: `${source.label} (off)`, tone: "ok" };
  }

  // Never sampled and nothing has gone wrong: the collector has not finished its first cycle.
  if (source.lastSampleAt === null && source.error === undefined) {
    return { label: `${source.label} (starting)`, tone: "starting" };
  }

  if (source.error !== undefined) {
    return { label: `${source.label} (unavailable)`, tone: "warn", detail: source.error };
  }

  if (source.status === "degraded") {
    return { label: `${source.label} (degraded)`, tone: "warn" };
  }

  return { label: source.label, tone: "ok" };
}

export function describeOverall(sources: SourceInfo[]): OverallView {
  const views = sources.map(describeSource);

  if (views.some((view) => view.tone === "warn")) {
    return { label: "Degraded", tone: "warn" };
  }
  if (views.some((view) => view.tone === "starting")) {
    return { label: "Starting", tone: "starting" };
  }
  return { label: "Healthy", tone: "ok" };
}

/**
 * True when nothing has failed.
 *
 * Used to decide whether the dashboard is trustworthy right now, so a source that has not
 * started yet does not silently make every value look broken.
 */
export function hasFailures(sources: SourceInfo[]): boolean {
  return sources.some((view) => describeSource(view).tone === "warn");
}
