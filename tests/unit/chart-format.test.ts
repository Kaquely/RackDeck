import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatAge,
  formatBytes,
  formatCount,
  formatCell,
  formatDuration,
  formatPercent,
  formatRate,
  formatValue,
} from "../../src/web/charts/format.ts";

describe("formatBytes", () => {
  it("shows whole bytes without a decimal", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
  });

  it("scales to binary units", () => {
    assert.equal(formatBytes(1024), "1.0 KiB");
    assert.equal(formatBytes(1024 * 1024), "1.0 MiB");
    assert.equal(formatBytes(1024 ** 3), "1.0 GiB");
    assert.equal(formatBytes(1024 ** 4), "1.0 TiB");
  });

  it("keeps a fraction", () => {
    assert.equal(formatBytes(1536), "1.5 KiB");
  });

  it("keeps the sign on a negative value", () => {
    assert.equal(formatBytes(-2048), "-2.0 KiB");
  });

  it("shows a dash for a missing value rather than zero", () => {
    // Zero would read as a real, healthy measurement.
    assert.equal(formatBytes(null), "—");
    assert.equal(formatBytes(Number.NaN), "—");
  });

  it("does not exceed the largest unit", () => {
    const huge = formatBytes(1024 ** 6);

    assert.match(huge, /PiB$/);
  });
});

describe("formatRate", () => {
  it("appends a per-second suffix", () => {
    assert.equal(formatRate(1024), "1.0 KiB/s");
  });

  it("shows a dash for a missing rate", () => {
    assert.equal(formatRate(null), "—");
  });

  it("shows a real zero", () => {
    assert.equal(formatRate(0), "0 B/s");
  });
});

describe("formatPercent", () => {
  it("adds a percent sign", () => {
    assert.equal(formatPercent(42.14), "42.1%");
  });

  it("shows a dash for a missing value", () => {
    assert.equal(formatPercent(null), "—");
  });

  it("distinguishes zero from missing", () => {
    assert.equal(formatPercent(0), "0.0%");
    assert.notEqual(formatPercent(0), formatPercent(null));
  });
});

describe("formatDuration", () => {
  it("shows seconds below a minute", () => {
    assert.equal(formatDuration(45), "45s");
  });

  it("shows minutes and seconds", () => {
    assert.equal(formatDuration(90), "1m 30s");
  });

  it("shows hours and minutes", () => {
    assert.equal(formatDuration(3_700), "1h 1m");
  });

  it("shows days and hours", () => {
    assert.equal(formatDuration(90_000), "1d 1h");
  });

  it("shows a dash for a missing or negative value", () => {
    assert.equal(formatDuration(null), "—");
    assert.equal(formatDuration(-1), "—");
  });
});

describe("formatCount", () => {
  it("separates thousands", () => {
    assert.equal(formatCount(1234567), "1,234,567");
  });

  it("rounds a fractional count", () => {
    assert.equal(formatCount(3.6), "4");
  });

  it("shows a dash for a missing value", () => {
    assert.equal(formatCount(null), "—");
  });
});

describe("formatValue", () => {
  it("routes by the unit the metric declares", () => {
    assert.equal(formatValue(1024, "bytes"), "1.0 KiB");
    assert.equal(formatValue(2048, "B/s"), "2.0 KiB/s");
    assert.equal(formatValue(50, "%"), "50.0%");
    assert.equal(formatValue(120, "s"), "2m 0s");
  });

  it("keeps a unitless metric readable without inventing precision", () => {
    assert.equal(formatValue(0.75, ""), "0.75");
    assert.equal(formatValue(187, ""), "187");
  });

  it("always shows a dash for a missing value, whatever the unit", () => {
    for (const unit of ["", "%", "bytes", "B/s", "s", "widgets"]) {
      assert.equal(formatValue(null, unit), "—", `unit ${unit}`);
    }
  });

  it("falls back to the unit for an unrecognised one", () => {
    assert.equal(formatValue(3, "widgets"), "3.00 widgets");
  });
});

describe("formatCell", () => {
  it("formats byte columns for reading", () => {
    assert.equal(formatCell("sizeBytes", 1024 ** 3), "1.0 GiB");
    assert.equal(formatCell("usedBytes", 512), "512 B");
  });

  it("formats a percentage column", () => {
    assert.equal(formatCell("usedPercent", 77.7), "77.7%");
  });

  it("formats counts", () => {
    assert.equal(formatCell("rxErrors", 3), "3");
  });

  it("passes a string cell through unchanged", () => {
    assert.equal(formatCell("mount", "/dev/sda1"), "/dev/sda1");
  });

  it("shows a dash for a missing cell", () => {
    assert.equal(formatCell("sizeBytes", null), "—");
  });
});

describe("formatAge", () => {
  it("describes a very recent reading", () => {
    assert.equal(formatAge(200), "just now");
  });

  it("describes an older reading", () => {
    assert.equal(formatAge(125_000), "2m 5s ago");
  });

  it("shows a dash for an unknown age", () => {
    assert.equal(formatAge(null), "—");
    assert.equal(formatAge(-1), "—");
  });
});
