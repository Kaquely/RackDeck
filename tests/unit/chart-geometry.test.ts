import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  axisGutter,
  buildAreaPath,
  buildBarRects,
  buildLinePath,
  bulletBands,
  computeDomain,
  ensureSpan,
  gaugeArc,
  plotBox,
  ratioInRange,
  splitSegments,
} from "../../src/web/charts/geometry.ts";
import type { Box, Datum } from "../../src/web/charts/geometry.ts";

const BOX: Box = { x: 0, y: 0, width: 100, height: 50 };

function series(...values: (number | null)[]): Datum[] {
  return values.map((v, index) => ({ t: index, v }));
}

/** Parse the numbers out of a path so assertions do not depend on exact formatting. */
function coordinates(path: string): number[] {
  return (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe("ensureSpan", () => {
  it("leaves a healthy domain untouched", () => {
    assert.deepEqual(ensureSpan({ min: 0, max: 100 }), { min: 0, max: 100 });
  });

  it("widens a zero-width domain", () => {
    const widened = ensureSpan({ min: 5, max: 5 });

    assert.ok(widened.max > widened.min, "a flat series must still have a span");
    assert.ok(Math.abs((widened.min + widened.max) / 2 - 5) < 1e-9, "the centre must not move");
  });

  it("scales the fallback to the magnitude of the data", () => {
    const bytes = ensureSpan({ min: 1_000_000, max: 1_000_000 });
    const percent = ensureSpan({ min: 1, max: 1 });

    assert.ok(bytes.max - bytes.min > percent.max - percent.min);
  });

  it("survives non-finite bounds", () => {
    const widened = ensureSpan({ min: Number.NaN, max: Number.POSITIVE_INFINITY });

    assert.ok(Number.isFinite(widened.min) && Number.isFinite(widened.max));
    assert.ok(widened.max > widened.min);
  });
});

describe("computeDomain", () => {
  it("spans every non-null sample", () => {
    const domain = computeDomain(series(10, 20, 30, null, 15));

    assert.equal(domain.min, 10);
    assert.equal(domain.max, 30);
  });

  it("ignores nulls when finding the range", () => {
    // One distinct value gives a zero-width range, which ensureSpan then widens so the
    // renderer cannot divide by zero. The point here is that the nulls did not drag the
    // range towards zero.
    const domain = computeDomain(series(null, null, 5, null));

    assert.ok(domain.min <= 5 && domain.max >= 5, `range ${domain.min}..${domain.max} excludes 5`);
    assert.ok(domain.max > domain.min, "the domain must still have a usable span");
  });

  it("honours explicit bounds", () => {
    const domain = computeDomain(series(10, 20), { min: 0, max: 100 });

    assert.equal(domain.min, 0);
    assert.equal(domain.max, 100);
  });

  it("does not let data escape explicit bounds", () => {
    const domain = computeDomain(series(-50, 500), { min: 0, max: 100 });

    assert.equal(domain.min, -50);
    assert.equal(domain.max, 500);
  });

  it("returns a usable domain for an empty series", () => {
    for (const data of [[], series(null, null)]) {
      const domain = computeDomain(data);
      assert.ok(Number.isFinite(domain.min) && Number.isFinite(domain.max));
      assert.ok(domain.max > domain.min, "an empty series must not produce a zero-width domain");
    }
  });

  it("returns a usable domain for a flat series", () => {
    const domain = computeDomain(series(7, 7, 7));

    assert.ok(domain.max > domain.min);
  });
});

describe("splitSegments", () => {
  it("splits at nulls", () => {
    const segments = splitSegments(series(1, null, 3));

    assert.equal(segments.length, 2);
    assert.equal(segments[0]?.length, 1);
    assert.equal(segments[1]?.length, 1);
  });

  it("keeps a contiguous run in one segment", () => {
    assert.equal(splitSegments(series(1, 2, 3)).length, 1);
  });

  it("returns nothing for an all-null series", () => {
    assert.deepEqual(splitSegments(series(null, null)), []);
  });
});

describe("buildLinePath", () => {
  it("draws one move and one line per additional point", () => {
    const path = buildLinePath(series(0, 1, 2), BOX, { min: 0, max: 2 });

    assert.equal((path.match(/M/g) ?? []).length, 1, "a contiguous run is a single subpath");
    assert.equal((path.match(/L/g) ?? []).length, 2);
  });

  it("produces only finite coordinates", () => {
    const path = buildLinePath(series(1, 2, 3), BOX, { min: 0, max: 3 });

    for (const value of coordinates(path)) {
      assert.ok(Number.isFinite(value), `non-finite coordinate in ${path}`);
    }
  });

  it("breaks the path at a null rather than bridging it", () => {
    // A straight line across a gap would assert a measurement that was never taken.
    const path = buildLinePath(series(1, null, 3), BOX, { min: 0, max: 3 });

    assert.equal((path.match(/M/g) ?? []).length, 2, "a gap must start a new subpath");
  });

  it("breaks at every null in a ragged series", () => {
    const path = buildLinePath(series(1, null, 3, null, 5), BOX, { min: 0, max: 5 });

    assert.equal((path.match(/M/g) ?? []).length, 3);
  });

  it("handles a single sample", () => {
    const path = buildLinePath(series(42), BOX, { min: 0, max: 100 });

    assert.match(path, /^M/);
    assert.equal((path.match(/M/g) ?? []).length, 1);
  });

  it("handles an all-null series without producing a path", () => {
    assert.equal(buildLinePath(series(null, null), BOX, { min: 0, max: 1 }), "");
  });

  it("never divides by a zero-width domain", () => {
    const path = buildLinePath(series(5, 5, 5), BOX, computeDomain(series(5, 5, 5)));

    for (const value of coordinates(path)) {
      assert.ok(Number.isFinite(value), `non-finite coordinate in ${path}`);
    }
  });

  it("keeps every point inside the box", () => {
    const path = buildLinePath(series(0, 50, 100), BOX, { min: 0, max: 100 });
    const values = coordinates(path);

    for (let index = 0; index < values.length; index += 2) {
      const x = values[index] ?? 0;
      const y = values[index + 1] ?? 0;
      assert.ok(x >= BOX.x - 0.01 && x <= BOX.x + BOX.width + 0.01, `x out of bounds: ${x}`);
      assert.ok(y >= BOX.y - 0.01 && y <= BOX.y + BOX.height + 0.01, `y out of bounds: ${y}`);
    }
  });
});

describe("buildAreaPath", () => {
  it("closes a segment of two or more points", () => {
    const area = buildAreaPath(series(1, 2, 3), BOX, { min: 0, max: 3 });

    assert.match(area, /Z$/);
  });

  it("skips a single-point segment, which has no area", () => {
    const area = buildAreaPath(series(1, null, 2), BOX, { min: 0, max: 2 });

    assert.equal(area, "");
  });

  it("returns nothing for an all-null series", () => {
    assert.equal(buildAreaPath(series(null), BOX, { min: 0, max: 1 }), "");
  });
});

describe("buildBarRects", () => {
  it("draws one bar per sample for a single series", () => {
    const rects = buildBarRects([series(1, 2, 3, 4)], BOX, { min: 0, max: 4 });

    assert.equal(rects.length, 4);
  });

  it("groups bars for multiple series", () => {
    const rects = buildBarRects([series(1, 2), series(3, 4)], BOX, { min: 0, max: 4 });

    assert.equal(rects.length, 4);
  });

  it("keeps the series index when a null sample is skipped", () => {
    const rects = buildBarRects([series(null, 2), series(3, 4)], BOX, { min: 0, max: 4 });

    assert.deepEqual(
      rects.map((rect) => rect.seriesIndex),
      [1, 0, 1],
    );
  });

  it("caps the number of bars at the window", () => {
    const many = series(...Array.from({ length: 500 }, (_, index) => index));
    const rects = buildBarRects([many], BOX, { min: 0, max: 500 }, { maxBars: 20 });

    assert.equal(rects.length, 20);
  });

  it("shows the most recent samples, not the oldest", () => {
    const data = series(1, 2, 3, 4, 5);
    const rects = buildBarRects([data], BOX, { min: 0, max: 5 }, { maxBars: 2 });

    assert.deepEqual(
      rects.map((rect) => rect.value),
      [4, 5],
    );
  });

  it("gives a taller bar a larger value", () => {
    const rects = buildBarRects([series(0, 10)], BOX, { min: 0, max: 10 });
    const [low, high] = rects;

    assert.ok(low && high);
    assert.ok((high?.height ?? 0) > (low?.height ?? 0));
  });

  it("never produces a negative height", () => {
    // A value above the domain would otherwise invert the bar.
    const rects = buildBarRects([series(0, 999)], BOX, { min: 0, max: 10 });

    for (const rect of rects) {
      assert.ok(rect.height >= 0, `negative height ${rect.height}`);
    }
  });

  it("skips null samples rather than drawing a bar for them", () => {
    const rects = buildBarRects([series(1, null, 3)], BOX, { min: 0, max: 3 });

    assert.equal(rects.length, 2);
  });

  it("returns nothing for an empty series", () => {
    assert.deepEqual(buildBarRects([], BOX, { min: 0, max: 1 }), []);
    assert.deepEqual(buildBarRects([series(null, null)], BOX, { min: 0, max: 1 }), []);
  });

  it("keeps every bar inside the box", () => {
    const rects = buildBarRects([series(1, 5, 9)], BOX, { min: 0, max: 10 });

    for (const rect of rects) {
      assert.ok(rect.x >= BOX.x - 0.01, `x below the box: ${rect.x}`);
      assert.ok(rect.x + rect.width <= BOX.x + BOX.width + 0.01, `bar past the right edge`);
      assert.ok(rect.y >= BOX.y - 0.01, `y above the box: ${rect.y}`);
    }
  });
});

describe("gaugeArc", () => {
  const CX = 50;
  const CY = 50;
  const R = 40;

  it("draws the full sweep for a ratio of one", () => {
    const arc = gaugeArc(CX, CY, R, 1);

    assert.equal(arc.ratio, 1);
    assert.match(arc.d, /^M/);
    assert.match(arc.d, /A/);
  });

  it("clamps a value above the maximum", () => {
    // An arc that overflows its own track is unreadable; the caller still shows the number.
    assert.equal(gaugeArc(CX, CY, R, 1.5).ratio, 1);
  });

  it("clamps a negative value", () => {
    assert.equal(gaugeArc(CX, CY, R, -0.5).ratio, 0);
  });

  it("treats a non-finite ratio as zero", () => {
    assert.equal(gaugeArc(CX, CY, R, Number.NaN).ratio, 0);
  });

  it("draws a full track rather than an invisible arc at zero", () => {
    // A zero-length arc cannot be expressed with a single elliptical command, and a dot would
    // be invisible at small radii.
    const zero = gaugeArc(CX, CY, R, 0);
    const full = gaugeArc(CX, CY, R, 1);

    assert.equal(zero.ratio, 0);
    assert.equal(zero.d, full.d);
  });

  it("produces only finite coordinates", () => {
    for (const ratio of [0, 0.25, 0.5, 1]) {
      for (const value of coordinates(gaugeArc(CX, CY, R, ratio).d)) {
        assert.ok(Number.isFinite(value));
      }
    }
  });
});

describe("bulletBands", () => {
  it("produces contiguous bands from 0 to 1", () => {
    const bands = bulletBands({ min: 0, max: 100 });

    assert.equal(bands[0]?.from, 0);
    assert.equal(bands[bands.length - 1]?.to, 100);

    for (let index = 1; index < bands.length; index += 1) {
      assert.equal(bands[index]?.from, bands[index - 1]?.to, "bands must not leave a gap");
    }
  });

  it("assigns escalating tones", () => {
    const tones = bulletBands({ min: 0, max: 100 }).map((band) => band.tone);

    assert.equal(tones[0], "poor");
    assert.ok(tones.includes("good"));
  });

  it("survives a degenerate range", () => {
    const bands = bulletBands({ min: 5, max: 5 });

    assert.ok(bands.length > 0);
    for (const band of bands) {
      assert.ok(band.to > band.from, "a degenerate range must not produce zero-width bands");
    }
  });

  it("clamps out-of-range stops", () => {
    for (const band of bulletBands({ min: 0, max: 100 }, [-1, 0.5, 5])) {
      assert.ok(Number.isFinite(band.from) && Number.isFinite(band.to));
    }
  });
});

describe("ratioInRange", () => {
  it("maps a value to a fraction", () => {
    assert.equal(ratioInRange(50, { min: 0, max: 100 }), 0.5);
  });

  it("clamps outside the range", () => {
    assert.equal(ratioInRange(150, { min: 0, max: 100 }), 1);
    assert.equal(ratioInRange(-5, { min: 0, max: 100 }), 0);
  });

  it("returns null for a missing value", () => {
    assert.equal(ratioInRange(null, { min: 0, max: 100 }), null);
  });

  it("returns zero rather than dividing by zero", () => {
    assert.equal(ratioInRange(5, { min: 5, max: 5 }), 0);
  });
});

describe("axisGutter", () => {
  const VIEW_WIDTH = 320;

  it("is wide enough for a bare number", () => {
    const gutter = axisGutter(["0.0", "50.0", "100.0"], VIEW_WIDTH);

    assert.ok(gutter >= 5 * 5.6, "a five-character label must fit");
  });

  it("grows for a label with a unit suffix", () => {
    // The defect this exists to prevent: "59.8 q/s" clipped to "9.8 q/s" by a gutter sized for a
    // bare number.
    const bare = axisGutter(["12.3"], VIEW_WIDTH);
    const withUnit = axisGutter(["59.8 q/s"], VIEW_WIDTH);

    assert.ok(withUnit > bare, "a longer label must get a wider gutter");
    assert.ok(withUnit >= 8 * 5.6, `nine characters must fit: ${withUnit}`);
  });

  it("fits the widest label, not the first", () => {
    const gutter = axisGutter(["1.0", "222.2 GiB", "3.0"], VIEW_WIDTH);

    assert.ok(gutter >= 10 * 5.6, `the widest label must fit: ${gutter}`);
  });

  it("keeps every label inside the view box", () => {
    const labels = ["214.9 GiB", "107.4 GiB", "0.0 B"];
    const gutter = axisGutter(labels, VIEW_WIDTH);

    for (const label of labels) {
      // The label is right-anchored at gutter - 6, so it extends left by its own width.
      assert.ok(gutter - 6 - label.length * 5.6 >= 0, `"${label}" would be clipped`);
    }
  });

  it("handles no labels at all", () => {
    assert.equal(axisGutter([], VIEW_WIDTH), 8);
  });

  it("caps the gutter so the plot cannot vanish", () => {
    const absurd = axisGutter(["x".repeat(200)], VIEW_WIDTH);

    assert.ok(absurd <= VIEW_WIDTH * 0.4, "the gutter must stay a fraction of the width");
  });
});

describe("plotBox", () => {
  it("insets the plot by the gutter on the left", () => {
    const box = plotBox(320, 140, 60);

    assert.equal(box.x, 60);
    assert.equal(box.width, 320 - 60 - 10);
  });

  it("leaves a usable plot for the widest reasonable label", () => {
    const gutter = axisGutter(["59.76 q/s"], 320);
    const box = plotBox(320, 140, gutter);

    assert.ok(box.width > 180, `the plot should still be wide: ${box.width}`);
  });

  it("keeps a positive width even at the cap", () => {
    const box = plotBox(320, 140, axisGutter(["x".repeat(200)], 320));

    assert.ok(box.width > 0);
    assert.ok(box.height > 0);
  });
});
