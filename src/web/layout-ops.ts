import { LAYOUT_LIMITS, LAYOUT_VERSION } from "../shared/layout.ts";
import type { GridSpan, Layout, Tab, WidgetConfig, WidgetType } from "../shared/layout.ts";

/**
 * Layout mutations.
 *
 * Every function returns a new document rather than editing in place. That makes each change
 * easy to reason about, easy to compare for a change signature, and impossible to apply
 * halfway.
 *
 * The last tab can never be deleted, because a layout with no tabs is invalid and rejecting it
 * at the point of the click gives a far better experience than a rejected save.
 */

function cloneTab(tab: Tab): Tab {
  return {
    id: tab.id,
    name: tab.name,
    // `metrics` is copied explicitly: a shallow spread would share the array with the
    // source document, so pushing to a result would silently mutate the original and break
    // the "never edits in place" contract this module promises.
    widgets: tab.widgets.map((widget) => ({ ...widget, metrics: [...widget.metrics] })),
  };
}

function cloneLayout(layout: Layout): Layout {
  return {
    version: layout.version,
    activeTabId: layout.activeTabId,
    tabs: layout.tabs.map(cloneTab),
  };
}

export function findTab(layout: Layout, tabId: string): Tab | undefined {
  return layout.tabs.find((tab) => tab.id === tabId);
}

export function activeTab(layout: Layout): Tab {
  // Defensive: a document from disk could be inconsistent even though it validated, and the
  // dashboard must always have something to render.
  return (
    findTab(layout, layout.activeTabId) ?? layout.tabs[0] ?? { id: "tab", name: "Tab", widgets: [] }
  );
}

function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function setActiveTab(layout: Layout, tabId: string): Layout {
  if (!findTab(layout, tabId)) return layout;
  if (layout.activeTabId === tabId) return layout;
  return { ...cloneLayout(layout), activeTabId: tabId };
}

export function addTab(layout: Layout, name: string): Layout {
  if (layout.tabs.length >= LAYOUT_LIMITS.maxTabs) return layout;

  const next = cloneLayout(layout);
  const id = uniqueId(
    `tab-${
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "new"
    }`,
    next.tabs.map((tab) => tab.id),
  );

  next.tabs.push({ id, name, widgets: [] });
  next.activeTabId = id;
  return next;
}

export function renameTab(layout: Layout, tabId: string, name: string): Layout {
  const trimmed = name.trim().slice(0, LAYOUT_LIMITS.tabNameMaxLength);
  if (trimmed.length === 0) return layout;

  const next = cloneLayout(layout);
  const tab = next.tabs.find((entry) => entry.id === tabId);
  if (!tab) return layout;
  tab.name = trimmed;
  return next;
}

/**
 * Delete a tab.
 *
 * The last tab is never removed. When the active tab is the one deleted, the neighbour at the
 * same index is activated, so the dashboard is never left showing nothing.
 */
export function removeTab(layout: Layout, tabId: string): Layout {
  if (layout.tabs.length <= 1) return layout;

  const index = layout.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return layout;

  const next = cloneLayout(layout);
  next.tabs.splice(index, 1);

  if (layout.activeTabId === tabId) {
    const replacement = next.tabs[Math.min(index, next.tabs.length - 1)];
    next.activeTabId = replacement?.id ?? next.tabs[0]?.id ?? "";
  }

  return next;
}

export function addWidget(
  layout: Layout,
  tabId: string,
  widget: Omit<WidgetConfig, "id"> & { id?: string },
): Layout {
  const next = cloneLayout(layout);
  const tab = next.tabs.find((entry) => entry.id === tabId);
  if (!tab) return layout;
  if (tab.widgets.length >= LAYOUT_LIMITS.maxWidgetsPerTab) return layout;

  const id =
    widget.id ??
    uniqueId(
      `widget-${widget.title}`,
      tab.widgets.map((w) => w.id),
    );
  tab.widgets.push({ ...widget, id });
  return next;
}

export function updateWidget(
  layout: Layout,
  tabId: string,
  widgetId: string,
  changes: Partial<WidgetConfig>,
): Layout {
  const next = cloneLayout(layout);
  const tab = next.tabs.find((entry) => entry.id === tabId);
  const widget = tab?.widgets.find((entry) => entry.id === widgetId);
  if (!widget) return layout;

  Object.assign(widget, changes);
  return next;
}

export function removeWidget(layout: Layout, tabId: string, widgetId: string): Layout {
  const next = cloneLayout(layout);
  const tab = next.tabs.find((entry) => entry.id === tabId);
  if (!tab) return layout;

  const index = tab.widgets.findIndex((widget) => widget.id === widgetId);
  if (index < 0) return layout;

  tab.widgets.splice(index, 1);
  return next;
}

/** Move a widget within its tab. Out-of-range moves are ignored rather than clamped. */
export function moveWidget(
  layout: Layout,
  tabId: string,
  widgetId: string,
  direction: -1 | 1,
): Layout {
  const next = cloneLayout(layout);
  const tab = next.tabs.find((entry) => entry.id === tabId);
  if (!tab) return layout;

  const index = tab.widgets.findIndex((widget) => widget.id === widgetId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= tab.widgets.length) return layout;

  const [widget] = tab.widgets.splice(index, 1);
  if (!widget) return layout;
  tab.widgets.splice(target, 0, widget);
  return next;
}

export function setWidgetSpan(
  layout: Layout,
  tabId: string,
  widgetId: string,
  span: GridSpan,
): Layout {
  return updateWidget(layout, tabId, widgetId, { span });
}

export function setWidgetType(
  layout: Layout,
  tabId: string,
  widgetId: string,
  type: WidgetType,
): Layout {
  const next = cloneLayout(layout);
  const tab = next.tabs.find((entry) => entry.id === tabId);
  const widget = tab?.widgets.find((entry) => entry.id === widgetId);
  if (!widget) return layout;

  widget.type = type;
  // Gauge, bullet, and table render only the first metric. Keeping a comparison in the
  // document would make a missing second metric look like a failure of a chart that never
  // reads it, so the type change removes the now-invisible metric.
  const primary = widget.metrics[0];
  if (type !== "line" && type !== "bar" && primary) {
    widget.metrics = [primary];
  }

  return next;
}

/**
 * Rename a widget without changing its identity.
 *
 * The title is plain text stored in the layout document. Trimming and bounding it here, rather
 * than only in the input, keeps the same guarantee for any future caller.
 */
export function setWidgetTitle(
  layout: Layout,
  tabId: string,
  widgetId: string,
  title: string,
): Layout {
  const trimmed = title.trim().slice(0, LAYOUT_LIMITS.titleMaxLength);
  if (trimmed.length === 0) return layout;

  const tab = findTab(layout, tabId);
  const widget = tab?.widgets.find((entry) => entry.id === widgetId);
  if (!widget || widget.title === trimmed) return layout;

  return updateWidget(layout, tabId, widgetId, { title: trimmed });
}

/** Replace a widget's metric list, ignoring duplicates and preserving order. */
export function setWidgetMetrics(
  layout: Layout,
  tabId: string,
  widgetId: string,
  metrics: string[],
): Layout {
  const unique: string[] = [];
  for (const metric of metrics) {
    if (!unique.includes(metric) && unique.length < LAYOUT_LIMITS.maxMetricsPerWidget) {
      unique.push(metric);
    }
  }
  if (unique.length === 0) return layout;
  return updateWidget(layout, tabId, widgetId, { metrics: unique });
}

/**
 * Select a source and metric together.
 *
 * The widget's display metadata belongs to the metric, not to the widget. Replacing only
 * `metrics` would leave the previous unit and bounds in place, so a memory percentage could
 * keep a `B/s` label. Omitted bounds are removed rather than inherited.
 */
export function setWidgetMetric(
  layout: Layout,
  tabId: string,
  widgetId: string,
  sourceId: string,
  metric: string,
  options: { unit?: string; min?: number; max?: number } = {},
): Layout {
  if (sourceId.length === 0 || metric.length === 0) return layout;

  const next = cloneLayout(layout);
  const tab = next.tabs.find((entry) => entry.id === tabId);
  const widget = tab?.widgets.find((entry) => entry.id === widgetId);
  if (!widget) return layout;

  widget.sourceId = sourceId;
  widget.metrics = [metric];
  if (options.unit !== undefined) widget.unit = options.unit;
  else delete widget.unit;
  if (options.min !== undefined) widget.min = options.min;
  else delete widget.min;
  if (options.max !== undefined) widget.max = options.max;
  else delete widget.max;

  return next;
}

/** An empty, valid document. Used only if the server is unreachable at startup. */
export function emptyLayout(): Layout {
  return {
    version: LAYOUT_VERSION,
    activeTabId: "tab",
    tabs: [{ id: "tab", name: "Tab", widgets: [] }],
  };
}

/**
 * A short signature of a widget's rendered data.
 *
 * Used to skip redrawing a widget whose numbers have not changed, which is most of them most
 * of the time on a 2 Hz cycle.
 */
export function dataSignature(values: (number | null)[], status: string): string {
  return `${status}|${values.map((value) => (value === null ? "-" : value.toFixed(3))).join(",")}`;
}
