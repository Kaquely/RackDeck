import type { PeerInfoResponse } from "../shared/api.ts";
import { generatePeerToken, isPeerToken } from "../shared/peer-token.ts";
import { PeerUrlShapeError, parsePeerUrlShape } from "../shared/peer-url.ts";
import { addPeer, fetchPeers, removePeer, verifyPeer } from "./api.ts";
import type { PeerSummary } from "./api.ts";

/**
 * The Nodes dialog and add-peer wizard.
 *
 * The dialog is created once and mounted into the document. The token lives only in this
 * module's state while the dialog is open; closing the dialog clears it and replaces the
 * dialog body, so it cannot be read from the DOM afterwards. Nothing here touches
 * `localStorage`, `sessionStorage`, the URL or `console`.
 */

const DEPLOYMENT_GUIDE_URL = "https://github.com/Kaquely/RackDeck/blob/main/INSTALL.md";
const PEER_REPOSITORY = "ghcr.io/kaquely/rackdeck";
const STEP_TITLES = ["Prepare the peer", "Address", "Verify", "Confirm"] as const;

type Step = 1 | 2 | 3 | 4;

type WizardState = {
  step: Step;
  token: string;
  label: string;
  url: string;
  verified: PeerInfoResponse | null;
  /** True once a verification attempt has run, so a failure does not retry forever. */
  attempted: boolean;
  busy: boolean;
};

type MessageTone = "info" | "ok" | "error";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrapper = element("div", "field");
  const label = element("label", "field__label", labelText);
  const id = `nodes-field-${Math.random().toString(36).slice(2, 10)}`;
  control.id = id;
  label.htmlFor = id;
  wrapper.append(label, control);
  if (hint !== undefined) {
    const hintElement = element("p", "field__hint", hint);
    hintElement.id = `${id}-hint`;
    control.setAttribute("aria-describedby", hintElement.id);
    wrapper.append(hintElement);
  }
  return wrapper;
}

function buildCompose(token: string, version: string | null): string {
  const image = `${PEER_REPOSITORY}:${version ?? "<version>"}`;
  const versionHint =
    version === null ? "    # Replace <version> with the version shown in this dashboard.\n" : "";
  return `services:
  homelabmd-peer:
${versionHint}    image: ${image}
    container_name: homelabmd-peer
    restart: unless-stopped
    environment:
      HOMELABMD_ROLE: peer
      HOMELABMD_PEER_TOKEN: ${token}
      # Optional: only accept reads from the main node's address.
      # HOMELABMD_PEER_ALLOWED_IPS: 192.168.0.10
    ports:
      - "3000:3000"
`;
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // The clipboard API is unavailable on some LAN HTTP origins. Fall through to the
    // selection-based copy rather than leaving the operator with no way to copy a secret.
  }

  const area = element("textarea", "visually-hidden");
  area.value = value;
  area.setAttribute("readonly", "");
  document.body.append(area);
  area.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function mountNodesControl(options: {
  button: HTMLButtonElement;
  /** Version of the running main node, or null when it could not be read. */
  version: string | null;
  /** Called after a peer is added or removed so the dashboard can refresh its sources. */
  onPeersChanged: () => void;
}): void {
  const dialog = element("dialog", "dialog");
  dialog.id = "nodes-dialog";
  dialog.setAttribute("aria-labelledby", "nodes-title");

  const panel = element("div", "dialog__panel");

  const header = element("header", "dialog__header");
  const title = element("h2", "dialog__title", "Nodes");
  title.id = "nodes-title";
  const closeButton = element("button", "button button--quiet", "Close");
  closeButton.type = "button";
  closeButton.addEventListener("click", () => dialog.close());
  header.append(title, closeButton);

  const live = element("p", "form__message");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  live.hidden = true;

  const body = element("div", "dialog__body");
  panel.append(header, live, body);
  dialog.append(panel);
  document.body.append(dialog);

  let wizard: WizardState | null = null;

  function setMessage(text: string, tone: MessageTone = "info"): void {
    live.textContent = text;
    live.className = `form__message form__message--${tone}`;
    live.hidden = text.length === 0;
  }

  function clearSecrets(): void {
    if (wizard !== null) {
      wizard.token = "";
      wizard.verified = null;
    }
    wizard = null;
    // `replaceChildren` drops the input values and the snippet text in one step. The body is
    // rebuilt on the next open, so no stale copy of the token remains in the document.
    body.replaceChildren();
    live.textContent = "";
    live.hidden = true;
  }

  dialog.addEventListener("close", clearSecrets);

  async function showList(): Promise<void> {
    wizard = null;
    const lead = element(
      "p",
      "dialog__lead",
      "Peers are other RackDeck nodes. This node reads their metrics; they never write to each other.",
    );

    const actions = element("div", "dialog__actions");
    const addButton = element("button", "button", "Add peer");
    addButton.type = "button";
    addButton.addEventListener("click", () => {
      wizard = {
        step: 1,
        token: generatePeerToken(),
        label: "",
        url: "",
        verified: null,
        attempted: false,
        busy: false,
      };
      setMessage("");
      renderWizard();
    });
    actions.append(addButton);

    const list = element("ul", "nodes-list");
    list.setAttribute("aria-label", "Configured peers");
    list.append(element("li", "nodes-list__loading", "Loading peers…"));

    body.replaceChildren(lead, actions, list);

    try {
      const peers = await fetchPeers();
      if (!dialog.open) return;
      renderList(peers, list);
    } catch (error) {
      if (!dialog.open) return;
      list.replaceChildren();
      const failure = element("li", "form__message form__message--error");
      failure.textContent = `Error: ${
        error instanceof Error ? error.message : "could not read the peer list"
      }`;
      list.append(failure);

      const retry = element("button", "button button--quiet", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => {
        void showList();
      });
      list.append(retry);
    }
  }

  function renderList(peers: PeerSummary[], list: HTMLElement): void {
    if (peers.length === 0) {
      list.replaceChildren(
        element(
          "li",
          "nodes-list__empty",
          "No peers yet. Add one when the second node is running with its token.",
        ),
      );
      return;
    }

    list.replaceChildren(
      ...peers.map((peer) => {
        const item = element("li", "node");

        const main = element("div", "node__main");
        const label = element("strong", "node__label", peer.label);
        const url = element("code", "node__url", peer.url);
        main.append(label, url);

        const badges = element("div", "node__badges");
        badges.append(
          element("span", "badge", peer.managed ? "Stored on this node" : "From the environment"),
          element("span", "badge", peer.hasToken ? "Token set" : "No token"),
        );

        const controls = element("div", "node__controls");
        if (peer.managed) {
          const remove = element("button", "button button--quiet button--danger", "Remove");
          remove.type = "button";
          remove.setAttribute("aria-label", `Remove ${peer.label}`);
          remove.addEventListener("click", () => {
            void removeOne(peer);
          });
          controls.append(remove);
        }

        item.append(main, badges, controls);
        return item;
      }),
    );
  }

  async function removeOne(peer: PeerSummary): Promise<void> {
    const confirmed = window.confirm(
      `Remove ${peer.label}? Its source and history disappear from this dashboard. The peer's own container is not changed.`,
    );
    if (!confirmed) return;

    try {
      await removePeer(peer.id);
      if (!dialog.open) return;
      await showList();
      setMessage(`Done: removed ${peer.label}.`, "ok");
      options.onPeersChanged();
    } catch (error) {
      setMessage(
        `Error: ${error instanceof Error ? error.message : "the peer could not be removed"}`,
        "error",
      );
    }
  }

  function renderWizard(): void {
    if (wizard === null) return;

    const stepLabel = element(
      "p",
      "wizard__step",
      `Step ${wizard.step} of 4 · ${STEP_TITLES[wizard.step - 1]}`,
    );
    const content = element("div", "wizard");
    content.append(stepLabel);

    switch (wizard.step) {
      case 1:
        renderPrepare(content);
        break;
      case 2:
        renderAddress(content);
        break;
      case 3:
        renderVerify(content);
        break;
      case 4:
        renderConfirm(content);
        break;
    }

    body.replaceChildren(content);

    const autofocus = content.querySelector<HTMLElement>("[data-autofocus]");
    autofocus?.focus();
  }

  function backToList(): void {
    wizard = null;
    setMessage("");
    void showList();
  }

  function renderPrepare(container: HTMLElement): void {
    if (wizard === null) return;

    const tokenInput = element("input", "input");
    tokenInput.type = "text";
    tokenInput.value = wizard.token;
    tokenInput.autocomplete = "off";
    tokenInput.spellcheck = false;
    tokenInput.setAttribute("autocapitalize", "off");
    tokenInput.dataset.autofocus = "true";

    const snippet = element("pre", "snippet");
    const code = element("code");
    snippet.append(code);

    const updateSnippet = (): void => {
      code.textContent = buildCompose(tokenInput.value.trim(), options.version);
    };
    updateSnippet();

    tokenInput.addEventListener("input", () => {
      if (wizard === null) return;
      wizard.token = tokenInput.value.trim();
      updateSnippet();
    });

    const tokenActions = element("div", "dialog__actions dialog__actions--start");
    const generate = element("button", "button button--quiet", "Generate a new token");
    generate.type = "button";
    generate.addEventListener("click", () => {
      if (wizard === null) return;
      wizard.token = generatePeerToken();
      tokenInput.value = wizard.token;
      updateSnippet();
      setMessage("A new token was generated. Copy it before continuing.", "info");
    });

    const copyToken = element("button", "button button--quiet", "Copy token");
    copyToken.type = "button";
    copyToken.addEventListener("click", () => {
      void copyText(tokenInput.value.trim()).then((copied) => {
        setMessage(
          copied
            ? "Token copied."
            : "Error: copying failed; select the token and copy it manually.",
          copied ? "ok" : "error",
        );
      });
    });
    tokenActions.append(generate, copyToken);

    const snippetActions = element("div", "dialog__actions dialog__actions--start");
    const copySnippet = element("button", "button button--quiet", "Copy compose file");
    copySnippet.type = "button";
    copySnippet.addEventListener("click", () => {
      void copyText(code.textContent ?? "").then((copied) => {
        setMessage(
          copied
            ? "Compose file copied."
            : "Error: copying failed; select the snippet and copy it manually.",
          copied ? "ok" : "error",
        );
      });
    });

    const download = element("button", "button button--quiet", "Download compose file");
    download.type = "button";
    download.addEventListener("click", () => {
      const blob = new Blob([code.textContent ?? ""], { type: "application/yaml" });
      const url = URL.createObjectURL(blob);
      const anchor = element("a");
      anchor.href = url;
      anchor.download = "homelabmd-peer-compose.yml";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // The token is in the blob, so release the object URL as soon as the browser has it.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage("Compose file downloaded. The token is in that file; keep it private.", "ok");
    });

    const guide = element("a", "link", "Deployment guide");
    guide.href = DEPLOYMENT_GUIDE_URL;
    guide.target = "_blank";
    guide.rel = "noopener noreferrer";
    snippetActions.append(copySnippet, download, guide);

    const form = element("form", "form");
    form.noValidate = true;
    form.append(
      field(
        "Peer token",
        tokenInput,
        "The peer requires this token. It is shown only while this dialog is open; the main also stores it in peers.json.",
      ),
      tokenActions,
      element(
        "p",
        "field__hint",
        "Paste this into the peer's compose file, or replace it with an existing token:",
      ),
      snippet,
      snippetActions,
    );

    const footer = element("div", "dialog__actions");
    const cancel = element("button", "button button--quiet", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", backToList);
    const next = element("button", "button", "Continue");
    next.type = "submit";
    footer.append(cancel, next);
    form.append(footer);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (wizard === null) return;
      wizard.token = tokenInput.value.trim();
      if (!isPeerToken(wizard.token)) {
        setMessage("Error: the token must be hlp_ followed by 43 base64url characters.", "error");
        tokenInput.focus();
        return;
      }
      wizard.step = 2;
      setMessage("");
      renderWizard();
    });

    container.append(form);
  }

  function renderAddress(container: HTMLElement): void {
    if (wizard === null) return;

    const labelInput = element("input", "input");
    labelInput.type = "text";
    labelInput.value = wizard.label;
    labelInput.maxLength = 64;
    labelInput.autocomplete = "off";

    const urlInput = element("input", "input");
    urlInput.type = "url";
    urlInput.value = wizard.url;
    urlInput.placeholder = "http://192.168.0.50:3000";
    urlInput.autocomplete = "off";
    urlInput.spellcheck = false;
    (wizard.label.length === 0 ? labelInput : urlInput).dataset.autofocus = "true";

    const form = element("form", "form");
    form.noValidate = true;
    form.append(
      field("Name", labelInput, "How this peer appears in the dashboard and in widget sources."),
      field(
        "Peer address",
        urlInput,
        "The peer's LAN or Tailscale address. Loopback, link-local and public addresses are rejected.",
      ),
    );

    const footer = element("div", "dialog__actions");
    const back = element("button", "button button--quiet", "Back");
    back.type = "button";
    back.addEventListener("click", () => {
      if (wizard === null) return;
      wizard.step = 1;
      setMessage("");
      renderWizard();
    });
    const verify = element("button", "button", "Verify peer");
    verify.type = "submit";
    footer.append(back, verify);
    form.append(footer);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (wizard === null) return;

      const label = labelInput.value.trim();
      if (label.length === 0 || label.length > 64) {
        setMessage("Error: the name must be between 1 and 64 characters.", "error");
        labelInput.focus();
        return;
      }

      let url: string;
      try {
        url = parsePeerUrlShape(urlInput.value.trim()).origin;
      } catch (error) {
        setMessage(
          `Error: ${
            error instanceof PeerUrlShapeError ? error.message : "the address is not valid"
          }`,
          "error",
        );
        urlInput.focus();
        return;
      }

      wizard.label = label;
      wizard.url = url;
      wizard.verified = null;
      wizard.attempted = false;
      wizard.step = 3;
      setMessage("");
      renderWizard();
      void runVerification();
    });

    container.append(form);
  }

  function renderVerify(container: HTMLElement): void {
    if (wizard === null) return;

    const summary = element(
      "p",
      "dialog__lead",
      `Contacting ${wizard.url} with the token. The peer must answer with its role and version.`,
    );
    const result = element("p", "verify-result");
    result.setAttribute("role", "status");
    result.setAttribute("aria-live", "polite");

    if (wizard.busy) {
      result.textContent = "Verifying…";
      result.tabIndex = -1;
      result.dataset.autofocus = "true";
    } else if (wizard.verified !== null) {
      result.textContent = `Verified: ${wizard.verified.id} · role ${wizard.verified.role} · version ${wizard.verified.version}`;
    } else if (wizard.attempted) {
      result.textContent = "Verification failed. Check the address and token, then try again.";
    } else {
      result.textContent = "Not verified yet.";
    }

    const footer = element("div", "dialog__actions");
    const back = element("button", "button button--quiet", "Back");
    back.type = "button";
    back.disabled = wizard.busy;
    back.addEventListener("click", () => {
      if (wizard === null) return;
      wizard.step = 2;
      wizard.verified = null;
      setMessage("");
      renderWizard();
    });

    const retry = element("button", "button button--quiet", "Check again");
    retry.type = "button";
    retry.disabled = wizard.busy;
    retry.dataset.autofocus = "true";
    retry.addEventListener("click", () => {
      if (wizard === null) return;
      wizard.verified = null;
      wizard.attempted = false;
      void runVerification();
    });

    const next = element("button", "button", "Continue");
    next.type = "button";
    next.disabled = wizard.verified === null || wizard.busy;
    next.addEventListener("click", () => {
      if (wizard === null || wizard.verified === null) return;
      wizard.step = 4;
      setMessage("");
      renderWizard();
    });
    if (wizard.verified !== null) {
      next.dataset.autofocus = "true";
      delete retry.dataset.autofocus;
    }

    footer.append(back, retry, next);
    container.append(summary, result, footer);
  }

  async function runVerification(): Promise<void> {
    if (wizard === null || wizard.busy) return;

    wizard.busy = true;
    wizard.attempted = true;
    setMessage("Verifying the peer…", "info");
    renderWizard();

    try {
      const verified = await verifyPeer({ url: wizard.url, token: wizard.token });
      if (wizard === null || !dialog.open) return;
      wizard.verified = verified;
      wizard.busy = false;
      setMessage(`Verified ${verified.id} (version ${verified.version}).`, "ok");
      renderWizard();
    } catch (error) {
      if (wizard === null || !dialog.open) return;
      wizard.verified = null;
      wizard.busy = false;
      setMessage(
        `Error: ${error instanceof Error ? error.message : "the peer could not be verified"}`,
        "error",
      );
      renderWizard();
    }
  }

  function renderConfirm(container: HTMLElement): void {
    if (wizard === null || wizard.verified === null) return;

    const list = element("dl", "summary-list");
    const rows: [string, string][] = [
      ["Name", wizard.label],
      ["Address", wizard.url],
      ["Peer id", wizard.verified.id],
      ["Version", wizard.verified.version],
    ];
    for (const [term, value] of rows) {
      list.append(element("dt", undefined, term), element("dd", undefined, value));
    }

    const note = element(
      "p",
      "dialog__lead",
      "Adding stores the token in peers.json on this node and registers the peer's source without a restart. The peer container is not changed.",
    );

    const footer = element("div", "dialog__actions");
    const back = element("button", "button button--quiet", "Back");
    back.type = "button";
    back.disabled = wizard.busy;
    back.addEventListener("click", () => {
      if (wizard === null) return;
      wizard.step = 2;
      setMessage("");
      renderWizard();
    });

    const confirm = element("button", "button", wizard.busy ? "Adding…" : "Add peer");
    confirm.type = "button";
    confirm.disabled = wizard.busy;
    confirm.dataset.autofocus = "true";
    confirm.addEventListener("click", () => {
      void addCurrentPeer();
    });
    footer.append(back, confirm);

    container.append(list, note, footer);
  }

  async function addCurrentPeer(): Promise<void> {
    if (wizard === null || wizard.busy) return;

    wizard.busy = true;
    setMessage("Adding the peer…", "info");
    renderWizard();

    try {
      const peer = await addPeer({
        label: wizard.label,
        url: wizard.url,
        token: wizard.token,
      });
      if (wizard === null || !dialog.open) return;
      // The token has served its purpose. Drop it before the list is rendered.
      wizard.token = "";
      wizard.verified = null;
      wizard.busy = false;
      await showList();
      setMessage(`Done: added ${peer.label}. Its source appears as soon as it reports.`, "ok");
      options.onPeersChanged();
    } catch (error) {
      if (wizard === null || !dialog.open) return;
      wizard.busy = false;
      setMessage(
        `Error: ${error instanceof Error ? error.message : "the peer could not be added"}`,
        "error",
      );
      renderWizard();
    }
  }

  options.button.addEventListener("click", () => {
    if (dialog.open) return;
    clearSecrets();
    setMessage("");
    dialog.showModal();
    closeButton.focus();
    void showList();
  });
}
