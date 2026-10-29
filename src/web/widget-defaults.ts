import type { ReadingsIndex } from "./api.ts";
import type { WidgetConfig } from "../shared/layout.ts";

/**
 * Widget suggestions.
 *
 * Kept out of `app.ts` so the "what can I add?" question is answerable from the snapshot
 * alone, and so a default widget is something with a name and sensible bounds rather than a
 * bare metric key.
 */

export type MetricOption = {
  key: string;
  sourceId: string;
  metric: string;
  label: string;
  unit: string;
  /** A numeric series or a categorical table. The widget controls treat them differently. */
  kind: "series" | "table";
  /** Sensible bounds for a gauge, when the metric has an obvious range. */
  min?: number;
  max?: number;
};

const PERCENT_METRICS = new Set(["cpu.usage", "memory.usage", "storage.usedPercent"]);

/**
 * Every metric the current snapshot publishes, as a selectable option.
 *
 * Table ids are included too, so a `table` widget can be added without special handling by
 * the caller.
 */
export function availableMetrics(readings: ReadingsIndex | null): MetricOption[] {
  if (!readings) return [];

  const options: MetricOption[] = [];

  for (const [key, series] of readings.series) {
    const separator = key.indexOf(".");
    const sourceId = separator > 0 ? key.slice(0, separator) : series.sourceId;
    const option: MetricOption = {
      key,
      sourceId,
      metric: series.metric,
      label: series.label,
      unit: series.unit,
      kind: "series",
    };
    // A percentage is the only case where 0-100 is genuinely the right gauge range. Guessing
    // bounds for bytes or seconds would draw a misleading dial.
    if (PERCENT_METRICS.has(series.metric)) {
      option.min = 0;
      option.max = 100;
    }
    options.push(option);
  }

  for (const [id, table] of readings.tables) {
    options.push({
      key: id,
      sourceId: "host",
      metric: id,
      label: table.id,
      unit: "",
      kind: "table",
    });
  }

  return options;
}

/** A sensible starting widget for a metric, with a name a person would recognise. */
export function buildDefaultWidget(
  option: MetricOption,
  type: WidgetConfig["type"] = option.kind === "table" ? "table" : "line",
): Omit<WidgetConfig, "id"> {
  const widget: Omit<WidgetConfig, "id"> = {
    type,
    title: option.label,
    sourceId: option.sourceId,
    metrics: [option.metric],
    span: 2,
  };

  if (option.unit.length > 0) widget.unit = option.unit;
  if (option.min !== undefined) widget.min = option.min;
  if (option.max !== undefined) widget.max = option.max;

  return widget;
}
