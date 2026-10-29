/**
 * Value formatting.
 *
 * Pure and shared by every renderer, so the awkward cases are handled once: null, zero,
 * negative, non-finite, and very large magnitudes. A null always renders as an em dash and
 * never as `0`, because a zero would read as a healthy measurement.
 */

const DASH = "—";

/** Compact binary byte sizes, for example `14.3 GiB`. */
export function formatBytes(value: number | null, fractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return DASH;

  const negative = value < 0;
  let magnitude = Math.abs(value);

  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unitIndex = 0;
  while (magnitude >= 1024 && unitIndex < units.length - 1) {
    magnitude /= 1024;
    unitIndex += 1;
  }

  // Whole bytes need no decimal places; 0.0 B reads as false precision.
  const digits = unitIndex === 0 ? 0 : fractionDigits;
  return `${negative ? "-" : ""}${magnitude.toFixed(digits)} ${units[unitIndex]}`;
}

/** A transfer rate, for example `1.2 MiB/s`. */
export function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return DASH;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** A percentage, for example `42.1%`. */
export function formatPercent(value: number | null, fractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(fractionDigits)}%`;
}

/** A duration in seconds as `2d 4h`, `3h 12m`, `45s`. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return DASH;

  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const remainder = whole % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

/** A plain count, with thousands separators so long numbers stay readable. */
export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  return Math.round(value).toLocaleString();
}

/**
 * Format a value according to its declared unit.
 *
 * The unit travels with the metric from the server, so this is the single place that decides
 * how each kind of quantity reads.
 */
export function formatValue(value: number | null, unit: string): string {
  switch (unit) {
    case "bytes":
      return formatBytes(value);
    case "B/s":
      return formatRate(value);
    case "%":
      return formatPercent(value);
    case "s":
      return formatDuration(value);
    case "":
      // Unitless metrics are counts or ratios such as load average. Two decimals keeps a load
      // average readable without inventing precision for a process count.
      return value === null || !Number.isFinite(value)
        ? DASH
        : Math.abs(value) >= 100
          ? formatCount(value)
          : value.toFixed(2);
    default:
      return value === null || !Number.isFinite(value) ? DASH : `${value.toFixed(2)} ${unit}`;
  }
}

/** Format a table cell, choosing by column name so bytes are not shown as raw integers. */
export function formatCell(column: string, value: string | number | null): string {
  if (value === null) return DASH;

  if (typeof value === "string") return value;

  if (column.endsWith("Bytes") || column === "sizeBytes") return formatBytes(value);
  if (column === "usedPercent") return formatPercent(value);
  if (column.endsWith("Errors") || column.endsWith("Dropped")) return formatCount(value);

  return formatCount(value);
}

/** Short label for the age of a reading, for the freshness indicator. */
export function formatAge(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return DASH;
  if (milliseconds < 1_000) return "just now";
  return `${formatDuration(milliseconds / 1_000)} ago`;
}
