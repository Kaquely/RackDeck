/**
 * Display-mode preference for the dashboard.
 *
 * Edit mode exposes every layout control. View mode hides them so the dashboard can be read
 * without visual noise. The preference is local to the browser and never reaches the server.
 */

export type DisplayMode = "edit" | "view";

export const DISPLAY_MODE_KEY = "homelabmd.display-mode";

/** Visible label names the mode the button switches to. */
const LABELS: Record<DisplayMode, string> = {
  edit: "View",
  view: "Edit",
};

const ACTIONS: Record<DisplayMode, string> = {
  edit: "Switch to view mode",
  view: "Switch to edit mode",
};

export function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "edit" || value === "view";
}

export function nextMode(mode: DisplayMode): DisplayMode {
  return mode === "edit" ? "view" : "edit";
}

/**
 * Reading storage can throw (blocked cookies, private mode, a hostile policy). A presentation
 * preference is not worth failing startup for, so every failure resolves to edit mode.
 */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readMode(storage: Pick<Storage, "getItem"> | null = defaultStorage()): DisplayMode {
  try {
    const value = storage?.getItem(DISPLAY_MODE_KEY) ?? null;
    return isDisplayMode(value) ? value : "edit";
  } catch {
    return "edit";
  }
}

export function storeMode(
  mode: DisplayMode,
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(DISPLAY_MODE_KEY, mode);
  } catch {
    // The in-memory mode still works for this page; only persistence is lost.
  }
}

export function applyMode(app: HTMLElement, button: HTMLButtonElement, mode: DisplayMode): void {
  app.dataset.mode = mode;
  button.textContent = LABELS[mode];
  button.setAttribute("aria-label", ACTIONS[mode]);
  button.title = ACTIONS[mode];
}
