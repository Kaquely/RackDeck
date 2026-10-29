import {
  fetchConfig,
  fetchLayout,
  fetchReadings,
  fetchUpdateStatus,
  fetchVersion,
  indexReadings,
  saveLayout,
} from "./api.ts";
import type { PublicConfig, ReadingsIndex } from "./api.ts";
import {
  activeTab,
  addTab,
  addWidget,
  dataSignature,
  emptyLayout,
  moveWidget,
  removeTab,
  removeWidget,
  renameTab,
  setActiveTab,
  setWidgetMetric,
  setWidgetMetrics,
  setWidgetSpan,
  setWidgetTitle,
  setWidgetType,
} from "./layout-ops.ts";
import type { Layout, Tab, WidgetConfig, WidgetType } from "../shared/layout.ts";
import { GRID_SPANS, LAYOUT_LIMITS, WIDGET_TYPES } from "../shared/layout.ts";
import { buildSummary, humaniseColumn, renderChart, resolveWidget } from "./charts/render.ts";
import { describeOverall, describeSource } from "./source-status.ts";
import { describeWidgetValue } from "./widget-value.ts";
import { formatAge } from "./charts/format.ts";
import { buildDefaultWidget, availableMetrics } from "./widget-defaults.ts";
import type { MetricOption } from "./widget-defaults.ts";
import { mountNodesControl } from "./nodes.ts";
import { applyMode, nextMode, readMode, storeMode } from "./display-mode.ts";
import type { DisplayMode } from "./display-mode.ts";
import { mountUpdateBanner, readDismissedVersion } from "./update-banner.ts";
import "./styles.css";

/**
 * The dashboard client.
 *
 * Three responsibilities, kept deliberately separate: poll the snapshot, hold the layout, and
 * render. Polling never triggers a save, and rendering never triggers a fetch, so a slow
 * response and a rapid edit cannot entangle.
 */

const SAVE_DEBOUNCE_MS = 400;

type SaveState = "idle" | "pending" | "saving" | "saved" | "failed";

type WidgetView = {
  root: HTMLElement;
  chart: HTMLElement;
  value: HTMLElement;
  summary: HTMLElement;
  signature: string | null;
  /** Keeps the chart width in sync when the grid span or viewport changes. */
  observer: ResizeObserver | null;
};

const dom = {
  app: null as HTMLElement | null,
  mode: null as HTMLButtonElement | null,
  tabs: null as HTMLElement | null,
  grid: null as HTMLElement | null,
  status: null as HTMLElement | null,
  save: null as HTMLElement | null,
  updateBanner: null as HTMLElement | null,
};

const state = {
  layout: emptyLayout(),
  mode: "edit" as DisplayMode,
  config: null as PublicConfig | null,
  readings: null as ReadingsIndex | null,
  views: new Map<string, WidgetView>(),
  saveState: "idle" as SaveState,
  saveTimer: null as ReturnType<typeof setTimeout> | null,
  inFlight: false,
  /** True once the metric selectors have been built from a real snapshot. */
  controlsBuiltFromData: false,
  /** Source ids and labels the controls were built from; a change rebuilds them. */
  sourceKey: "",
  pollTimer: null as ReturnType<typeof setInterval> | null,
  connected: true,
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function currentTab() {
  return activeTab(state.layout);
}

// ---------------------------------------------------------------- persistence

function markDirty(): void {
  state.saveState = "pending";
  renderSaveState();

  if (state.saveTimer !== null) clearTimeout(state.saveTimer);
  // Debounced: renaming a tab fires per keystroke, and saving on each would produce a
  // request per character.
  state.saveTimer = setTimeout(() => {
    void persist();
  }, SAVE_DEBOUNCE_MS);
}

async function persist(): Promise<void> {
  state.saveState = "saving";
  renderSaveState();

  try {
    // Adopt the stored document rather than assuming the local one was saved verbatim.
    state.layout = await saveLayout(state.layout);
    state.saveState = "saved";
  } catch (error) {
    // The edit stays on screen. Silently discarding it would lose the user's work.
    state.saveState = "failed";
    console.error("[dashboard] could not save the layout", error);
  }

  renderSaveState();
}

function clearWidgetViews(): void {
  for (const view of state.views.values()) view.observer?.disconnect();
  state.views.clear();
}

/** Adopt a new layout and re-render everything that depends on it. */
function applyLayout(layout: Layout, options: { save: boolean }): void {
  state.layout = layout;
  renderTabs();
  renderGrid();
  // Populate the freshly built widgets immediately; waiting for the next poll would leave
  // the grid blank for up to one interval after every edit.
  renderWidgetData();

  if (options.save) markDirty();
}

// ---------------------------------------------------------------- display mode

/** Controls that view mode hides, and therefore removes from the tab order. */
const CONTROLS_HIDDEN_IN_VIEW = [
  ".widget__controls",
  ".widget__rename",
  ".widget__title-input",
  ".tab--add",
  ".tab--add-widget",
  ".tab--rename",
  ".tab__remove",
  "#nodes-button",
  ".empty .button",
].join(", ");

function setMode(mode: DisplayMode): void {
  // Move focus before the control becomes `display: none`, so it is never stranded there.
  const active = document.activeElement;
  if (mode === "view" && active instanceof HTMLElement && active.closest(CONTROLS_HIDDEN_IN_VIEW)) {
    dom.mode?.focus();
  }

  state.mode = mode;
  if (dom.app && dom.mode) applyMode(dom.app, dom.mode, mode);
  storeMode(mode);
}

// ---------------------------------------------------------------- header

function renderHeader(): void {
  if (!dom.status) return;

  const readings = state.readings;
  const fragments: HTMLElement[] = [];

  const health = h("span", "status__item");
  // A source that has never sampled is "starting", not "unavailable". Conflating the two
  // shows a red failure while the collector is merely on its first cycle.
  const overall = describeOverall(readings?.sources ?? []);
  health.classList.add(`status__pill--${overall.tone}`);
  health.textContent = overall.label;
  fragments.push(health);

  for (const source of readings?.sources ?? []) {
    const view = describeSource(source);
    const pill = h("span", "status__pill");
    pill.classList.add(`status__pill--${view.tone}`);
    pill.textContent = view.label;
    // The reason is in the title, so it is available on hover and to assistive technology.
    if (view.detail) pill.title = view.detail;
    fragments.push(pill);
  }

  const age = readings ? h("span", "status__item status__item--muted") : null;
  if (age) {
    age.dataset.role = "age";
    age.textContent = readings
      ? `Updated ${formatAge(Date.now() - readings.generatedAt)}`
      : "Waiting for data";
    fragments.push(age);
  }

  dom.status.replaceChildren(...fragments);
}

function renderSaveState(): void {
  if (!dom.save) return;
  const labels: Record<SaveState, string> = {
    idle: "",
    pending: "Unsaved changes",
    saving: "Saving…",
    saved: "Saved",
    failed: "Could not save — your change is still here",
  };
  dom.save.textContent = labels[state.saveState];
  dom.save.className = `save-state save-state--${state.saveState}`;
  dom.save.hidden = state.saveState === "idle";
}

// ---------------------------------------------------------------- widget creation

function suggestedType(option: MetricOption): WidgetConfig["type"] {
  if (option.kind === "table") return "table";
  if (option.metric === "memory.usage" || option.metric === "storage.usedPercent") return "gauge";
  if (option.metric === "cpu.loadAverage") return "bullet";
  return "line";
}

/**
 * Pick a useful default for a new widget.
 *
 * On a populated tab, stay with the last widget's source and prefer a metric the tab does not
 * already show. That makes an Immich tab keep adding Immich widgets instead of silently
 * falling back to the local host.
 */
function preferredOption(tab: Tab): MetricOption | undefined {
  const options = availableMetrics(state.readings);
  if (options.length === 0) return undefined;

  const last = tab.widgets[tab.widgets.length - 1];
  if (!last) return options[0];

  const sameSource = options.filter((option) => option.sourceId === last.sourceId);
  if (sameSource.length === 0) return options[0];

  const used = new Set(
    tab.widgets
      .filter((widget) => widget.sourceId === last.sourceId)
      .flatMap((widget) => widget.metrics),
  );
  return sameSource.find((option) => !used.has(option.metric)) ?? sameSource[0];
}

function addWidgetToCurrentTab(): void {
  const tab = currentTab();
  const option = preferredOption(tab);
  if (!option) return;
  applyLayout(addWidget(state.layout, tab.id, buildDefaultWidget(option, suggestedType(option))), {
    save: true,
  });
}

// ---------------------------------------------------------------- tabs

function renderTabs(): void {
  if (!dom.tabs) return;

  const buttons = state.layout.tabs.map((tab) => {
    const button = h("button", "tab");
    button.type = "button";
    button.textContent = tab.name;
    button.setAttribute("aria-selected", String(tab.id === state.layout.activeTabId));
    button.classList.toggle("tab--active", tab.id === state.layout.activeTabId);
    button.addEventListener("click", () => {
      applyLayout(setActiveTab(state.layout, tab.id), { save: true });
    });

    const remove = h("button", "tab__remove", "×");
    remove.type = "button";
    remove.title = `Delete ${tab.name}`;
    remove.setAttribute("aria-label", `Delete tab ${tab.name}`);
    // The last tab cannot be deleted, so the control is disabled rather than hidden.
    remove.disabled = state.layout.tabs.length <= 1;
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      applyLayout(removeTab(state.layout, tab.id), { save: true });
    });

    button.append(remove);
    return button;
  });

  const add = h("button", "tab tab--add", "+ New tab");
  add.type = "button";
  add.addEventListener("click", () => {
    const name = window.prompt("Name for the new tab", `Tab ${state.layout.tabs.length + 1}`);
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    applyLayout(addTab(state.layout, trimmed), { save: true });
  });

  const rename = h("button", "tab tab--rename", "Rename");
  rename.type = "button";
  rename.addEventListener("click", () => {
    const tab = currentTab();
    const name = window.prompt("Tab name", tab.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    applyLayout(renameTab(state.layout, tab.id, trimmed), { save: true });
  });

  // The empty state has its own call to action. Once a tab is populated, this is the only
  // way back to adding another widget.
  const addWidgetAction =
    currentTab().widgets.length > 0 ? h("button", "tab tab--add-widget", "+ Add widget") : null;
  if (addWidgetAction) {
    addWidgetAction.type = "button";
    addWidgetAction.addEventListener("click", addWidgetToCurrentTab);
  }

  dom.tabs.replaceChildren(rename, ...(addWidgetAction ? [addWidgetAction] : []), ...buttons, add);
}

// ---------------------------------------------------------------- widgets

function widgetControls(widget: WidgetConfig, tabId: string): HTMLElement {
  const controls = h("div", "widget__controls");

  const type = h("select", "control");
  type.title = "Chart type";
  type.setAttribute("aria-label", `Chart type for ${widget.title}`);
  for (const option of WIDGET_TYPES) {
    const element$ = h("option", undefined, option);
    element$.value = option;
    if (option === widget.type) element$.selected = true;
    type.append(element$);
  }
  type.addEventListener("change", () => {
    applyLayout(setWidgetType(state.layout, tabId, widget.id, type.value as WidgetType), {
      save: true,
    });
  });

  const width = h("select", "control");
  width.title = "Width in columns";
  width.setAttribute("aria-label", `Width for ${widget.title}`);
  for (const span of GRID_SPANS) {
    const element$ = h("option", undefined, `${span}`);
    element$.value = String(span);
    if (span === widget.span) element$.selected = true;
    width.append(element$);
  }
  width.addEventListener("change", () => {
    const span = Number(width.value);
    if (!GRID_SPANS.includes(span as (typeof GRID_SPANS)[number])) return;
    applyLayout(setWidgetSpan(state.layout, tabId, widget.id, span as 1), { save: true });
  });

  const options = availableMetrics(state.readings);
  const seriesOptions = options.filter((option) => option.kind === "series");
  const tableOptions = options.filter((option) => option.kind === "table");

  let source: HTMLSelectElement | null = null;
  if (widget.type !== "table") {
    source = h("select", "control");
    source.title = "Source";
    source.setAttribute("aria-label", `Source for ${widget.title}`);

    const sources = (state.readings?.sources ?? []).filter((info) =>
      seriesOptions.some((option) => option.sourceId === info.id),
    );
    if (!sources.some((info) => info.id === widget.sourceId)) {
      sources.push({
        id: widget.sourceId,
        label: widget.sourceId,
        kind: "unknown",
        status: "unavailable",
        lastSampleAt: null,
      });
    }

    for (const info of sources) {
      const element$ = h("option", undefined, info.label);
      element$.value = info.id;
      if (info.id === widget.sourceId) element$.selected = true;
      source.append(element$);
    }
    source.addEventListener("change", () => {
      const selected = source?.value ?? "";
      const first = seriesOptions.find((option) => option.sourceId === selected);
      if (!first) return;
      applyLayout(
        setWidgetMetric(state.layout, tabId, widget.id, first.sourceId, first.metric, {
          unit: first.unit,
          min: first.min,
          max: first.max,
        }),
        { save: true },
      );
    });
  }

  const metric = h("select", "control control--wide");
  metric.title = "Metric";
  metric.setAttribute("aria-label", `Metric for ${widget.title}`);

  const metricOptions =
    widget.type === "table"
      ? tableOptions
      : seriesOptions.filter((option) => option.sourceId === widget.sourceId);
  const currentMetric = widget.metrics[0];
  for (const option of metricOptions) {
    const label = widget.type === "table" ? option.metric : `${option.label} (${option.metric})`;
    const element$ = h("option", undefined, label);
    element$.value = option.metric;
    // A single-select cannot show two selected options. Selecting only the primary keeps a
    // comparison widget from appearing to be based on its second metric.
    if (option.metric === currentMetric) element$.selected = true;
    metric.append(element$);
  }

  if (currentMetric && !metricOptions.some((option) => option.metric === currentMetric)) {
    // Keep a stale or unavailable selection visible instead of rendering an empty control.
    const element$ = h("option", undefined, currentMetric);
    element$.value = currentMetric;
    element$.selected = true;
    metric.append(element$);
  }

  metric.addEventListener("change", () => {
    const pool = widget.type === "table" ? tableOptions : seriesOptions;
    const selected = pool.find(
      (option) =>
        option.metric === metric.value &&
        (widget.type === "table" || option.sourceId === widget.sourceId),
    );
    if (!selected) return;
    applyLayout(
      setWidgetMetric(state.layout, tabId, widget.id, selected.sourceId, selected.metric, {
        unit: selected.unit,
        min: selected.min,
        max: selected.max,
      }),
      { save: true },
    );
  });

  const elements: HTMLElement[] = [type, width];
  if (source) elements.push(source);
  elements.push(metric);

  // Gauge, bullet, and table render only the first metric, so a comparison would be stored
  // but never shown. The selector is limited to the forms that actually plot both series.
  if (widget.type === "line" || widget.type === "bar") {
    const primaryOption = currentMetric
      ? metricOptions.find((option) => option.metric === currentMetric)
      : undefined;
    const primaryUnit = primaryOption?.unit ?? widget.unit ?? "";
    const comparisons = currentMetric
      ? metricOptions.filter(
          (option) => option.metric !== currentMetric && option.unit === primaryUnit,
        )
      : [];

    const compare = h("select", "control control--compare");
    compare.title = "Compare with another metric";
    compare.setAttribute("aria-label", `Compare ${widget.title} with another metric`);

    const none = h("option", undefined, "Compare: none");
    none.value = "";
    compare.append(none);

    for (const option of comparisons) {
      const element$ = h("option", undefined, `Compare: ${option.label} (${option.metric})`);
      element$.value = option.metric;
      if (widget.metrics[1] === option.metric) element$.selected = true;
      compare.append(element$);
    }

    const currentComparison = widget.metrics[1];
    if (currentComparison && !comparisons.some((option) => option.metric === currentComparison)) {
      // An existing comparison with a stale unit stays visible so the user can remove it
      // rather than losing it silently.
      const element$ = h("option", undefined, `Compare: ${currentComparison}`);
      element$.value = currentComparison;
      element$.selected = true;
      compare.append(element$);
    }

    compare.disabled = !currentMetric || (comparisons.length === 0 && !currentComparison);
    if (compare.disabled) {
      compare.title = "No other metric with the same unit on this source";
    }

    compare.addEventListener("change", () => {
      if (!currentMetric) return;
      const metrics = compare.value ? [currentMetric, compare.value] : [currentMetric];
      applyLayout(setWidgetMetrics(state.layout, tabId, widget.id, metrics), { save: true });
    });

    elements.push(compare);
  }

  const move = (direction: -1 | 1, label: string): HTMLButtonElement => {
    const button = h("button", "control control--button", label);
    button.type = "button";
    button.addEventListener("click", () => {
      applyLayout(moveWidget(state.layout, tabId, widget.id, direction), { save: true });
    });
    return button;
  };

  const remove = h("button", "control control--button control--danger", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    applyLayout(removeWidget(state.layout, tabId, widget.id), { save: true });
  });

  elements.push(move(-1, "←"), move(1, "→"), remove);
  controls.append(...elements);
  return controls;
}

/** Restore focus to a renamed widget's control after the grid is rebuilt. */
function focusWidgetRename(widgetId: string): void {
  const root = Array.from(document.querySelectorAll<HTMLElement>("[data-widget-id]")).find(
    (candidate) => candidate.dataset.widgetId === widgetId,
  );
  root?.querySelector<HTMLButtonElement>(".widget__rename")?.focus();
}

/**
 * Replace a title with a plain-text input.
 *
 * A real input is used instead of `contenteditable`: it gives predictable keyboard, selection,
 * and IME behaviour, and it cannot introduce markup into a title that is only ever text.
 */
function beginTitleEdit(
  widget: WidgetConfig,
  tabId: string,
  title: HTMLHeadingElement,
  button: HTMLButtonElement,
): void {
  const input = h("input", "widget__title-input");
  input.type = "text";
  input.value = widget.title;
  input.maxLength = LAYOUT_LIMITS.titleMaxLength;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Widget title");

  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;

    const next = input.value.trim().slice(0, LAYOUT_LIMITS.titleMaxLength);
    if (save && next.length > 0 && next !== widget.title) {
      applyLayout(setWidgetTitle(state.layout, tabId, widget.id, next), { save: true });
      focusWidgetRename(widget.id);
      return;
    }

    input.replaceWith(title);
    button.hidden = false;
    button.focus();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  title.replaceWith(input);
  button.hidden = true;
  input.focus();
  input.select();
}

function renderWidget(widget: WidgetConfig, tabId: string): HTMLElement {
  const root = h("section", "widget");
  root.style.setProperty("--span", String(widget.span));
  root.dataset.widgetId = widget.id;

  const header = h("header", "widget__header");
  const heading = h("div", "widget__heading");
  const title = h("h2", "widget__title", widget.title);
  const rename = h("button", "widget__rename", "✎");
  rename.type = "button";
  rename.title = "Rename widget";
  rename.setAttribute("aria-label", `Rename ${widget.title}`);
  rename.addEventListener("click", () => beginTitleEdit(widget, tabId, title, rename));
  heading.append(title, rename);

  const value = h("span", "widget__value");
  header.append(heading, value);

  const chart = h("div", "widget__chart");
  const controls = widgetControls(widget, tabId);
  root.append(header, chart, controls);

  // A visually hidden summary keeps the information available without the chart.
  const summary = h("p", "visually-hidden");
  root.append(summary);

  // The chart is rendered in CSS pixels, so a width change needs a redraw rather than a
  // stretched SVG. The observer covers window resizes and grid-span changes alike.
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      const view = state.views.get(widget.id);
      if (!view) return;
      view.signature = null;
      renderWidgetData();
    });
    observer.observe(chart);
  }

  state.views.set(widget.id, { root, chart, value, summary, signature: null, observer });
  return root;
}

function renderGrid(): void {
  clearWidgetViews();
  if (!dom.grid) return;

  const tab = currentTab();
  if (tab.widgets.length === 0) {
    const empty = h("div", "empty");
    empty.append(h("p", undefined, "This tab has no widgets yet."));
    const add = h("button", "button", "Add a widget");
    add.type = "button";
    add.addEventListener("click", addWidgetToCurrentTab);
    empty.append(add);
    dom.grid.replaceChildren(empty);
    return;
  }

  dom.grid.replaceChildren(...tab.widgets.map((widget) => renderWidget(widget, tab.id)));
}

function renderWidgetData(): void {
  const readings = state.readings;
  const tab = currentTab();

  for (const widget of tab.widgets) {
    const view = state.views.get(widget.id);
    if (!view) continue;

    if (!readings) {
      view.value.textContent = "—";
      view.chart.replaceChildren(h("p", "widget__message", "Waiting for data…"));
      continue;
    }

    const resolved = resolveWidget(widget, readings);

    if (resolved.missing.length > 0) {
      view.value.textContent = "—";
      view.chart.replaceChildren(
        h(
          "p",
          "widget__message widget__message--warn",
          `Metric not available: ${resolved.missing.join(", ")}`,
        ),
      );
      view.summary.textContent = buildSummary(resolved);
      view.signature = null;
      continue;
    }

    const values = resolved.series.map((series) => {
      for (let index = series.samples.length - 1; index >= 0; index -= 1) {
        const value = series.samples[index]?.v;
        if (value !== null && value !== undefined) return value;
      }
      return null;
    });

    const status = resolved.series[0]?.status ?? "unavailable";
    const signature =
      widget.type === "table"
        ? `table|${JSON.stringify(resolved.table?.columns ?? [])}|${JSON.stringify(
            resolved.table?.rows ?? [],
          )}`
        : dataSignature(values, status);

    // Skip the redraw when nothing changed, which is most ticks for most widgets. This must
    // not skip the rest of the grid: one unchanged widget says nothing about its neighbours.
    if (view.signature === signature) continue;
    view.signature = signature;

    view.value.textContent = describeWidgetValue({
      widget,
      values,
      series: resolved.series,
      table: resolved.table,
    });

    view.chart.replaceChildren(renderChart(resolved, { width: view.chart.clientWidth }));
    view.summary.textContent = buildSummary(resolved);
  }
}

// ---------------------------------------------------------------- polling

async function poll(): Promise<void> {
  // One request at a time. A tick while a request is outstanding is skipped, never queued.
  if (state.inFlight) return;
  // A dashboard nobody is looking at does not need to redraw 2,000 times an hour.
  if (document.hidden) return;

  state.inFlight = true;
  try {
    state.readings = indexReadings(await fetchReadings());
    state.connected = true;

    // The metric selectors are built from the snapshot, which does not exist on first paint.
    // Without this they stay empty until some unrelated action rebuilds the grid, which reads
    // as a broken control rather than a timing artefact. A peer added or removed at runtime
    // changes the source list, so the controls are rebuilt then too.
    const sourceKey = state.readings.sources
      .map((source) => `${source.id}:${source.label}`)
      .sort()
      .join("|");
    if (!state.controlsBuiltFromData || sourceKey !== state.sourceKey) {
      state.controlsBuiltFromData = true;
      state.sourceKey = sourceKey;
      renderGrid();
    }

    renderHeader();
    renderWidgetData();
  } catch (error) {
    if (!state.connected) return;
    state.connected = false;
    renderHeader();
    console.error("[dashboard] could not fetch readings", error);
  } finally {
    state.inFlight = false;
  }
}

function schedulePolling(intervalMs: number): void {
  if (state.pollTimer !== null) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    void poll();
  }, intervalMs);
}

/**
 * The update notice is fetched once per page load. The server caches the GitHub answer, so
 * this is never a per-render or per-poll network call.
 */
async function renderUpdateNotice(): Promise<void> {
  if (!dom.updateBanner) return;

  try {
    const update = await fetchUpdateStatus();
    mountUpdateBanner({
      container: dom.updateBanner,
      update,
      dismissedVersion: readDismissedVersion(),
      onDismiss: () => dom.mode?.focus(),
    });
  } catch (error) {
    console.warn("[dashboard] could not read the update status", error);
  }
}

// ---------------------------------------------------------------- start

async function start(): Promise<void> {
  dom.app = document.querySelector(".app");
  dom.mode = document.querySelector("#mode-toggle");
  dom.tabs = document.querySelector("#tabs");
  dom.grid = document.querySelector("#grid");
  dom.status = document.querySelector("#status");
  dom.save = document.querySelector("#save-state");
  dom.updateBanner = document.querySelector("#update-banner");

  // Apply the stored mode before the first layout render, so view mode does not flash controls.
  state.mode = readMode();
  if (dom.app && dom.mode) {
    applyMode(dom.app, dom.mode, state.mode);
    dom.mode.addEventListener("click", () => setMode(nextMode(state.mode)));
  }

  try {
    state.config = await fetchConfig();
  } catch {
    // The dashboard can still render a saved layout without the config; only the polling
    // cadence falls back to a sensible default.
    console.warn("[dashboard] could not read the configuration");
  }

  let version: string | null = null;
  try {
    version = await fetchVersion();
  } catch {
    console.warn("[dashboard] could not read the application version");
  }

  // Peer management is a main-node surface. A peer never serves this page, but hiding the
  // control on a non-main configuration keeps the role boundary visible in the client too.
  const nodesButton = document.querySelector<HTMLButtonElement>("#nodes-button");
  if (nodesButton) {
    if (state.config?.role === "main") {
      nodesButton.hidden = false;
      mountNodesControl({
        button: nodesButton,
        version,
        onPeersChanged: () => {
          // The next poll sees the new source list and rebuilds the widget controls. Asking
          // for one now shortens the wait without coupling this module to the poll loop.
          void poll();
        },
      });
    } else {
      nodesButton.hidden = true;
    }
  }

  try {
    state.layout = await fetchLayout();
  } catch (error) {
    console.warn("[dashboard] could not read the saved layout, using an empty one", error);
    state.layout = emptyLayout();
  }

  renderSaveState();
  renderTabs();
  renderGrid();
  void renderUpdateNotice();

  // Refetch immediately on becoming visible, so the view is never stale on return.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll();
  });

  await poll();
  schedulePolling(state.config?.metricsIntervalMs ?? 500);
}

void start().catch((error: unknown) => {
  console.error("[dashboard] failed to start", error);
  const grid = document.querySelector("#grid");
  if (grid) {
    grid.replaceChildren(
      h("div", "empty", "The dashboard could not start. Check that the server is running."),
    );
  }
});

// Re-exported so the humanised column helper is reachable from the bundle's public surface
// for reuse by the table renderer without a circular import.
export { humaniseColumn, buildDefaultWidget };
