/**
 * The layout document: the user's tabs and widgets.
 *
 * This is the only durable state in the product and the only resource the API accepts
 * writes to. It is shared between the server, which validates and persists it, and the
 * frontend, which edits it, so that both sides agree on the shape by construction.
 */

/** Supported chart forms. */
export const WIDGET_TYPES = ["line", "bar", "gauge", "table", "bullet"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Widget width in grid columns, on a four-column grid. */
export const GRID_SPANS = [1, 2, 3, 4] as const;
export type GridSpan = (typeof GRID_SPANS)[number];

/** Bumped only for a breaking change to the document shape. */
export const LAYOUT_VERSION = 1;

/**
 * Bounds applied during validation.
 *
 * The layout is a single file read on every request, so an unbounded document would be both
 * a memory and a latency risk against the 200 ms response budget.
 */
export const LAYOUT_LIMITS = {
  maxTabs: 12,
  maxWidgetsPerTab: 24,
  maxMetricsPerWidget: 8,
  idMaxLength: 64,
  tabNameMaxLength: 60,
  titleMaxLength: 120,
} as const;

export type WidgetConfig = {
  id: string;
  type: WidgetType;
  title: string;
  /** Identifier of the data source this widget reads from, for example `host`. */
  sourceId: string;
  /** Metric keys within that source, for example `cpu.usage`. */
  metrics: string[];
  span: GridSpan;
  unit?: string;
  /** Lower and upper bounds, used by `gauge` and `bullet` to scale the value. */
  min?: number;
  max?: number;
};

export type Tab = {
  id: string;
  name: string;
  widgets: WidgetConfig[];
};

export type Layout = {
  version: number;
  activeTabId: string;
  tabs: Tab[];
};

export function isWidgetType(value: unknown): value is WidgetType {
  return typeof value === "string" && (WIDGET_TYPES as readonly string[]).includes(value);
}

export function isGridSpan(value: unknown): value is GridSpan {
  return typeof value === "number" && (GRID_SPANS as readonly number[]).includes(value);
}

/**
 * The layout served when nothing has been saved yet.
 *
 * It is deliberately populated with real widgets rather than an empty dashboard: the first
 * thing a user sees should demonstrate the product, and it gives the frontend something to
 * render before any configuration exists.
 *
 * Every `sourceId`/`metric` pair here must match a key the host collector actually
 * publishes. `tests/unit/default-layout-metrics.test.ts` asserts that, so a renamed metric
 * breaks a test instead of silently producing an empty widget.
 */
export function defaultLayout(): Layout {
  return {
    version: LAYOUT_VERSION,
    activeTabId: "tab-system",
    tabs: [
      {
        id: "tab-system",
        name: "System",
        widgets: [
          {
            id: "widget-cpu",
            type: "line",
            title: "CPU usage",
            sourceId: "host",
            metrics: ["cpu.usage"],
            span: 2,
            unit: "%",
            min: 0,
            max: 100,
          },
          {
            id: "widget-memory",
            type: "gauge",
            title: "Memory used",
            sourceId: "host",
            metrics: ["memory.usage"],
            span: 1,
            unit: "%",
            min: 0,
            max: 100,
          },
          {
            id: "widget-load",
            type: "bullet",
            title: "Load average (1m)",
            sourceId: "host",
            metrics: ["cpu.loadAverage"],
            span: 1,
            unit: "",
          },
        ],
      },
      {
        id: "tab-storage",
        name: "Storage",
        widgets: [
          {
            id: "widget-disks",
            type: "bar",
            title: "Disk usage (busiest mount)",
            sourceId: "host",
            metrics: ["storage.usedPercent"],
            span: 2,
            unit: "%",
            min: 0,
            max: 100,
          },
          {
            id: "widget-disk-table",
            type: "table",
            title: "Mounts",
            sourceId: "host",
            metrics: ["storage.disks"],
            span: 2,
          },
        ],
      },
      {
        id: "tab-network",
        name: "Network",
        widgets: [
          {
            id: "widget-network",
            type: "line",
            title: "Network throughput",
            sourceId: "host",
            metrics: ["network.rxBytesPerSecond", "network.txBytesPerSecond"],
            span: 2,
            unit: "B/s",
          },
          {
            id: "widget-network-table",
            type: "table",
            title: "Interfaces",
            sourceId: "host",
            metrics: ["network.interfaces"],
            span: 2,
          },
        ],
      },
    ],
  };
}

export type ValidationResult = { ok: true; value: Layout } | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateIdentifier(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return;
  }
  if (value.length > LAYOUT_LIMITS.idMaxLength) {
    errors.push(`${path} must be at most ${LAYOUT_LIMITS.idMaxLength} characters`);
  }
}

function validateBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  errors: string[],
): void {
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return;
  }
  if (value.length > maxLength) {
    errors.push(`${path} must be at most ${maxLength} characters`);
  }
}

/**
 * Read an optional finite number into `target[key]`, recording an error when present but
 * invalid. A non-finite bound would produce a chart that silently renders nothing.
 */
function readOptionalBound(
  value: unknown,
  path: string,
  key: "min" | "max",
  target: Record<string, unknown>,
  errors: string[],
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path} must be a finite number when present`);
    return;
  }
  target[key] = value;
}

function validateWidget(raw: unknown, path: string, errors: string[]): WidgetConfig | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return null;
  }

  const before = errors.length;

  validateIdentifier(raw.id, `${path}.id`, errors);

  if (!isWidgetType(raw.type)) {
    errors.push(`${path}.type must be one of: ${WIDGET_TYPES.join(", ")}`);
  }

  validateBoundedString(raw.title, `${path}.title`, LAYOUT_LIMITS.titleMaxLength, errors);
  validateIdentifier(raw.sourceId, `${path}.sourceId`, errors);

  if (!Array.isArray(raw.metrics) || raw.metrics.length === 0) {
    errors.push(`${path}.metrics must be a non-empty array`);
  } else {
    if (raw.metrics.length > LAYOUT_LIMITS.maxMetricsPerWidget) {
      errors.push(
        `${path}.metrics must contain at most ${LAYOUT_LIMITS.maxMetricsPerWidget} entries`,
      );
    }
    for (const [index, metric] of raw.metrics.entries()) {
      validateIdentifier(metric, `${path}.metrics[${index}]`, errors);
    }
  }

  if (!isGridSpan(raw.span)) {
    errors.push(`${path}.span must be one of: ${GRID_SPANS.join(", ")}`);
  }

  if (raw.unit !== undefined && typeof raw.unit !== "string") {
    errors.push(`${path}.unit must be a string when present`);
  }

  const bounds: Record<string, unknown> = {};
  readOptionalBound(raw.min, `${path}.min`, "min", bounds, errors);
  readOptionalBound(raw.max, `${path}.max`, "max", bounds, errors);

  if (
    typeof bounds.min === "number" &&
    typeof bounds.max === "number" &&
    bounds.min >= bounds.max
  ) {
    errors.push(`${path}.min must be less than ${path}.max`);
  }

  if (errors.length !== before) return null;

  const widget: WidgetConfig = {
    id: raw.id as string,
    type: raw.type as WidgetType,
    title: raw.title as string,
    sourceId: raw.sourceId as string,
    metrics: raw.metrics as string[],
    span: raw.span as GridSpan,
  };
  if (typeof raw.unit === "string") widget.unit = raw.unit;
  if (typeof bounds.min === "number") widget.min = bounds.min;
  if (typeof bounds.max === "number") widget.max = bounds.max;
  return widget;
}

function validateTab(raw: unknown, path: string, errors: string[]): Tab | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return null;
  }

  const before = errors.length;

  validateIdentifier(raw.id, `${path}.id`, errors);
  validateBoundedString(raw.name, `${path}.name`, LAYOUT_LIMITS.tabNameMaxLength, errors);

  if (!Array.isArray(raw.widgets)) {
    errors.push(`${path}.widgets must be an array`);
    return null;
  }
  if (raw.widgets.length > LAYOUT_LIMITS.maxWidgetsPerTab) {
    errors.push(`${path}.widgets must contain at most ${LAYOUT_LIMITS.maxWidgetsPerTab} entries`);
  }

  const widgets: WidgetConfig[] = [];
  for (const [index, widget] of raw.widgets.entries()) {
    const parsed = validateWidget(widget, `${path}.widgets[${index}]`, errors);
    if (parsed) widgets.push(parsed);
  }

  if (errors.length !== before) return null;
  return { id: raw.id as string, name: raw.name as string, widgets };
}

/**
 * Validate an untrusted layout document.
 *
 * Validation is all-or-nothing on purpose. A partially applied layout would leave the
 * dashboard in a state the user cannot repair through the UI, so any error rejects the whole
 * document and leaves stored state untouched.
 */
export function validateLayout(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }

  if (input.version !== LAYOUT_VERSION) {
    errors.push(`version must be ${LAYOUT_VERSION}`);
  }

  if (!Array.isArray(input.tabs)) {
    errors.push("tabs must be an array");
    return { ok: false, errors };
  }
  if (input.tabs.length === 0) {
    errors.push("tabs must contain at least one tab");
  }
  if (input.tabs.length > LAYOUT_LIMITS.maxTabs) {
    errors.push(`tabs must contain at most ${LAYOUT_LIMITS.maxTabs} entries`);
  }

  const tabs: Tab[] = [];
  for (const [index, tab] of input.tabs.entries()) {
    const parsed = validateTab(tab, `tabs[${index}]`, errors);
    if (parsed) tabs.push(parsed);
  }

  const seenTabIds = new Set<string>();
  for (const tab of tabs) {
    if (seenTabIds.has(tab.id)) errors.push(`duplicate tab id: ${tab.id}`);
    seenTabIds.add(tab.id);
  }

  for (const [index, tab] of tabs.entries()) {
    const seenWidgetIds = new Set<string>();
    for (const widget of tab.widgets) {
      if (seenWidgetIds.has(widget.id)) {
        errors.push(`duplicate widget id in tabs[${index}]: ${widget.id}`);
      }
      seenWidgetIds.add(widget.id);
    }
  }

  if (typeof input.activeTabId !== "string") {
    errors.push("activeTabId must be a string");
  } else if (tabs.length > 0 && !seenTabIds.has(input.activeTabId)) {
    errors.push(`activeTabId must reference an existing tab: ${input.activeTabId}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      version: LAYOUT_VERSION,
      activeTabId: input.activeTabId as string,
      tabs,
    },
  };
}
