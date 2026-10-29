import type { UpdateResponse } from "../shared/api.ts";

/**
 * The update notice.
 *
 * It is a plain, non-blocking banner: no modal, no Docker socket, no automatic update. The
 * only actions are opening the release notes, copying the documented command, and dismissing
 * the notice for the offered version.
 */

export const UPDATE_DISMISS_KEY = "homelabmd.update.dismissed";
export const UPDATE_COMMAND = "docker compose pull && docker compose up -d";

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readDismissedVersion(
  storage: StorageLike | null = defaultStorage(),
): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(UPDATE_DISMISS_KEY);
  } catch {
    return null;
  }
}

export function storeDismissedVersion(
  version: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(UPDATE_DISMISS_KEY, version);
  } catch {
    // A browser with storage disabled still gets a usable session; the banner simply
    // reappears on the next load, which is better than breaking the dashboard.
  }
}

/** The banner is actionable only for a newer release the user has not dismissed. */
export function shouldShowUpdate(update: UpdateResponse, dismissedVersion: string | null): boolean {
  if (update.status !== "available") return false;
  if (update.latestVersion === null) return false;
  return update.latestVersion !== dismissedVersion;
}

export type UpdateBannerOptions = {
  container: HTMLElement;
  update: UpdateResponse;
  dismissedVersion: string | null;
  storage?: StorageLike | null;
  /** Called after dismissal so the caller can move focus somewhere visible. */
  onDismiss?: () => void;
};

export function mountUpdateBanner(options: UpdateBannerOptions): boolean {
  const { container, update } = options;
  if (!shouldShowUpdate(update, options.dismissedVersion)) {
    container.hidden = true;
    container.replaceChildren();
    return false;
  }

  const latest = update.latestVersion ?? "";

  const banner = document.createElement("section");
  banner.className = "update-banner";
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Update available");

  const body = document.createElement("div");
  body.className = "update-banner__body";

  const text = document.createElement("p");
  text.className = "update-banner__text";
  const strong = document.createElement("strong");
  strong.textContent = `RackDeck ${latest} is available.`;
  text.append(strong, document.createTextNode(` You are running ${update.currentVersion}.`));
  body.append(text);

  const actions = document.createElement("div");
  actions.className = "update-banner__actions";

  if (update.releaseUrl !== null) {
    const notes = document.createElement("a");
    notes.className = "button button--quiet";
    notes.href = update.releaseUrl;
    notes.target = "_blank";
    notes.rel = "noopener noreferrer";
    notes.textContent = "Release notes";
    actions.append(notes);
  }

  const how = document.createElement("details");
  how.className = "update-banner__how";
  const summary = document.createElement("summary");
  summary.textContent = "How to update";
  how.append(summary);

  const instruction = document.createElement("p");
  instruction.textContent = "Pull the pinned release and recreate the container:";
  const command = document.createElement("div");
  command.className = "update-banner__command";
  const code = document.createElement("code");
  code.textContent = UPDATE_COMMAND;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "button button--quiet";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", "Copy the update command");
  copy.addEventListener("click", () => {
    void copyCommand(UPDATE_COMMAND).then((copied) => {
      copy.textContent = copied ? "Copied" : "Copy failed";
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 2_000);
    });
  });
  command.append(code, copy);
  how.append(instruction, command);
  body.append(actions, how);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "update-banner__dismiss";
  dismiss.setAttribute("aria-label", `Dismiss the ${latest} update notice`);
  dismiss.title = "Dismiss";
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => {
    storeDismissedVersion(latest, options.storage ?? defaultStorage());
    container.hidden = true;
    container.replaceChildren();
    options.onDismiss?.();
  });

  banner.append(body, dismiss);
  container.replaceChildren(banner);
  container.hidden = false;
  return true;
}

export async function copyCommand(command: string): Promise<boolean> {
  try {
    if (navigator.clipboard === undefined) return false;
    await navigator.clipboard.writeText(command);
    return true;
  } catch {
    return false;
  }
}
