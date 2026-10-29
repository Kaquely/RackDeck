import type { WidgetConfig } from "../shared/layout.ts";
import type { TableData, Series } from "../shared/observations.ts";
import { formatValue } from "./charts/format.ts";

/**
 * The value shown in a widget header.
 *
 * Kept pure and separate from the DOM so the awkward cases are testable: a table has rows
 * rather than series, and reporting "0/0 reporting" above a populated table is meaningless
 * text that looks like a fault.
 */

export type WidgetValueInput = {
  widget: WidgetConfig;
  /** Latest value per configured metric, `null` where not measurable. */
  values: (number | null)[];
  series: Series[];
  table: TableData | null;
};

export function describeWidgetValue(input: WidgetValueInput): string {
  const { widget, values, table } = input;

  // A table is a structure, not a trend. Counting series there produces "0/0 reporting".
  if (widget.type === "table") {
    if (!table) return "—";
    const rows = table.rows.length;
    return rows === 1 ? "1 row" : `${rows} rows`;
  }

  if (values.length === 0) return "—";

  if (values.length === 1) {
    const unit = widget.unit ?? input.series[0]?.unit ?? "";
    return formatValue(values[0] ?? null, unit);
  }

  const reporting = values.filter((value) => value !== null).length;
  return `${reporting}/${values.length} reporting`;
}
