/**
 * translatePane — native-DOM port of leadero's React `TranslatePanel`.
 *
 * Behavioural contract (ported 1:1 from
 * leadero/src/react/components/Sidebar/TranslatePanel.tsx):
 *
 *   - On mount, read the CURRENT reader's selection
 *     (`reader._internalReader._primaryView._selectionRanges`); multiple
 *     ranges are joined with a blank line.
 *   - Three blocks: source text (with a 「刷新选区」 button) → language bar
 *     (auto-detect source → target-language input, defaulting to
 *     `Zotero.locale`, Enter triggers, IME composition does not; a blur or
 *     Enter with an unchanged language never retriggers) → result area.
 *   - Result area has four states: loading (CSS skeleton breathing lines),
 *     error (message + retry), success (translation + copy), idle (selection
 *     ready but auto-translate off → a 「翻译」 button — never a repeated
 *     「请选择文本」 placeholder). A copy failure keeps the result on screen
 *     and appends a transient failure hint instead of discarding it.
 *   - `translate.auto` is read LIVE (at refresh time), never cached at mount.
 *   - Failure ≠ empty: a missing engine module, an empty translation, an
 *     unready engine or an over-long selection all surface an explicit error.
 *     No silent empty state anywhere.
 *   - Translation runs in the chrome realm by importing
 *     src/core/translation/translationEngines directly — there is no
 *     window/React bridge (leadero's LeaderoAPI.translate).
 *   - Word extension: a single-word selection (and wordcards.enabled) is
 *     looked up as a dictionary card (src/core/translation/dictionaryCard.ts)
 *     and every lookup is recorded in the word-card store
 *     (src/core/wordcards/wordCardStore.ts); a recent-words chip strip under
 *     the result area re-renders stored cards without touching the network.
 *
 * Differences forced by the port (also listed in the run's deviations):
 *   - No React: the whole panel is built with native DOM nodes
 *     (`createElementNS` in the XHTML namespace, so it renders correctly in
 *     Zotero 7's chrome document) and styled with a single injected
 *     `<style>` element that is removed again on destroy.
 *   - leadero's clipboard / IME helpers are inlined (the repo has no
 *     src/utils/clipboard.ts or src/utils/ime.ts); their three-tier copy
 *     chain and the isComposing/keyCode-229 guard are preserved.
 *   - Two capability disclosures leadero could not have: no reader at all,
 *     and a Zotero build without `_selectionRanges`.
 */

import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { createAbortController } from "../utils/abort";
import { toErrorMessage } from "../utils/error";
import { isIMEComposing } from "../utils/ime";
import { clearChildren, el, XHTML_NS } from "../utils/dom";
import { copyText } from "../utils/clipboard";
import { safeDebug } from "../utils/logger";
import { checkTranslationReadiness } from "../core/translation/featureReadiness";
import {
  flattenCardText,
  isSingleWord,
  lookupWord,
} from "../core/translation/dictionaryCard";
import type { DictionaryCardContent } from "../core/translation/types";
import {
  recentWordCards,
  upsertWordCard,
} from "../core/wordcards/wordCardStore";
import type { WordCardRecord } from "../core/wordcards/wordCardStore";

/** Class prefix for every node this module creates. */
const CLS = "ztransplit-tp";

/** Word cards shown in the recent-words chip strip under the result area. */
const CHIP_COUNT = 10;

/** Result-area states, mirroring leadero's `TranslateStatus`. */
export type TranslatePaneStatus = "idle" | "loading" | "success" | "error";

/** Outcome of reading the reader's current selection. */
type SelectionRead =
  /** Selection resolved to a non-empty string. */
  | { kind: "text"; text: string }
  /** A reader is present but nothing is selected. */
  | { kind: "empty" }
  /** No reader for the current tab (nothing open / not initialised yet). */
  | { kind: "no-reader" }
  /** The reader exists but exposes no selection API on this Zotero build. */
  | { kind: "unsupported" };

export interface TranslatePaneOptions {
  /** Document owning the section body (Zotero's main-window chrome document). */
  doc: Document;
  /** Section body element handed over by Zotero.ItemPaneManager. */
  body: HTMLElement;
  /**
   * Item of the current reader tab. Used only to sanity-check the reader we
   * resolve from `Zotero_Tabs.selectedID`, so a background tab's reader can
   * never supply the selection.
   */
  itemID?: number;
}

export interface TranslatePaneHandle {
  /**
   * Re-read the selection. Called by the registration module when Zotero
   * re-renders the section for a new item in the same tab (React remount in
   * leadero did the same work).
   */
  refresh(): void;
  /** Abort in-flight work, drop listeners, remove DOM + stylesheet. */
  destroy(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stylesheet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zotero 7 design tokens (see scss/themes/_light.scss / _dark.scss in the
 * Zotero source) with hard fallbacks so the pane still renders if a token is
 * ever renamed. Dark mode comes for free: Zotero re-declares these variables
 * under `prefers-color-scheme: dark`.
 */
const PANE_CSS = `
.${CLS}-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  color: var(--fill-primary, inherit);
  font: inherit;
}

/* Block 1 — source text */
.${CLS}-source { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.${CLS}-source-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; min-width: 0;
}
.${CLS}-source-label {
  font-size: 0.92em; font-weight: 600; opacity: 0.85;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.${CLS}-source-text {
  max-height: 11em; overflow-y: auto;
  padding: 6px 8px;
  border: var(--material-border-quinary, 1px solid rgba(127,127,127,0.25));
  border-radius: 6px;
  background: var(--material-background, transparent);
  font-size: 0.92em; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  box-sizing: border-box;
}
.${CLS}-placeholder { color: var(--fill-secondary, rgba(127,127,127,0.9)); }
/* Capability disclosure (no reader / API missing) — visually distinct from the
   neutral 「nothing selected」 hint so a gap is never mistaken for a hint. */
.${CLS}-disclosure {
  color: var(--accent-gold, #cc9200);
  border-left: 2px solid var(--accent-gold, #cc9200);
  padding-left: 6px;
}

/* Block 2 — language bar */
.${CLS}-lang-bar {
  display: flex; align-items: center; gap: 6px; min-width: 0;
}
.${CLS}-lang-auto {
  font-size: 0.92em; opacity: 0.85; white-space: nowrap;
}
.${CLS}-lang-arrow { font-size: 0.92em; opacity: 0.6; }
.${CLS}-lang-input {
  flex: 1 1 auto; min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--fill-quinary, rgba(127,127,127,0.35));
  border-radius: 5px;
  background: var(--material-control, var(--material-background, transparent));
  color: var(--fill-primary, inherit);
  font-size: 0.92em;
  box-sizing: border-box;
}
.${CLS}-lang-input:focus-visible {
  outline: 2px solid var(--color-focus-border, var(--accent-blue, #4072e5));
  outline-offset: -1px;
}

/* Buttons — Zotero 7 chrome-button look (padding, radius, hover fill) */
.${CLS}-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--fill-quinary, rgba(127,127,127,0.35));
  border-radius: 5px;
  background: var(--material-button, var(--material-background, transparent));
  color: var(--fill-primary, inherit);
  font-size: 0.88em; line-height: 1.5;
  cursor: pointer;
}
.${CLS}-btn:hover { background: var(--fill-quinary, rgba(127,127,127,0.18)); }
.${CLS}-btn:active { background: var(--fill-quarternary, rgba(127,127,127,0.28)); }
.${CLS}-btn:focus-visible {
  outline: 2px solid var(--color-focus-border, var(--accent-blue, #4072e5));
  outline-offset: 1px;
}
.${CLS}-btn:disabled { opacity: 0.55; cursor: default; }

/* Block 3 — result area */
.${CLS}-result {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
}
.${CLS}-result-idle { display: flex; align-items: center; gap: 6px; min-width: 0; }
.${CLS}-result-text {
  max-height: 16em; overflow-y: auto;
  padding: 6px 8px;
  border: var(--material-border-quinary, 1px solid rgba(127,127,127,0.25));
  border-radius: 6px;
  background: var(--material-background, transparent);
  font-size: 0.92em; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  box-sizing: border-box;
}
.${CLS}-result-actions { display: flex; align-items: center; gap: 6px; }
.${CLS}-error {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  color: var(--accent-red, #db2c3a); font-size: 0.88em; line-height: 1.45;
}
.${CLS}-meta { font-size: 0.82em; opacity: 0.7; }

/* Loading — CSS skeleton breathing lines (leadero §7/§9.1: the spinner
   was retired in favour of a shimmer line; same intent here). */
.${CLS}-loading { display: flex; flex-direction: column; gap: 6px; }
.${CLS}-shimmer-line {
  display: block; height: 0.72em; border-radius: 4px;
  background-image: linear-gradient(
    90deg,
    var(--fill-quinary, rgba(127,127,127,0.12)) 0%,
    var(--fill-quarternary, rgba(127,127,127,0.3)) 50%,
    var(--fill-quinary, rgba(127,127,127,0.12)) 100%
  );
  background-size: 200% 100%;
  animation: ${CLS}-shimmer 1.4s ease-in-out infinite;
}
.${CLS}-shimmer-short { width: 62%; }
@keyframes ${CLS}-shimmer {
  0%   { background-position: 140% 0; }
  100% { background-position: -40% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .${CLS}-shimmer-line { animation: none; background-position: 0 0; }
}

/* Dictionary card (single-word lookup success state) */
.${CLS}-card {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 20em; overflow-y: auto;
  padding: 8px 10px;
  border: var(--material-border-quinary, 1px solid rgba(127,127,127,0.25));
  border-radius: 6px;
  background: var(--material-background, transparent);
  box-sizing: border-box;
}
.${CLS}-card-head {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.${CLS}-card-word { font-size: 1.15em; font-weight: 600; }
.${CLS}-card-phonetic { font-size: 0.85em; opacity: 0.7; }
.${CLS}-card-sense {
  display: flex; gap: 6px; align-items: baseline;
  font-size: 0.92em; line-height: 1.45;
}
.${CLS}-card-pos {
  flex: 0 0 auto;
  font-size: 0.78em; line-height: 1.4;
  padding: 0 5px; border-radius: 4px;
  background: var(--fill-quinary, rgba(127,127,127,0.15));
  opacity: 0.9;
}
.${CLS}-card-example {
  font-size: 0.85em; font-style: italic; opacity: 0.75; line-height: 1.4;
}
.${CLS}-card-example-trans {
  font-size: 0.85em; opacity: 0.75; line-height: 1.4;
}
.${CLS}-card-foot {
  display: flex; align-items: center; gap: 6px; margin-top: 2px;
}
.${CLS}-card-source { font-size: 0.78em; opacity: 0.6; }

/* Recent-words chip strip (hidden entirely while the store is empty) */
.${CLS}-chips {
  display: flex; gap: 6px;
  overflow-x: auto; padding: 2px 0;
}
.${CLS}-chip {
  flex: 0 0 auto;
  padding: 1px 10px;
  border: 1px solid var(--fill-quinary, rgba(127,127,127,0.35));
  border-radius: 999px;
  background: var(--material-background, transparent);
  color: var(--fill-primary, inherit);
  font-size: 0.85em; line-height: 1.5;
  cursor: pointer;
}
.${CLS}-chip:hover { background: var(--fill-quinary, rgba(127,127,127,0.18)); }
.${CLS}-chip-active {
  border-color: var(--accent-blue, #4072e5);
  color: var(--accent-blue, #4072e5);
}
`;

function ensureStyle(doc: Document, body: HTMLElement): HTMLStyleElement {
  // The style element is appended to the section body itself, so it is removed
  // together with the panel (no chrome-document residue) and every pane
  // carries its own rules.
  const style = doc.createElementNS(
    XHTML_NS,
    "style",
  ) as unknown as HTMLStyleElement;
  style.className = `${CLS}-style`;
  style.textContent = PANE_CSS;
  body.appendChild(style);
  return style;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small DOM helpers — shared implementations live in src/utils/dom.ts
// ─────────────────────────────────────────────────────────────────────────────

type TrackedListener = {
  target: EventTarget;
  type: string;
  handler: EventListener;
};

// ─────────────────────────────────────────────────────────────────────────────
// Reader access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the reader of the CURRENT tab.
 *
 * Mirrors the codebase-standard pattern documented in
 * src/core/pdf/splitview/splitViewFactory.ts#getCurrentReaderItemID: ask the
 * main window for `Zotero_Tabs.selectedID` and hand that tabID to
 * `Zotero.Reader.getByTabID`. When `itemID` is supplied, a reader for a
 * different item is rejected so a background tab can never feed the pane.
 *
 * Exported for sibling UI modules (bilingualControl) that need the same
 * reader resolution semantics.
 */
export function resolveCurrentReader(doc: Document, itemID?: number): any {
  try {
    const win = doc?.defaultView as any;
    const ZoteroGlobal: any =
      (typeof Zotero === "undefined" ? undefined : (Zotero as any)) ??
      win?.Zotero;
    const Reader = ZoteroGlobal?.Reader ?? win?.Zotero?.Reader;
    const Zotero_Tabs = win?.Zotero_Tabs ?? ZoteroGlobal?.Tabs;
    const tabID: string | undefined = Zotero_Tabs?.selectedID;
    if (!Reader?.getByTabID || !tabID) return null;
    const reader = Reader.getByTabID(tabID);
    if (!reader) return null;
    // This section is READER-ONLY (onItemChange enables it in reader tabs),
    // so the active tab's reader is always the one the user is looking at.
    // The itemID hint is diagnostic only: the pane's binding can legitimately
    // lag the tab (a restored reader tab renders the pane before the user
    // switches — 7.0.15 E2E: pane bound item 5 while the active reader showed
    // item 7, and rejecting on inequality reported "no reader" for an open
    // PDF). Parent/attachment identity is likewise tolerated.
    if (
      itemID !== undefined &&
      reader.itemID !== undefined &&
      reader.itemID !== itemID
    ) {
      const parentID: number | undefined = ZoteroGlobal?.Items?.get?.(
        reader.itemID,
      )?.parentItemID;
      if (parentID !== itemID) {
        safeDebug(
          "[Z-Transplit] translatePane: pane bound item " + itemID +
            " but active reader shows item " + reader.itemID +
            " — following the active reader",
        );
      }
    }
    return reader;
  } catch (e) {
    safeDebug("[Z-Transplit] translatePane: resolveCurrentReader failed: " + e);
    return null;
  }
}

/**
 * Read the current reader selection.
 *
 * Exactly leadero's access path — `_internalReader._primaryView._selectionRanges`
 * — with `_secondaryView` as a documented secondary attempt. `undefined`
 * (rather than an empty array) is what distinguishes "API missing" from
 * "nothing selected", which is what keeps the empty state honest.
 */
function readSelection(doc: Document, itemID?: number): SelectionRead {
  const reader = resolveCurrentReader(doc, itemID);
  if (!reader) return { kind: "no-reader" };

  let ranges: any[] | undefined;
  try {
    const internal = reader._internalReader;
    if (!internal) return { kind: "no-reader" };
    ranges = internal._primaryView?._selectionRanges;
    if (ranges === undefined) ranges = internal._secondaryView?._selectionRanges;
  } catch (e) {
    safeDebug("[Z-Transplit] translatePane: read selection failed: " + e);
    return { kind: "unsupported" };
  }

  if (!Array.isArray(ranges)) return { kind: "unsupported" };

  const text = ranges
    .map((r: any) => r?.text)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text ? { kind: "text", text } : { kind: "empty" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clipboard + IME helpers — shared implementations live in
// src/utils/clipboard.ts and src/utils/ime.ts
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Translator loading (chrome realm, direct import — no bridge)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cached module promise. The import is resolved lazily (first translation) so
 * a failure inside the translation stack can never prevent the pane from
 * registering — it surfaces as an explicit error state instead.
 */
let translatorModulePromise: Promise<any> | null = null;

function loadTranslatorModule(): Promise<any> {
  if (!translatorModulePromise) {
    translatorModulePromise = import(
      "../core/translation/translationEngines"
    ).catch((e: unknown) => {
      // Drop the cache so a later attempt can retry after e.g. a plugin reload.
      translatorModulePromise = null;
      throw e;
    });
  }
  return translatorModulePromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pane
// ─────────────────────────────────────────────────────────────────────────────

/** One live pane per section body (Zotero re-renders a body for new items). */
const mountedPanes = new WeakMap<HTMLElement, TranslatePaneHandle>();

/**
 * Mount the translate pane into an item-pane section body.
 *
 * Idempotent per body: if the body already hosts a pane (Zotero re-rendered the
 * section for another item in the same tab), the existing pane is refreshed
 * instead of duplicated.
 */
export function mountTranslatePane(
  options: TranslatePaneOptions,
): TranslatePaneHandle {
  const { doc, body, itemID } = options;
  const existing = mountedPanes.get(body);
  if (existing) {
    existing.refresh();
    return existing;
  }

  // ── state ──
  let sourceText = "";
  let status: TranslatePaneStatus = "idle";
  let result: string | null = null;
  /** Dictionary card for word lookups (success state); null in text mode. */
  let card: DictionaryCardContent | null = null;
  /**
   * Whether the current source is treated as a dictionary word. Set when the
   * selection/chip is chosen, never recomputed mid-flight, so a retry replays
   * the same path the user started.
   */
  let wordMode = false;
  let error: string | null = null;
  let copied = false;
  let targetLang = defaultTargetLang();
  /** Language last committed via blur/Enter; unchanged blur is a no-op (pane-F5). */
  let committedLang = targetLang;
  /** Transient copy-failure hint shown under an intact result (pane-F6). */
  let copyError: string | null = null;
  let composing = false;
  let destroyed = false;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let copyErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  /** Result of the last selection read — drives the source block's disclosure. */
  let lastRead: SelectionRead["kind"] = "empty";
  /** Top of the word-card store, refreshed after mount and after each lookup. */
  let currentChips: WordCardRecord[] = [];

  const listeners: TrackedListener[] = [];

  function listen(
    target: EventTarget,
    type: string,
    handler: EventListener,
  ): void {
    target.addEventListener(type, handler);
    listeners.push({ target, type, handler });
  }

  // ── DOM skeleton ──
  const root = el(doc, "div", `${CLS}-pane`);
  root.setAttribute("tabindex", "-1");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", getString("pane-translate"));

  // Block 1 — source text
  const sourceBlock = el(doc, "div", `${CLS}-source`);
  const sourceHeader = el(doc, "div", `${CLS}-source-header`);
  const sourceLabel = el(doc, "span", `${CLS}-source-label`);
  sourceLabel.textContent = getString("pane-translate-source");
  const refreshBtn = el(doc, "button", `${CLS}-btn`) as HTMLButtonElement;
  refreshBtn.type = "button";
  refreshBtn.textContent = getString("pane-translate-refresh");
  sourceHeader.appendChild(sourceLabel);
  sourceHeader.appendChild(refreshBtn);
  const sourceBox = el(doc, "div", `${CLS}-source-text`);
  sourceBlock.appendChild(sourceHeader);
  sourceBlock.appendChild(sourceBox);

  // Block 2 — language bar
  const langBar = el(doc, "div", `${CLS}-lang-bar`);
  const langAuto = el(doc, "span", `${CLS}-lang-auto`);
  langAuto.textContent = getString("pane-translate-lang-auto");
  const langArrow = el(doc, "span", `${CLS}-lang-arrow`);
  langArrow.textContent = "→";
  langArrow.setAttribute("aria-hidden", "true");
  const langInput = el(doc, "input", `${CLS}-lang-input`) as HTMLInputElement;
  langInput.type = "text";
  langInput.value = targetLang;
  langInput.placeholder = getString("pane-translate-target-placeholder");
  langInput.setAttribute("aria-label", getString("pane-translate-target-placeholder"));
  langBar.appendChild(langAuto);
  langBar.appendChild(langArrow);
  langBar.appendChild(langInput);

  // Block 3 — result area
  const resultArea = el(doc, "div", `${CLS}-result`);
  resultArea.setAttribute("aria-live", "polite");

  root.appendChild(sourceBlock);
  root.appendChild(langBar);
  root.appendChild(resultArea);

  // Recent-words chip strip — hidden until the store has content, so a fresh
  // install sees exactly leadero's three-block layout.
  const chipsBar = el(doc, "div", `${CLS}-chips`);
  chipsBar.setAttribute("aria-label", getString("pane-translate-recent"));
  chipsBar.hidden = true;
  root.appendChild(chipsBar);

  const styleEl = ensureStyle(doc, body);
  body.appendChild(root);

  // ── rendering ──

  function renderSource(): void {
    clearChildren(sourceBox);
    if (sourceText) {
      const text = el(doc, "span");
      text.textContent = sourceText;
      sourceBox.appendChild(text);
      return;
    }
    // No text: be explicit about WHY (no reader / API missing / nothing
    // selected) instead of repeating a generic 「请选择文本」.
    const msg = el(doc, "span");
    msg.className =
      lastRead === "no-reader" || lastRead === "unsupported"
        ? `${CLS}-disclosure`
        : `${CLS}-placeholder`;
    msg.textContent =
      lastRead === "no-reader"
        ? getString("pane-translate-no-reader")
        : lastRead === "unsupported"
          ? getString("pane-translate-selection-unsupported")
          : lastRead === "empty"
            ? getString("pane-translate-empty-selection")
            : getString("pane-translate-placeholder");
    sourceBox.appendChild(msg);
  }

  function setState(patch: {
    sourceText?: string;
    status?: TranslatePaneStatus;
    result?: string | null;
    card?: DictionaryCardContent | null;
    error?: string | null;
    copied?: boolean;
  }): void {
    if (patch.sourceText !== undefined) sourceText = patch.sourceText;
    if (patch.status !== undefined) status = patch.status;
    if (patch.result !== undefined) result = patch.result;
    if (patch.card !== undefined) card = patch.card;
    if (patch.error !== undefined) error = patch.error;
    if (patch.copied !== undefined) copied = patch.copied;
  }

  /**
   * Dictionary card box: word header (+ phonetic), sense list with POS badges
   * and per-sense examples, card-level bilingual examples, and a footer with
   * the content-source tag and the copy action (copies flattenCardText).
   */
  function buildCardBox(): HTMLElement {
    const shown = card!;
    const box = el(doc, "div", `${CLS}-card`);
    const head = el(doc, "div", `${CLS}-card-head`);
    const wordEl = el(doc, "span", `${CLS}-card-word`);
    wordEl.textContent = shown.word;
    head.appendChild(wordEl);
    if (shown.phonetic) {
      const phonetic = el(doc, "span", `${CLS}-card-phonetic`);
      phonetic.textContent = shown.phonetic;
      head.appendChild(phonetic);
    }
    box.appendChild(head);

    for (const sense of shown.senses) {
      const line = el(doc, "div", `${CLS}-card-sense`);
      if (sense.pos) {
        const pos = el(doc, "span", `${CLS}-card-pos`);
        pos.textContent = sense.pos;
        line.appendChild(pos);
      }
      const meaning = el(doc, "span");
      meaning.textContent = sense.meaning;
      line.appendChild(meaning);
      box.appendChild(line);
      if (sense.example) {
        const example = el(doc, "div", `${CLS}-card-example`);
        example.textContent = sense.example;
        box.appendChild(example);
        if (sense.exampleTranslation) {
          const exampleTrans = el(doc, "div", `${CLS}-card-example-trans`);
          exampleTrans.textContent = sense.exampleTranslation;
          box.appendChild(exampleTrans);
        }
      }
    }

    for (const pair of shown.examples ?? []) {
      const example = el(doc, "div", `${CLS}-card-example`);
      example.textContent = pair.text;
      box.appendChild(example);
      const exampleTrans = el(doc, "div", `${CLS}-card-example-trans`);
      exampleTrans.textContent = pair.translation;
      box.appendChild(exampleTrans);
    }

    const foot = el(doc, "div", `${CLS}-card-foot`);
    const sourceTag = el(doc, "span", `${CLS}-card-source`);
    sourceTag.textContent = getString(`pane-translate-card-source-${shown.source}`);
    foot.appendChild(sourceTag);
    const copy = el(doc, "button", `${CLS}-btn`) as HTMLButtonElement;
    copy.type = "button";
    copy.textContent = copied ? getString("pane-translate-copied") : getString("pane-translate-copy");
    copy.addEventListener("click", () => void handleCopy());
    foot.appendChild(copy);
    box.appendChild(foot);
    return box;
  }

  function renderResult(): void {
    clearChildren(resultArea);

    if (status === "loading") {
      const loading = el(doc, "div", `${CLS}-loading`);
      loading.setAttribute("role", "status");
      const line1 = el(doc, "span", `${CLS}-shimmer-line`);
      const line2 = el(doc, "span", `${CLS}-shimmer-line ${CLS}-shimmer-short`);
      const meta = el(doc, "span", `${CLS}-meta`);
      meta.textContent = getString(
        wordMode ? "pane-translate-looking-up" : "pane-translate-translating",
      );
      loading.appendChild(line1);
      loading.appendChild(line2);
      loading.appendChild(meta);
      resultArea.appendChild(loading);
      return;
    }

    if (status === "error") {
      const box = el(doc, "div", `${CLS}-error`);
      const msg = el(doc, "span");
      msg.textContent = error || getString("translation-error-unknown");
      const retry = el(doc, "button", `${CLS}-btn`) as HTMLButtonElement;
      retry.type = "button";
      retry.textContent = getString("pane-translate-retry");
      // Untracked on purpose: this button is rebuilt on every renderResult and
      // discarded with it, so its listener dies with the node. Only listeners
      // on long-lived nodes go through listen()/destroy().
      retry.addEventListener("click", () => {
        if (!sourceText) return;
        if (wordMode) void runLookup(sourceText);
        else void runTranslation(sourceText);
      });
      box.appendChild(msg);
      box.appendChild(retry);
      resultArea.appendChild(box);
      return;
    }

    if (status === "success" && card) {
      resultArea.appendChild(buildCardBox());
      // Copy failure keeps the result on screen; the hint auto-dismisses.
      if (copyError) {
        const note = el(doc, "div", `${CLS}-error`);
        note.textContent = copyError;
        resultArea.appendChild(note);
      }
      return;
    }

    if (status === "success" && result) {
      const text = el(doc, "div", `${CLS}-result-text`);
      const resultText = el(doc, "span");
      resultText.textContent = result;
      text.appendChild(resultText);
      const actions = el(doc, "div", `${CLS}-result-actions`);
      const copy = el(doc, "button", `${CLS}-btn`) as HTMLButtonElement;
      copy.type = "button";
      copy.textContent = copied
        ? getString("pane-translate-copied")
        : getString("pane-translate-copy");
      copy.addEventListener("click", () => void handleCopy());
      actions.appendChild(copy);
      resultArea.appendChild(text);
      resultArea.appendChild(actions);
      // Copy failure keeps the result on screen; the hint auto-dismisses.
      if (copyError) {
        const note = el(doc, "div", `${CLS}-error`);
        note.textContent = copyError;
        resultArea.appendChild(note);
      }
      return;
    }

    if (status === "idle" && sourceText) {
      // Selection is ready but auto-translate is off → offer the action.
      // Never re-show 「请选择文本」 here (leadero §9.4).
      const box = el(doc, "div", `${CLS}-result-idle`);
      const action = el(doc, "button", `${CLS}-btn`) as HTMLButtonElement;
      action.type = "button";
      action.textContent = getString(
        wordMode ? "pane-translate-lookup-action" : "pane-translate-action",
      );
      action.addEventListener("click", () => {
        if (wordMode) void runLookup(sourceText);
        else void runTranslation(sourceText);
      });
      box.appendChild(action);
      resultArea.appendChild(box);
    }
    // idle + no source text → nothing: the source block already explains why.
  }

  function renderAll(): void {
    renderSource();
    renderResult();
  }

  // ── actions ──

  async function handleCopy(): Promise<void> {
    if (!result) return;
    const failure = await copyText(doc, result);
    if (destroyed) return;
    if (!failure) {
      copyError = null;
      setState({ copied: true });
      renderResult();
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copiedTimer = null;
        if (destroyed) return;
        setState({ copied: false });
        renderResult();
      }, 2000);
    } else {
      // Keep the successful result; surface a transient hint below it instead
      // of discarding the translation (pane-F6).
      if (copiedTimer) clearTimeout(copiedTimer);
      setState({ copied: false });
      copyError = getString("pane-translate-copy-failed", { error: failure });
      renderResult();
      if (copyErrorTimer) clearTimeout(copyErrorTimer);
      copyErrorTimer = setTimeout(() => {
        copyErrorTimer = null;
        if (destroyed) return;
        copyError = null;
        renderResult();
      }, 4000);
    }
  }

  /**
   * Run one translation. Mirrors leadero's doTranslate, with three extra
   * capability disclosures (readiness, char budget, engine module load).
   */
  async function runTranslation(text: string): Promise<void> {
    if (!text) return;

    // Any earlier request is superseded from here on, including by a guard
    // rejection below — otherwise a stale success could overwrite the error.
    abortController?.abort();
    abortController = null;

    // Readiness: an unconfigured engine is a configuration error, not a
    // translation failure — say which pref is missing.
    const readiness = checkTranslationReadiness();
    if (!readiness.ready) {
      const reason =
        readiness.missing
          .map((m) => getString(m.reasonKey))
          .filter(Boolean)
          .join("；") || getString("translation-error-unknown");
      setState({
        status: "error",
        error: getString("pane-translate-error-not-ready", { reason }),
        result: null,
      });
      renderResult();
      return;
    }

    // Char budget (addon/prefs.js: translate.maxChars) — refuse explicitly
    // instead of shipping a request the engine will reject.
    const maxCharsRaw = getPref("translate.maxChars");
    const maxChars = Number(maxCharsRaw);
    if (
      maxCharsRaw !== undefined &&
      Number.isFinite(maxChars) &&
      maxChars > 0 &&
      text.length > maxChars
    ) {
      setState({
        status: "error",
        error: getString("pane-translate-error-too-long", {
          count: String(text.length),
          max: String(maxChars),
        }),
        result: null,
      });
      renderResult();
      return;
    }

    // Resolve the translator from the chrome realm. A missing module is a
    // capability failure and must be disclosed as one (§9.4 失败≠空).
    let createTranslator: (t: string, s?: string) => any;
    try {
      const mod = await loadTranslatorModule();
      createTranslator = mod?.createTranslator;
      if (typeof createTranslator !== "function") {
        throw new Error(
          "src/core/translation/translationEngines does not export createTranslator()",
        );
      }
    } catch (e) {
      setState({
        status: "error",
        error: getString("pane-translate-error-service", {
          error: toErrorMessage(e),
        }),
        result: null,
      });
      renderResult();
      return;
    }

    // A newer request supersedes the previous one.
    const controller = createAbortController();
    abortController = controller;

    // A new request makes any stale copy-failure hint irrelevant.
    copyError = null;
    setState({ status: "loading", error: null, result: null });
    renderResult();

    try {
      const target = targetLang.trim() || defaultTargetLang();
      const translator = createTranslator(target) as (
        t: string,
        tgt?: string,
        src?: string,
      ) => Promise<string>;
      const translated = await translator(text, target);

      if (controller.signal.aborted || destroyed) return;

      if (!translated || !translated.trim()) {
        // Success-with-empty-result is a failure, not a success (§9.4).
        setState({
          status: "error",
          error: getString("pane-translate-error-empty"),
          result: null,
        });
      } else {
        setState({ status: "success", result: translated, error: null, copied: false });
      }
    } catch (e) {
      if (controller.signal.aborted || destroyed) return;
      setState({
        status: "error",
        error: getString("pane-translate-error", { error: toErrorMessage(e) }),
        result: null,
      });
    }
    if (!destroyed) renderResult();
  }

  /**
   * Run one dictionary lookup for a single word. Same request-supersession
   * and error-state machinery as runTranslation, minus the readiness/char
   * budget prechecks: the chain's first layer (Youdao) needs no engine at
   * all, and a word can never exceed the char budget.
   */
  async function runLookup(word: string): Promise<void> {
    if (!word) return;

    // Any earlier request is superseded from here on.
    abortController?.abort();
    abortController = null;
    const controller = createAbortController();
    abortController = controller;

    copyError = null;
    setState({ status: "loading", error: null, result: null, card: null });
    renderResult();

    try {
      const target = targetLang.trim() || defaultTargetLang();
      const looked = await lookupWord(word, target, controller.signal);
      if (controller.signal.aborted || destroyed) return;
      setState({
        status: "success",
        card: looked,
        result: flattenCardText(looked),
        error: null,
        copied: false,
      });
      // Record + refresh the chip strip off the critical path; both are
      // no-throw by contract, and a store failure must never look like a
      // lookup failure.
      void upsertWordCard({
        word: looked.word || word,
        targetLang: target,
        content: looked,
        sourceItemID: itemID,
      }).then(() => void refreshChips());
    } catch (e) {
      if (controller.signal.aborted || destroyed) return;
      setState({
        status: "error",
        error: getString("pane-translate-error", { error: toErrorMessage(e) }),
        result: null,
        card: null,
      });
    }
    if (!destroyed) renderResult();
  }

  // ── recent-words chip strip ────────────────────────────────────────────────

  /** Reload the strip's data from the store, then re-render it. */
  async function refreshChips(): Promise<void> {
    if (destroyed) return;
    currentChips = await recentWordCards(CHIP_COUNT);
    renderChips();
  }

  function renderChips(): void {
    clearChildren(chipsBar);
    if (currentChips.length === 0) {
      chipsBar.hidden = true;
      return;
    }
    chipsBar.hidden = false;
    const activeKey = sourceText.trim().toLowerCase();
    for (const record of currentChips) {
      const chip = el(doc, "button", `${CLS}-chip`) as HTMLButtonElement;
      chip.type = "button";
      chip.textContent = record.word;
      if (record.word.toLowerCase() === activeKey) {
        chip.classList.add(`${CLS}-chip-active`);
      }
      // Rebuilt on every renderChips — the listener dies with the node.
      chip.addEventListener("click", () => showStoredCard(record));
      chipsBar.appendChild(chip);
    }
  }

  /**
   * Show a stored card. Deliberately offline: no re-lookup, no readiness
   * check — the card was already fetched and persisted, so the chip must
   * render it even with the engine unconfigured or the network down.
   */
  function showStoredCard(record: WordCardRecord): void {
    abortController?.abort();
    abortController = null;
    copyError = null;
    wordMode = true;
    setState({
      sourceText: record.latest.word || record.word,
      status: "success",
      card: record.latest,
      result: flattenCardText(record.latest),
      error: null,
      copied: false,
    });
    renderAll();
  }

  function handleRefreshSelection(): void {
    copyError = null; // a new selection makes the old copy hint stale
    const read = readSelection(doc, itemID);
    lastRead = read.kind;
    if (read.kind === "text") {
      setState({ sourceText: read.text });
      if (copiedTimer) {
        clearTimeout(copiedTimer);
        copiedTimer = null;
      }
      setState({ copied: false });
      // Word selections route to the dictionary chain when the feature is on;
      // everything else keeps the plain-translation path.
      wordMode = !!getPref("wordcards.enabled") && isSingleWord(read.text);
      // translate.auto is read LIVE — a pref flipped while the pane is open
      // takes effect on the next refresh.
      if (getPref("translate.auto")) {
        if (wordMode) void runLookup(read.text);
        else void runTranslation(read.text);
      } else {
        // Nothing is in flight for the new selection.
        abortController?.abort();
        abortController = null;
        setState({ status: "idle", result: null, error: null, card: null });
      }
    } else {
      // Nothing (or nothing readable): drop the stale source text so the pane
      // cannot show a translation of text that is no longer selected.
      abortController?.abort();
      abortController = null;
      wordMode = false;
      setState({ sourceText: "", status: "idle", result: null, error: null, card: null });
    }
    renderAll();
  }

  function handleLangBlur(): void {
    const trimmed = langInput.value.trim();
    // Unchanged since the last commit → pure no-op: no re-request, success
    // state kept (pane-F5).
    if (trimmed === committedLang) return;
    targetLang = trimmed;
    committedLang = trimmed;
    if (trimmed && sourceText && status !== "loading") {
      void runTranslation(sourceText);
    }
  }

  // ── listeners (tracked so destroy() can revoke them all) ──
  listen(refreshBtn, "click", () => handleRefreshSelection());
  listen(langInput, "input", () => {
    targetLang = langInput.value;
  });
  listen(langInput, "blur", () => handleLangBlur());
  listen(langInput, "compositionstart", () => {
    composing = true;
  });
  listen(langInput, "compositionend", () => {
    composing = false;
  });
  listen(langInput, "keydown", (event) => {
    const e = event as KeyboardEvent;
    if (composing || isIMEComposing(e)) return; // Enter = candidate confirm
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      langInput.blur(); // blur → handleLangBlur → translate
    }
  });

  // ── mount effect (leadero's useEffect(…, [])) ──
  const initial = readSelection(doc, itemID);
  lastRead = initial.kind;
  // Reader-init race: on a freshly opened tab the reader may not be
  // registered yet (found in the 7.0.15 manual review — the pane showed a
  // stale "no reader" until the user clicked refresh). Re-check a couple of
  // times before trusting the negative result.
  if (initial.kind === "no-reader") {
    const recheck = (delayMs: number): void => {
      setTimeout(() => {
        if (destroyed || lastRead !== "no-reader") return;
        const retry = readSelection(doc, itemID);
        if (retry.kind === lastRead) return;
        lastRead = retry.kind;
        if (retry.kind === "text") setState({ sourceText: retry.text });
        renderAll();
      }, delayMs);
    };
    recheck(2000);
    recheck(5000);
  }
  if (initial.kind === "text") {
    setState({ sourceText: initial.text });
    wordMode = !!getPref("wordcards.enabled") && isSingleWord(initial.text);
    if (getPref("translate.auto")) {
      if (wordMode) void runLookup(initial.text);
      else void runTranslation(initial.text);
    }
  }
  renderAll();
  void refreshChips();

  const handle: TranslatePaneHandle = {
    refresh() {
      if (destroyed) return;
      handleRefreshSelection();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abortController?.abort();
      abortController = null;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = null;
      if (copyErrorTimer) clearTimeout(copyErrorTimer);
      copyErrorTimer = null;
      for (const { target, type, handler } of listeners.splice(0)) {
        try {
          target.removeEventListener(type, handler);
        } catch (e) {
          safeDebug(
            "[Z-Transplit] translatePane: removeEventListener failed: " + e,
          );
        }
      }
      try {
        root.remove();
        styleEl?.remove();
      } catch (e) {
        safeDebug("[Z-Transplit] translatePane: DOM cleanup failed: " + e);
      }
      if (mountedPanes.get(body) === handle) mountedPanes.delete(body);
    },
  };

  mountedPanes.set(body, handle);
  return handle;
}

/** Default target language: Zotero's UI locale (leadero: Zotero.locale). */
function defaultTargetLang(): string {
  try {
    const locale =
      (typeof Zotero === "undefined" ? undefined : (Zotero as any)?.locale) ??
      (globalThis as any)?.Zotero?.locale;
    if (typeof locale === "string" && locale) return locale;
  } catch (e) {
    safeDebug("[Z-Transplit] translatePane: Zotero.locale unavailable: " + e);
  }
  return "zh-CN";
}

export default mountTranslatePane;
