import type { Series, TableData } from "../../shared/observations.ts";
import type { WidgetConfig } from "../../shared/layout.ts";
import type { ReadingsIndex } from "../api.ts";
import { keyOf } from "../api.ts";
import {
  axisGutter,
  buildAreaPath,
  buildBarRects,
  buildLinePath,
  bulletBands,
  computeDomain,
  gaugeArc,
  plotBox,
  ratioInRange,
} from "./geometry.ts";
import type { Box, Domain } from "./geometry.ts";
import { formatCell, formatValue } from "./format.ts";

/**
 * SVG renderers.
 *
 * Each renderer builds an SVG element from the pure geometry in `geometry.ts`. Nothing here
 * decides a coordinate, which is what keeps the maths testable without a browser.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Fallback view-box width for a chart that has not been measured yet. */
const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 140;

function element<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * A measured width is used as the view-box width so one view-box unit is one CSS pixel.
 * That keeps text at its intended size; stretching a fixed 320-unit drawing is what made
 * axis labels wider on wide widgets.
 */
function normaliseWidth(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) return VIEW_WIDTH;
  return Math.round(requested);
}

function svgRoot(width: number): SVGSVGElement {
  return element("svg", {
    viewBox: `0 0 ${width} ${VIEW_HEIGHT}`,
    preserveAspectRatio: "xMidYMid meet",
    class: "chart",
    role: "presentation",
    focusable: "false",
  });
}

/** Plot area for charts that carry no value axis. */
function centredPlot(width: number): Box {
  return plotBox(width, VIEW_HEIGHT, 34);
}

/** Dash patterns, so series are distinguishable without relying on colour alone. */
const DASHES = ["", "6 3", "2 3", "8 3 2 3"];

function dashFor(index: number): string {
  return DASHES[index % DASHES.length] ?? "";
}

export type ResolvedWidget = {
  widget: WidgetConfig;
  /** Series resolved against the current snapshot; missing keys are simply absent. */
  series: Series[];
  /** Missing metric keys the widget references but the source does not publish. */
  missing: string[];
  /** Table data, for a `table` widget. */
  table: TableData | null;
};

export function resolveWidget(widget: WidgetConfig, index: ReadingsIndex): ResolvedWidget {
  const series: Series[] = [];
  const missing: string[] = [];
  let table: TableData | null = null;

  for (const metric of widget.metrics) {
    const found = index.series.get(keyOf(widget.sourceId, metric));
    if (found) {
      series.push(found);
      continue;
    }
    const foundTable = index.tables.get(metric);
    if (foundTable) {
      table = foundTable;
      continue;
    }
    missing.push(metric);
  }

  return { widget, series, missing, table };
}

/** Latest non-null value of a series, or null. */
function latest(series: Series | undefined): number | null {
  if (!series) return null;
  for (let index = series.samples.length - 1; index >= 0; index -= 1) {
    const value = series.samples[index]?.v;
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Every series is empty when none of them carries a value. */
function hasAnyData(series: Series[]): boolean {
  return series.some((entry) => entry.samples.some((sample) => sample.v !== null));
}

const AXIS_STEPS = 3;

type AxisTick = { value: number; label: string; ratio: number };

/**
 * The value axis's ticks, top to bottom.
 *
 * Computed before drawing so the plot can be sized around the labels. A unit suffix such as
 * "q/s" makes a tick far wider than a bare number, and a gutter chosen for the latter clips the
 * former.
 */
export function axisTicks(domain: Domain, unit: string, steps = AXIS_STEPS): AxisTick[] {
  const ticks: AxisTick[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    const value = domain.max - ratio * (domain.max - domain.min);
    ticks.push({ value, label: formatValue(value, unit), ratio });
  }
  return ticks;
}

/** The plot area for a chart whose axis labels are already known. */
function plotForTicks(ticks: readonly AxisTick[], width: number): Box {
  return plotBox(
    width,
    VIEW_HEIGHT,
    axisGutter(
      ticks.map((tick) => tick.label),
      width,
    ),
  );
}

function axis(ticks: readonly AxisTick[], plot: Box): SVGGElement {
  const group = element("g", { class: "chart__axis" });

  for (const tick of ticks) {
    const y = plot.y + tick.ratio * plot.height;

    group.append(
      element("line", {
        x1: plot.x,
        y1: y,
        x2: plot.x + plot.width,
        y2: y,
        class: "chart__grid",
      }),
    );

    const label = element("text", {
      x: plot.x - 6,
      y: y + 3,
      class: "chart__tick",
      "text-anchor": "end",
    });
    label.textContent = tick.label;
    group.append(label);
  }

  return group;
}

function renderLine(resolved: ResolvedWidget, width: number): SVGSVGElement {
  const svg = svgRoot(width);
  const { widget, series } = resolved;
  const unit = widget.unit ?? series[0]?.unit ?? "";

  const domain = computeDomain(
    series.flatMap((entry) => entry.samples),
    { min: widget.min, max: widget.max },
  );
  const ticks = axisTicks(domain, unit);
  const plot = plotForTicks(ticks, width);
  svg.append(axis(ticks, plot));

  series.forEach((entry, index) => {
    const path = buildLinePath(entry.samples, plot, domain);
    if (path.length > 0) {
      svg.append(
        element("path", {
          d: path,
          class: "chart__line",
          "stroke-dasharray": dashFor(index),
          "data-series": entry.label,
          "data-series-index": index + 1,
        }),
      );
    }

    const area = buildAreaPath(entry.samples, plot, domain);
    if (area.length > 0) {
      svg.append(
        element("path", {
          d: area,
          class: "chart__area",
          "stroke-dasharray": dashFor(index),
          "data-series": entry.label,
          "data-series-index": index + 1,
        }),
      );
    }
  });

  return svg;
}

function renderBar(resolved: ResolvedWidget, width: number): SVGSVGElement {
  const svg = svgRoot(width);
  const { widget, series } = resolved;
  const unit = widget.unit ?? series[0]?.unit ?? "";

  const domain = computeDomain(
    series.flatMap((entry) => entry.samples),
    { min: widget.min, max: widget.max },
  );
  const ticks = axisTicks(domain, unit);
  const plot = plotForTicks(ticks, width);
  svg.append(axis(ticks, plot));

  const rects = buildBarRects(
    series.map((entry) => entry.samples),
    plot,
    domain,
  );

  const group = element("g", { class: "chart__bars" });
  rects.forEach((rect) => {
    // Grouped bars keep the source series index even when a null sample is skipped.
    group.append(
      element("rect", {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        class: "chart__bar",
        "data-series": series[rect.seriesIndex]?.label ?? "",
        "data-series-index": rect.seriesIndex + 1,
      }),
    );
  });
  svg.append(group);

  return svg;
}

function renderGauge(resolved: ResolvedWidget, width: number): SVGSVGElement {
  const svg = svgRoot(width);
  const { widget, series } = resolved;
  const value = latest(series[0]);
  const unit = widget.unit ?? series[0]?.unit ?? "%";

  const min = widget.min ?? 0;
  const max = widget.max ?? 100;
  const domain: Domain = { min, max };

  const plot = centredPlot(width);
  const cx = width / 2;
  const cy = VIEW_HEIGHT * 0.62;
  const radius = Math.min(plot.width, plot.height * 1.5) / 2;

  const track = gaugeArc(cx, cy, radius, 1);
  svg.append(element("path", { d: track.d, class: "chart__track" }));

  const ratio = ratioInRange(value, domain);
  if (ratio !== null) {
    const filled = gaugeArc(cx, cy, radius, ratio);
    svg.append(element("path", { d: filled.d, class: "chart__gauge" }));
  }

  // The numeric value is drawn inside the gauge as well as in the widget header, so a
  // glanceable dial is never the only place the number exists.
  const text = element("text", {
    x: cx,
    y: cy + 4,
    class: "chart__gauge-value",
    "text-anchor": "middle",
  });
  text.textContent = formatValue(value, unit);
  svg.append(text);

  const scale = element("text", {
    x: cx,
    y: VIEW_HEIGHT - 4,
    class: "chart__tick",
    "text-anchor": "middle",
  });
  scale.textContent = `${formatValue(min, unit)} – ${formatValue(max, unit)}`;
  svg.append(scale);

  return svg;
}

function renderBullet(resolved: ResolvedWidget, width: number): SVGSVGElement {
  const svg = svgRoot(width);
  const { widget, series } = resolved;
  const value = latest(series[0]);
  const unit = widget.unit ?? series[0]?.unit ?? "";

  const domain: Domain = {
    min: widget.min ?? 0,
    max: widget.max ?? Math.max(1, (value ?? 1) * 1.5),
  };

  const plot = centredPlot(width);
  const box: Box = { x: plot.x, y: 52, width: plot.width, height: 34 };

  // Qualitative bands first, so the value marker reads on top of them.
  for (const band of bulletBands(domain)) {
    const from = ratioInRange(band.from, domain) ?? 0;
    const to = ratioInRange(band.to, domain) ?? 0;
    svg.append(
      element("rect", {
        x: box.x + from * box.width,
        y: box.y,
        width: Math.max(0, (to - from) * box.width),
        height: box.height,
        class: `chart__band chart__band--${band.tone}`,
      }),
    );
  }

  const ratio = ratioInRange(value, domain);
  if (ratio !== null) {
    const x = box.x + ratio * box.width;
    svg.append(
      element("line", {
        x1: x,
        y1: box.y - 8,
        x2: x,
        y2: box.y + box.height + 8,
        class: "chart__marker",
      }),
    );
  }

  const start = element("text", { x: box.x, y: box.y - 12, class: "chart__tick" });
  start.textContent = formatValue(domain.min, unit);
  const end = element("text", {
    x: box.x + box.width,
    y: box.y - 12,
    class: "chart__tick",
    "text-anchor": "end",
  });
  end.textContent = formatValue(domain.max, unit);
  svg.append(start, end);

  return svg;
}

function renderTable(resolved: ResolvedWidget): HTMLElement {
  const table = resolved.table;
  const wrapper = document.createElement("div");
  wrapper.className = "table-widget";

  if (!table) {
    const empty = document.createElement("p");
    empty.className = "widget__message";
    empty.textContent = "No table data available yet.";
    wrapper.append(empty);
    return wrapper;
  }

  const element$ = document.createElement("table");
  element$.className = "data-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of table.columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = humaniseColumn(column);
    headRow.append(th);
  }
  head.append(headRow);

  const body = document.createElement("tbody");
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    for (const column of table.columns) {
      const td = document.createElement("td");
      td.textContent = formatCell(column, row[column] ?? null);
      tr.append(td);
    }
    body.append(tr);
  }

  element$.append(head, body);
  wrapper.append(element$);
  return wrapper;
}

/** `usedBytes` -> `Used bytes`, so column headers are not raw identifiers. */
export function humaniseColumn(column: string): string {
  const spaced = column.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function renderChart(
  resolved: ResolvedWidget,
  options: { width?: number } = {},
): SVGElement | HTMLElement {
  // An all-null series must render as an explicit absence, not as a flat line at zero: a
  // zero would read as a healthy measurement that was never taken.
  if (resolved.widget.type !== "table" && !hasAnyData(resolved.series)) {
    const message = document.createElement("p");
    message.className = "widget__message";
    message.textContent = "No data available for this metric yet.";
    return message;
  }

  const width = normaliseWidth(options.width);

  switch (resolved.widget.type) {
    case "line":
      return renderLine(resolved, width);
    case "bar":
      return renderBar(resolved, width);
    case "gauge":
      return renderGauge(resolved, width);
    case "bullet":
      return renderBullet(resolved, width);
    case "table":
      return renderTable(resolved);
    default:
      return renderLine(resolved, width);
  }
}

/**
 * A text summary of a widget, for assistive technology.
 *
 * A dashboard whose only output is a picture of a line is not accessible, so every widget
 * states its metric, its latest value and how much history it covers.
 */
export function buildSummary(resolved: ResolvedWidget): string {
  const { widget, series, missing } = resolved;

  if (missing.length > 0) {
    return `Metric not available: ${missing.join(", ")}`;
  }

  if (widget.type === "table") {
    if (!resolved.table) return "No table data available.";
    return `${resolved.table.rows.length} rows of ${resolved.table.columns.length} columns`;
  }

  if (series.length === 0) return "No series selected.";

  const parts = series.map((entry) => {
    const value = latest(entry);
    const unit = entry.unit || widget.unit || "";
    return `${entry.label}: ${formatValue(value, unit)}`;
  });

  const points = series[0]?.samples.length ?? 0;
  return `${parts.join("; ")}. ${points} samples retained.`;
}
