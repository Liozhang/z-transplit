/**
 * registerWordCardsUI — entry buttons for the Word Cards tab.
 *
 * Two buttons, one destination (wordCardsTab#openWordCardsTab):
 *
 *   - A library toolbar button (XUL toolbarbutton) injected into the main
 *     window per window, following registerItemTreeMenu's tracked-window
 *     pattern: idempotent by element id, tracked in a module array, revoked
 *     per window on window unload and wholly on plugin shutdown.
 *   - A reader toolbar button via Zotero.Reader#registerEventListener
 *     ("renderToolbar"), following splitViewFactory's module-scope handler
 *     pattern (unregister needs the same function reference).
 *
 * The library toolbar's anchor id is not part of any public Zotero API, so
 * the anchor is resolved through a candidate chain and a miss degrades to a
 * debug log — the reader button still reaches the tab, and nothing else in
 * the addon depends on the library button.
 *
 * Both buttons lazy-import the tab module on first click, keeping the tab
 * UI (and its stylesheet string) off the startup path.
 */

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { safeDebug } from "../utils/logger";

/** Element id of the injected library toolbar button (idempotency key). */
const BUTTON_ID = "ztransplit-wordcards-button";

/**
 * Library toolbar anchor candidates, in order of preference. None of these
 * ids are contract — they are Zotero-internal element ids, verified against
 * the running main window during QA.
 */
const TOOLBAR_ANCHOR_IDS = [
  "zotero-items-toolbar",
  "zotero-toolbar",
  "zotero-collections-toolbar",
];

interface TrackedWindow {
  win: any;
  button: any;
}

const tracked: TrackedWindow[] = [];

/** Reader-toolbar event handler; module scope because unregister is by reference. */
let readerToolbarHandler: ((event: any) => void) | null = null;

/**
 * This addon's ID (package.json config), with a runtime fallback to
 * `addon.data.config.addonID` — same resolution order as
 * src/modules/registerTranslateUI.ts#addonID.
 */
function addonID(): string {
  try {
    const fromData = (globalThis as any)?.addon?.data?.config?.addonID;
    if (fromData) return fromData;
  } catch {
    /* no addon global (node) — fall through to the config import */
  }
  return config.addonID;
}

/** Register the reader listener + buttons for every known main window. */
export function registerWordCardsUI(): void {
  registerReaderToolbarButton();
  for (const win of (globalThis as any)?.Zotero?.getMainWindows?.() ?? []) {
    registerWordCardsUIForWindow(win);
  }
}

/**
 * Inject the library toolbar button into one main window. Idempotent per
 * window (and safe when no toolbar anchor exists — the button is skipped
 * with a log rather than breaking startup).
 */
export function registerWordCardsUIForWindow(win: any): void {
  try {
    const doc: Document | undefined = win?.document;
    if (!doc) return;
    if (doc.getElementById(BUTTON_ID)) return;

    const toolbar = resolveToolbar(doc);
    if (!toolbar) {
      safeDebug(
        "[Z-Transplit] wordCards: no library toolbar anchor found — library button skipped",
      );
      return;
    }

    const button = doc.createXULElement("toolbarbutton");
    button.id = BUTTON_ID;
    button.className = "zotero-tb-button";
    button.setAttribute("tooltiptext", getString("wordcards-toolbar-tooltip"));
    // currentColor stroke icons pick the toolbar's colour up via the image's
    // own color inheritance — the same rule as every other chrome:// icon in
    // this addon (see the QA note in addon/content/icons/).
    button.setAttribute(
      "style",
      "list-style-image: url(chrome://ztransplit/content/icons/wordcards-16.svg);",
    );
    button.addEventListener("command", () => {
      void import("../ui/wordCardsTab").then((mod) =>
        mod.openWordCardsTab(win),
      );
    });
    toolbar.appendChild(button);
    tracked.push({ win, button });
    safeDebug("[Z-Transplit] wordCards: library toolbar button injected");
  } catch (e) {
    safeDebug("[Z-Transplit] wordCards: library button injection failed: " + e);
  }
}

/** Revoke one window's button (window unload). */
export function unregisterWordCardsUIForWindow(win: any): void {
  for (let i = tracked.length - 1; i >= 0; i--) {
    if (tracked[i].win !== win) continue;
    try {
      tracked[i].button.remove();
    } catch {
      /* best-effort */
    }
    tracked.splice(i, 1);
  }
}

/** Revoke everything: reader listener, all buttons, and an open tab. */
export function unregisterWordCardsUI(): void {
  const Reader = (globalThis as any)?.Zotero?.Reader;
  if (readerToolbarHandler && typeof Reader?.unregisterEventListener === "function") {
    try {
      Reader.unregisterEventListener("renderToolbar", readerToolbarHandler);
    } catch (e) {
      safeDebug("[Z-Transplit] wordCards: reader listener revoke failed: " + e);
    }
  }
  readerToolbarHandler = null;
  for (const { button } of tracked.splice(0)) {
    try {
      button.remove();
    } catch {
      /* best-effort */
    }
  }
  // Closing the tab fires its onClose, which tears the DOM down.
  void import("../ui/wordCardsTab").then((mod) => mod.closeWordCardsTab());
}

function resolveToolbar(doc: Document): Element | null {
  for (const id of TOOLBAR_ANCHOR_IDS) {
    try {
      const anchor = doc.getElementById(id);
      if (anchor) return anchor;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader toolbar button
// ─────────────────────────────────────────────────────────────────────────────

const READER_STYLE_ID = "ztransplit-wordcards-reader-style";
const READER_BUTTON_CLASS = "ztransplit-wc-reader-btn";

const READER_BUTTON_CSS = `
.${READER_BUTTON_CLASS} {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px;
  border: none; border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.${READER_BUTTON_CLASS}:hover { background: rgba(127,127,127,0.2); }
.${READER_BUTTON_CLASS}:focus-visible {
  outline: 2px solid var(--color-focus-border, #4072e5); outline-offset: -2px;
}
.${READER_BUTTON_CLASS} svg { width: 20px; height: 20px; display: block; }
`;

function registerReaderToolbarButton(): void {
  const Reader = (globalThis as any)?.Zotero?.Reader;
  if (!Reader || typeof Reader.registerEventListener !== "function") {
    safeDebug(
      "[Z-Transplit] wordCards: Zotero.Reader.registerEventListener unavailable — reader button skipped",
    );
    return;
  }
  readerToolbarHandler = (event: any) => {
    try {
      const { doc, append } = event;
      if (!doc || typeof append !== "function") return;
      append(buildReaderButton(doc));
    } catch (e) {
      safeDebug("[Z-Transplit] wordCards: reader button build failed: " + e);
    }
  };
  Reader.registerEventListener("renderToolbar", readerToolbarHandler, addonID());
}

/**
 * Build the reader toolbar button in the reader's own HTML document. The
 * geometry is the wordcards-20 icon inlined as markup — reader documents
 * render once per reader instance, and an inline SVG avoids a chrome fetch
 * per open while still colouring via currentColor.
 */
function buildReaderButton(doc: Document): HTMLElement {
  const head = doc.head ?? doc.documentElement;
  if (head && !doc.getElementById(READER_STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = READER_STYLE_ID;
    style.textContent = READER_BUTTON_CSS;
    head.appendChild(style);
  }

  const button = doc.createElement("div");
  button.className = READER_BUTTON_CLASS;
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute("title", getString("wordcards-toolbar-tooltip"));
  button.setAttribute("aria-label", getString("wordcards-toolbar-tooltip"));
  button.innerHTML = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">',
    '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
    '<rect x="3.8" y="2.9" width="12.5" height="14.2" rx="1.7"/>',
    '<path d="M7.7 12.1 L10 6.7 L12.3 12.1"/>',
    '<path d="M8.7 10.2 H11.3"/>',
    '<path d="M7.1 14.6 H12.9"/>',
    "</g></svg>",
  ].join("");

  const open = () => {
    void import("../ui/wordCardsTab").then((mod) =>
      mod.openWordCardsTab(
        (globalThis as any)?.Zotero?.getMainWindow?.() ??
          (doc.defaultView as any)?.Zotero?.getMainWindow?.(),
      ),
    );
  };
  button.addEventListener("click", open);
  button.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (e.isComposing) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return button;
}
