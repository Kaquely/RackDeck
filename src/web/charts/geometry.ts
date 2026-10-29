/**
 * Pure chart geometry.
 *
 * Every function here is side-effect free and returns plain data, so the awkward parts of
 * rendering — a flat series, a single sample, a gap, a value outside the axis — can be tested
 * exhaustively without a browser. Only these functions decide coordinates; the renderers in
 * `render.ts` just put the results into the DOM.
 */

/**
 * Monospace advance width of the axis tick font, in view-box units.
 *
 * The ticks use the 9px monospace face from `styles.css`, whose advance is a little over half the
 * font size. Counting characters rather than measuring the DOM keeps this pure and testable, and
 * an estimate that errs wide costs a few pixels of plot width.
 */
const TICK_CHAR_WIDTH = 5.6;

/** Gap between a tick label and the plot edge, plus a small margin. */
const TICK_GAP = 8;

/**
 * Left gutter wide enough for the widest axis label.
 *
 * A fixed gutter sized for a bare number clips a label like "59.8 q/s", and a chart with a
 * cut-off axis is worse than one with a marginally narrower plot. The labels are known before
 * anything is drawn, so the gutter is derived rather than guessed.
 */
export function axisGutter(labels: readonly string[], viewWidth: number): number {
  const widest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  const needed = Math.ceil(widest * TICK_CHAR_WIDTH) + TICK_GAP;
  // Capped so a pathologically long label cannot squeeze the plot out of existence. Beyond the
  // cap a label would clip, which is the lesser evil against a chart with no plot at all.
  return Math.min(Math.ceil(needed), Math.round(viewWidth * 0.4));
}

/** The plot area, inset on the left by the axis gutter and on the other sides by a fixed margin. */
export function plotBox(viewWidth: number, viewHeight: number, gutter: number): Box {
  return { x: gutter, y: 10, width: viewWidth - gutter - 10, height: viewHeight - 26 };
}

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Domain = { min: number; max: number };
export type Datum = { t: number; v: number | null };

/** A value that is safe to use as a coordinate. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Widen a domain so it is never zero-width.
 *
 * A series whose values are all equal would otherwise divide by zero, producing `NaN`
 * coordinates and a chart that renders as nothing or as a full-height spike. The fallback
 * span is derived from the magnitude of the data so that a bytes chart and a percentage chart
 * each get a sensible amount of headroom.
 */
export function ensureSpan(domain: Domain): Domain {
  const { min, max } = domain;
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) return { min, max };

  const magnitude = Math.max(Math.abs(finite(min)), Math.abs(finite(max)), 1);
  // A hundredth of the magnitude is enough headroom to show a flat line as flat rather than
  // as an arbitrary spike, while staying visually negligible for real variation.
  const pad = magnitude * 0.01;
  const centre = Number.isFinite(min) ? min : 0;
  return { min: centre - pad, max: centre + pad };
}

/**
 * Numeric domain covering every non-null sample, optionally clipped to explicit bounds.
 *
 * When `bounds` are supplied they win, so a gauge pinned to 0-100 always reads as a
 * proportion of its declared range rather than as a proportion of whatever happened to be
 * sampled.
 */
export function computeDomain(data: Datum[], bounds?: { min?: number; max?: number }): Domain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const datum of data) {
    if (datum.v === null || !Number.isFinite(datum.v)) continue;
    if (datum.v < min) min = datum.v;
    if (datum.v > max) max = datum.v;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    // No usable data at all. Fall back to the declared bounds, or to 0..1.
    return ensureSpan({ min: bounds?.min ?? 0, max: bounds?.max ?? 1 });
  }

  if (bounds?.min !== undefined) min = Math.min(min, bounds.min);
  if (bounds?.max !== undefined) max = Math.max(max, bounds.max);

  return ensureSpan({ min, max });
}

/** Map a value onto the x axis by index. Index-based, not time-based, so gaps stay even. */
function xForIndex(index: number, count: number, box: Box): number {
  if (count <= 1) return box.x + box.width / 2;
  return box.x + (index / (count - 1)) * box.width;
}

/** Map a value onto the y axis, inverted because SVG y grows downwards. */
function yForValue(value: number, domain: Domain, box: Box): number {
  const span = domain.max - domain.min;
  if (span <= 0) return box.y + box.height / 2;
  const ratio = (value - domain.min) / span;
  return box.y + box.height - ratio * box.height;
}

/**
 * Build an SVG path for a line chart.
 *
 * Null samples break the path into separate segments rather than being interpolated across: a
 * straight line through a gap would assert a measurement that was never taken. A single
 * non-null sample produces a degenerate but valid path so the value is still visible.
 */
export function buildLinePath(data: Datum[], box: Box, domain: Domain): string {
  const commands: string[] = [];
  let started = false;

  data.forEach((datum, index) => {
    if (datum.v === null || !Number.isFinite(datum.v)) {
      // Lift the pen: the next non-null sample starts a new subpath.
      started = false;
      return;
    }

    const x = finite(xForIndex(index, data.length, box));
    const y = finite(yForValue(datum.v, domain, box));
    commands.push(`${started ? "L" : "M"}${round(x)} ${round(y)}`);
    started = true;
  });

  return commands.join(" ");
}

/** Build a closed path for the area under a line, used as a subtle fill. */
export function buildAreaPath(data: Datum[], box: Box, domain: Domain): string {
  const segments = splitSegments(data);
  if (segments.length === 0) return "";

  const baseline = finite(box.y + box.height);
  const paths: string[] = [];

  for (const segment of segments) {
    if (segment.length < 2) continue;
    const first = segment[0];
    const last = segment[segment.length - 1];
    if (!first || !last) continue;

    const points = segment.map((datum, offset) => {
      const index = data.indexOf(datum);
      return `${round(finite(xForIndex(index < 0 ? offset : index, data.length, box)))} ${round(
        finite(yForValue(datum.v as number, domain, box)),
      )}`;
    });

    paths.push(
      `M${points[0]} L${points.slice(1).join(" L")} L${round(
        finite(xForIndex(data.indexOf(last), data.length, box)),
      )} ${round(baseline)} L${round(finite(xForIndex(data.indexOf(first), data.length, box)))} ${round(baseline)} Z`,
    );
  }

  return paths.join(" ");
}

/** Split a series into runs of consecutive non-null samples. */
export function splitSegments(data: Datum[]): Datum[][] {
  const segments: Datum[][] = [];
  let current: Datum[] = [];

  for (const datum of data) {
    if (datum.v === null || !Number.isFinite(datum.v)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(datum);
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

export type BarRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  index: number;
  seriesIndex: number;
};

/**
 * One bar per recent sample, grouped by series.
 *
 * Bars are drawn from the domain floor rather than from zero, so variation within a narrow
 * band stays visible. Drawing from an arbitrary floor is stated by the caller supplying the
 * domain, and the floor is drawn as an axis so the reader is not misled.
 */
export function buildBarRects(
  series: Datum[][],
  box: Box,
  domain: Domain,
  options: { maxBars?: number; gapRatio?: number } = {},
): BarRect[] {
  const maxBars = options.maxBars ?? 60;
  const gapRatio = options.gapRatio ?? 0.2;

  // Align all series on the most recent window so grouped bars share an x position.
  const length = Math.max(0, ...series.map((entry) => entry.length));
  const window = Math.min(length, maxBars);
  if (window === 0) return [];

  const groupWidth = box.width / window;
  const innerWidth = groupWidth * (1 - gapRatio);
  const perSeries = series.length || 1;
  const barWidth = Math.max(1, innerWidth / perSeries);
  const floor = finite(yForValue(domain.min, domain, box));

  const rects: BarRect[] = [];
  // Index into the tail of each series so the most recent samples are the ones shown.
  const offsetFor = (entry: Datum[]) => Math.max(0, entry.length - window);

  for (let slot = 0; slot < window; slot += 1) {
    series.forEach((entry, seriesIndex) => {
      const datum = entry[offsetFor(entry) + slot];
      if (!datum || datum.v === null || !Number.isFinite(datum.v)) return;

      const top = finite(yForValue(datum.v, domain, box));
      const x =
        box.x +
        slot * groupWidth +
        (innerWidth - barWidth * perSeries) / 2 +
        seriesIndex * barWidth;

      rects.push({
        x: round(x),
        // A value below the floor would give a negative height; clamp to a hairline.
        y: round(Math.min(top, floor)),
        width: round(barWidth),
        height: round(Math.max(0, floor - Math.min(top, floor))),
        value: datum.v,
        index: slot,
        seriesIndex,
      });
    });
  }

  return rects;
}

export type Arc = { d: string; ratio: number };

/**
 * An arc for a gauge, as a fraction of a 270-degree sweep.
 *
 * The value is clamped into the declared range for the arc, because an arc that overflows its
 * own track is unreadable; the true value is still shown numerically by the caller.
 */
export function gaugeArc(
  cx: number,
  cy: number,
  radius: number,
  ratio: number,
  options: { sweepDegrees?: number; startDegrees?: number } = {},
): Arc {
  const sweep = options.sweepDegrees ?? 270;
  const startAngle = options.startDegrees ?? 135;
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));

  // A zero-length arc cannot be expressed with a single elliptical command, so the track is
  // returned as a full sweep. Drawing a dot would be invisible at small radii.
  if (clamped <= 0) {
    return { d: arcPath(cx, cy, radius, startAngle, startAngle + sweep), ratio: 0 };
  }
  return { d: arcPath(cx, cy, radius, startAngle, startAngle + sweep * clamped), ratio: clamped };
}

function arcPath(cx: number, cy: number, radius: number, from: number, to: number): string {
  const start = polar(cx, cy, radius, from);
  const end = polar(cx, cy, radius, to);
  const largeArc = Math.abs(to - from) > 180 ? 1 : 0;
  // A full circle cannot be drawn as one arc; the track stops just short of 360 degrees.
  const sweepFlag = to - from >= 360 ? 0 : 1;
  return `M${round(start.x)} ${round(start.y)} A${round(radius)} ${round(radius)} 0 ${largeArc} ${sweepFlag} ${round(end.x)} ${round(end.y)}`;
}

function polar(cx: number, cy: number, radius: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

export type Band = { from: number; to: number; tone: "poor" | "ok" | "good" };

/**
 * Qualitative bands for a bullet chart, expressed as fractions of the range.
 *
 * Classic bullet-graph ranges. Fractions are clamped and normalised so a caller can pass raw
 * values or already-computed fractions, and a degenerate range still produces usable bands
 * rather than three zero-width rectangles.
 */
export function bulletBands(range: Domain, stops: number[] = [0.5, 0.8]): Band[] {
  const span = range.max - range.min;
  const usable = Number.isFinite(span) && span > 0 ? span : 1;
  const base = Number.isFinite(range.min) ? range.min : 0;

  const points = [0, ...stops, 1]
    .map((value) => Math.min(1, Math.max(0, value)))
    .sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || value !== all[index - 1]);

  const tones: Band["tone"][] = ["poor", "ok", "good", "good"];
  const bands: Band[] = [];

  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index] as number;
    const to = points[index + 1] as number;
    if (to <= from) continue;
    bands.push({ from, to, tone: tones[Math.min(index, tones.length - 1)] as Band["tone"] });
  }

  // Report absolute values as well, so a caller can label the axis without recomputing.
  return bands.map((band) => ({
    ...band,
    from: base + band.from * usable,
    to: base + band.to * usable,
  }));
}

/** Position of a value along a range, as a 0..1 fraction, clamped. */
export function ratioInRange(value: number | null, range: Domain): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const span = range.max - range.min;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.min(1, Math.max(0, (value - range.min) / span));
}

/** Keep coordinates short; sub-pixel precision is noise in a path string. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
