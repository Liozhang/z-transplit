/**
 * wordCardsTab — the Word Cards tab: the full browsing surface of the
 * word-card store (grid + detail), opened from the library toolbar button or
 * the reader toolbar button.
 *
 * Layout follows the pane conventions of translatePane.ts / bilingualControl:
 * native DOM in the XHTML namespace, one injected <style> scoped by a module
 * class prefix, Zotero 7 design tokens with hard fallbacks (dark mode comes
 * for free via Zotero's prefers-color-scheme re-declarations).
 *
 * Tab mechanics follow splitViewFactory.ts's use of the Zotero_Tabs API:
 * Zotero_Tabs.add({ id, type, title, select, onClose }) with a custom
 * (non-reader) type, our DOM inside the returned container, and onClose as
 * the cleanup hook. One instance at a time: a second open request selects the
 * existing tab instead of stacking a duplicate.
 *
 * Everything renders from the store's in-memory index — opening the tab and
 * searching never touch the network; only delete/clear hit the disk.
 */

import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { isIMEComposing } from "../utils/ime";
import { copyText } from "../utils/clipboard";
import { clearChildren, el } from "../utils/dom";
import { safeDebug } from "../utils/logger";
import { flattenCardText } from "../core/translation/dictionaryCard";
import {
  clearAllWordCards,
  deleteWordCard,
  listWordCards,
  sanitizeContexts,
} from "../core/wordcards/wordCardStore";
import type {
  WordCardContext,
  WordCardRecord,
} from "../core/wordcards/wordCardStore";
import type { DictionaryCardContent } from "../core/translation/types";
import {
  WordCardSpeaker,
  exampleSegments,
  type SpeechKind,
} from "./wordCardSpeech";

const CLS = "ztransplit-wc";

/** Fixed id of the single word-cards tab (registration + close + reopen). */
export const WORDCARDS_TAB_ID = "ztransplit-wordcards";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

export type WordCardSort = "recent" | "alpha";

/** Substring filter over word, sense meanings and example texts. Never throws. */
export function filterCards(
  records: WordCardRecord[],
  query: string,
): WordCardRecord[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return records.slice();
  return records.filter((r) => {
    if (r.word.toLowerCase().includes(q)) return true;
    const senses = r.latest?.senses ?? [];
    if (senses.some((s) => s.meaning.toLowerCase().includes(q))) return true;
    return (r.latest?.examples ?? []).some(
      (x) => x.text.toLowerCase().includes(q) || x.translation.toLowerCase().includes(q),
    );
  });
}

/** Sort: most recently updated first, or by word (locale-aware). */
export function sortCards(
  records: WordCardRecord[],
  sort: WordCardSort,
): WordCardRecord[] {
  const out = records.slice();
  if (sort === "alpha") {
    out.sort((a, b) => a.word.localeCompare(b.word));
  } else {
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return out;
}

/** Short date for tiles and history entries; "" when the stamp is unusable. */
export function cardDate(ts: number): string {
  try {
    if (!Number.isFinite(ts) || ts <= 0) return "";
    return new Date(ts).toLocaleDateString();
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stylesheet
// ─────────────────────────────────────────────────────────────────────────────

const TAB_CSS = `
.${CLS}-root {
  display: flex; flex-direction: column; gap: 8px;
  /* The host is Zotero's <tab-content>, a flex-ROW XUL element: without an
     explicit size the root is a content-sized flex item, so the page would
     shrink to its own content width and re-flow on every card selection.
     width/height cover non-flex hosts; flex covers flex hosts. */
  flex: 1 1 auto;
  width: 100%; height: 100%;
  min-height: 0; min-width: 0;
  box-sizing: border-box;
  padding: 8px 12px;
  font: inherit;
  color: var(--fill-primary, inherit);
}

/* Toolbar row */
.${CLS}-bar {
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto; min-width: 0;
}
.${CLS}-search {
  flex: 1 1 220px; min-width: 120px;
  padding: 3px 8px;
  border: 1px solid var(--fill-quinary, rgba(127,127,127,0.35));
  border-radius: 5px;
  background: var(--material-control, var(--material-background, transparent));
  color: var(--fill-primary, inherit);
  font: inherit;
  box-sizing: border-box;
}
.${CLS}-search:focus-visible {
  outline: 2px solid var(--color-focus-border, var(--accent-blue, #4072e5));
  outline-offset: -1px;
}
.${CLS}-sort {
  flex: 0 0 auto;
  padding: 2px 4px;
  border: 1px solid var(--fill-quinary, rgba(127,127,127,0.35));
  border-radius: 5px;
  background: var(--material-control, var(--material-background, transparent));
  color: var(--fill-primary, inherit);
  font: inherit;
}
.${CLS}-count {
  font-size: 0.82em; opacity: 0.7; white-space: nowrap; margin-left: auto;
}
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
.${CLS}-btn-danger { color: var(--accent-red, #db2c3a); }
.${CLS}-btn-speaking {
  color: var(--accent-blue, #4072e5);
  border-color: var(--accent-blue, #4072e5);
}

/* Body: card grid + detail column */
.${CLS}-body {
  display: flex; gap: 12px;
  flex: 1 1 auto; min-height: 0;
}
.${CLS}-grid {
  flex: 1 1 auto; min-width: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
  align-content: start;
  padding: 2px;
}
.${CLS}-detail {
  flex: 0 0 320px;
  overflow-y: auto;
  border-left: 1px solid var(--material-border-quinary, rgba(127,127,127,0.25));
  padding-left: 12px;
}
@media (max-width: 720px) {
  .${CLS}-detail { display: none; }
}

/* Card tile */
.${CLS}-tile {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--material-border-quinary, rgba(127,127,127,0.25));
  border-radius: 8px;
  background: var(--material-background, transparent);
  cursor: pointer;
}
.${CLS}-tile:hover { background: var(--fill-quinary, rgba(127,127,127,0.12)); }
.${CLS}-tile:focus-visible {
  outline: 2px solid var(--color-focus-border, var(--accent-blue, #4072e5));
  outline-offset: 1px;
}
.${CLS}-tile-active {
  border-color: var(--accent-blue, #4072e5);
  box-shadow: inset 0 0 0 1px var(--accent-blue, #4072e5);
}
.${CLS}-tile-word { font-weight: 600; font-size: 1.02em; }
.${CLS}-tile-phonetic { font-size: 0.8em; opacity: 0.65; }
.${CLS}-tile-meaning {
  font-size: 0.85em; opacity: 0.85; line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.${CLS}-tile-date { font-size: 0.75em; opacity: 0.55; }

/* Detail column */
.${CLS}-d-head {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  margin-bottom: 4px;
}
.${CLS}-d-word { font-size: 1.2em; font-weight: 600; }
.${CLS}-d-phonetic { font-size: 0.85em; opacity: 0.7; }
.${CLS}-d-sense {
  display: flex; gap: 6px; align-items: baseline;
  font-size: 0.92em; line-height: 1.45;
  margin-bottom: 4px;
}
.${CLS}-d-pos {
  flex: 0 0 auto;
  font-size: 0.78em; line-height: 1.4;
  padding: 0 5px; border-radius: 4px;
  background: var(--fill-quinary, rgba(127,127,127,0.15));
  opacity: 0.9;
}
.${CLS}-d-example { font-size: 0.85em; font-style: italic; opacity: 0.75; line-height: 1.4; }
.${CLS}-d-example-trans { font-size: 0.85em; opacity: 0.75; line-height: 1.4; margin-bottom: 4px; }
.${CLS}-d-section {
  font-size: 0.78em; font-weight: 600; opacity: 0.7;
  margin: 10px 0 4px;
  border-top: 1px solid var(--material-border-quinary, rgba(127,127,127,0.25));
  padding-top: 8px;
}
.${CLS}-d-history {
  font-size: 0.85em; opacity: 0.85; line-height: 1.5; margin-bottom: 2px;
}
.${CLS}-d-history-time { opacity: 0.6; font-size: 0.85em; margin-right: 6px; }
.${CLS}-d-ctx {
  display: block; width: 100%;
  border: none; padding: 5px 6px; margin: 0 0 3px -6px;
  border-radius: 4px; text-align: left;
  background: transparent; color: inherit;
  font: inherit; cursor: pointer;
}
.${CLS}-d-ctx:hover { background: var(--fill-quinary, rgba(127,127,127,0.15)); }
.${CLS}-d-ctx:focus-visible {
  outline: 2px solid var(--color-focus-border, var(--accent-blue, #4072e5));
  outline-offset: -2px;
}
.${CLS}-d-ctx-sentence { font-size: 0.85em; font-style: italic; opacity: 0.85; line-height: 1.45; }
.${CLS}-d-ctx-meta { font-size: 0.75em; opacity: 0.6; line-height: 1.4; margin-top: 1px; }
.${CLS}-d-actions { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
.${CLS}-d-meta { font-size: 0.8em; opacity: 0.65; }

/* Empty / placeholder states */
.${CLS}-empty {
  flex: 1 1 auto;
  grid-column: 1 / -1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  opacity: 0.85;
}
.${CLS}-empty-icon { width: 48px; height: 48px; opacity: 0.4; }
.${CLS}-empty-title { font-size: 1.05em; font-weight: 600; }
.${CLS}-empty-hint {
  font-size: 0.88em; opacity: 0.7; line-height: 1.5;
  max-width: 40em; text-align: center;
}
.${CLS}-hint { font-size: 0.88em; opacity: 0.7; line-height: 1.5; padding: 12px 4px; }
`;

// ─────────────────────────────────────────────────────────────────────────────
// The tab
// ─────────────────────────────────────────────────────────────────────────────

interface WordCardsTabState {
  win: any;
  doc: Document;
  root: HTMLElement;
  styleEl: HTMLStyleElement;
  gridEl: HTMLElement;
  detailEl: HTMLElement;
  countEl: HTMLElement;
  searchEl: HTMLInputElement;
  records: WordCardRecord[];
  query: string;
  sort: WordCardSort;
  selectedKey: string | null;
  /** Two-step clear confirmation (never a modal). */
  clearArmed: boolean;
  clearTimer: ReturnType<typeof setTimeout> | null;
  copiedTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  /** Read-aloud playback; null until the tab is fully built. */
  speaker: WordCardSpeaker | null;
  /** Detail-column speak buttons (recreated per buildDetail). */
  speakBtn: HTMLButtonElement | null;
  examplesBtn: HTMLButtonElement | null;
}

let activeTab: WordCardsTabState | null = null;

/**
 * Open (or focus) the word-cards tab on the given main window.
 *
 * Safe to call repeatedly: an open tab is selected, a tab left over from a
 * plugin reload is re-selected rather than duplicated, and a missing
 * Zotero_Tabs API degrades to a debug log.
 */
export function openWordCardsTab(win: any): void {
  try {
    const Zotero_Tabs =
      win?.Zotero_Tabs ?? (globalThis as any)?.Zotero?.Tabs;
    if (!Zotero_Tabs?.add || typeof Zotero_Tabs.add !== "function") {
      safeDebug("[Z-Transplit] wordCardsTab: Zotero_Tabs.add unavailable");
      return;
    }
    // Focus the existing tab. Covers both a double open request and the
    // dev-reload case where the tab survives but our module state is fresh.
    try {
      if (Zotero_Tabs._getTab?.(WORDCARDS_TAB_ID)?.tab) {
        Zotero_Tabs.select(WORDCARDS_TAB_ID);
        return;
      }
    } catch {
      /* _getTab is not a public contract — fall through to add() */
    }
    if (activeTab) {
      Zotero_Tabs.select(WORDCARDS_TAB_ID);
      return;
    }
    // Zotero_Tabs.add() appends the container, registers the tab, and only
    // then selects it — anything throwing in between (Zotero's own _update or
    // another plugin's tab observer) used to leave the tab registered but
    // unselected, i.e. the user had to click the button a second time. Recover
    // instead: resolve the container by id and select the tab ourselves.
    let container: any = null;
    try {
      const added = Zotero_Tabs.add({
        id: WORDCARDS_TAB_ID,
        type: WORDCARDS_TAB_ID,
        // Zotero 10's _update() reads tab.data.icon on EVERY non-library tab
        // with no undefined guard — data must be a defined object or add()
        // throws mid-flight (observed on 10.0.3: "can't access property
        // \"icon\", tab.data is undefined", leaving a container-less tab).
        // The wordcards glyph renders as the tab-bar icon; an empty string
        // would mean a title-only entry.
        data: {
          icon: "chrome://ztransplit/content/icons/wordcards-16.svg",
        },
        title: getString("wordcards-tab-title"),
        select: true,
        onClose: () => destroyTab(),
      });
      container = added?.container ?? null;
    } catch (e) {
      safeDebug(
        "[Z-Transplit] wordCardsTab: add threw mid-flight (recovering): " + e,
      );
    }
    if (!container) {
      container = win?.document?.getElementById(WORDCARDS_TAB_ID) ?? null;
    }
    if (!container) {
      safeDebug("[Z-Transplit] wordCardsTab: no tab container was created");
      return;
    }
    try {
      if (Zotero_Tabs.selectedID !== WORDCARDS_TAB_ID) {
        Zotero_Tabs.select(WORDCARDS_TAB_ID);
      }
    } catch (e) {
      safeDebug("[Z-Transplit] wordCardsTab: select failed: " + e);
    }
    void mountTab(win, WORDCARDS_TAB_ID, container);
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardsTab: open failed: " + e);
  }
}

/** Programmatic teardown (plugin shutdown closes the tab). */
export function closeWordCardsTab(): void {
  try {
    for (const win of (globalThis as any)?.Zotero?.getMainWindows?.() ?? []) {
      win?.Zotero_Tabs?.close?.(WORDCARDS_TAB_ID);
    }
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardsTab: close failed: " + e);
  }
  destroyTab();
}

function destroyTab(): void {
  const state = activeTab;
  activeTab = null;
  if (!state) return;
  state.closing = true;
  if (state.clearTimer) clearTimeout(state.clearTimer);
  if (state.copiedTimer) clearTimeout(state.copiedTimer);
  // Stop before touching the DOM: onChange must observe the closing guard.
  state.speaker?.stop();
  try {
    state.root.remove();
    state.styleEl.remove();
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardsTab: DOM cleanup failed: " + e);
  }
}

async function mountTab(
  win: any,
  tabID: string,
  container: any,
): Promise<void> {
  try {
    const doc: Document = win?.document;
    if (!doc) return;
    // The container element can lag the add() call (splitViewFactory polls
    // for the same reason) — give it up to ~2s before giving up.
    let host = container ?? doc.getElementById(tabID);
    for (let i = 0; !host && i < 20; i++) {
      await sleep(win, 100);
      if (activeTab) return; // closed while waiting
      host = doc.getElementById(tabID);
    }
    if (!host) {
      safeDebug("[Z-Transplit] wordCardsTab: tab container never appeared");
      return;
    }
    buildTab(win, doc, host);
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardsTab: mount failed: " + e);
  }
}

function sleep(win: any, ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTab(win: any, doc: Document, host: Element): void {
  const styleEl = doc.createElement("style") as unknown as HTMLStyleElement;
  styleEl.className = `${CLS}-style`;
  styleEl.textContent = TAB_CSS;
  host.appendChild(styleEl);

  const root = el(doc, "div", `${CLS}-root`);
  host.appendChild(root);

  // ── toolbar row ──
  const bar = el(doc, "div", `${CLS}-bar`);
  const search = el(doc, "input", `${CLS}-search`) as HTMLInputElement;
  search.type = "text";
  search.placeholder = getString("wordcards-search-placeholder");
  search.setAttribute(
    "aria-label",
    getString("wordcards-search-placeholder"),
  );
  const sortSel = el(doc, "select", `${CLS}-sort`) as HTMLSelectElement;
  const optRecent = el(doc, "option") as HTMLOptionElement;
  optRecent.value = "recent";
  optRecent.textContent = getString("wordcards-sort-recent");
  const optAlpha = el(doc, "option") as HTMLOptionElement;
  optAlpha.value = "alpha";
  optAlpha.textContent = getString("wordcards-sort-alpha");
  sortSel.append(optRecent, optAlpha);
  const count = el(doc, "span", `${CLS}-count`);
  const clearBtn = el(doc, "button", `${CLS}-btn`) as HTMLButtonElement;
  clearBtn.type = "button";
  clearBtn.textContent = getString("wordcards-clear");
  bar.append(search, sortSel, count, clearBtn);

  // ── body ──
  const body = el(doc, "div", `${CLS}-body`);
  const grid = el(doc, "div", `${CLS}-grid`);
  const detail = el(doc, "div", `${CLS}-detail`);
  body.append(grid, detail);
  root.append(bar, body);

  const state: WordCardsTabState = {
    win,
    doc,
    root,
    styleEl,
    gridEl: grid,
    detailEl: detail,
    countEl: count,
    searchEl: search,
    records: [],
    query: "",
    sort: "recent",
    selectedKey: null,
    clearArmed: false,
    clearTimer: null,
    copiedTimer: null,
    closing: false,
    speaker: null,
    speakBtn: null,
    examplesBtn: null,
  };
  activeTab = state;
  state.speaker = new WordCardSpeaker(
    () => win,
    () => updateSpeakButtons(state),
  );

  // ── events (nodes die with the root, so listeners need no tracking) ──
  search.addEventListener("input", () => {
    state.query = search.value;
    render(state);
  });
  search.addEventListener("keydown", (event) => {
    // IME Enter confirms the candidate — never trigger anything.
    const e = event as KeyboardEvent;
    if (isIMEComposing(e)) return;
    if (e.key === "Enter") e.preventDefault();
  });
  sortSel.addEventListener("change", () => {
    state.sort = sortSel.value === "alpha" ? "alpha" : "recent";
    render(state);
  });
  clearBtn.addEventListener("click", async () => {
    // Two-step confirm: arm on first click, fire within 3s, disarm otherwise.
    if (!state.clearArmed) {
      state.clearArmed = true;
      clearBtn.textContent = getString("wordcards-clear-confirm");
      clearBtn.classList.add(`${CLS}-btn-danger`);
      state.clearTimer = setTimeout(() => {
        state.clearTimer = null;
        state.clearArmed = false;
        if (state.closing || activeTab !== state) return;
        clearBtn.textContent = getString("wordcards-clear");
        clearBtn.classList.remove(`${CLS}-btn-danger`);
      }, 3000);
      return;
    }
    if (state.clearTimer) clearTimeout(state.clearTimer);
    state.clearTimer = null;
    state.clearArmed = false;
    clearBtn.textContent = getString("wordcards-clear");
    clearBtn.classList.remove(`${CLS}-btn-danger`);
    await clearAllWordCards();
    if (state.closing || activeTab !== state) return;
    await reloadRecords(state);
  });

  void reloadRecords(state);
}

async function reloadRecords(state: WordCardsTabState): Promise<void> {
  state.records = await listWordCards();
  if (state.closing || activeTab !== state) return;
  render(state);
}

function render(state: WordCardsTabState): void {
  state.countEl.textContent = getString("wordcards-count", {
    count: String(state.records.length),
  });
  clearChildren(state.gridEl);
  clearChildren(state.detailEl);

  if (state.records.length === 0) {
    state.gridEl.appendChild(buildEmpty(state));
    return;
  }

  const visible = sortCards(filterCards(state.records, state.query), state.sort);
  if (visible.length === 0) {
    const hint = el(state.doc, "div", `${CLS}-hint`);
    hint.textContent = getString("wordcards-no-match");
    state.gridEl.appendChild(hint);
    state.detailEl.appendChild(buildDetailPlaceholder(state));
    return;
  }

  // Keep the selection valid and default to the first visible card.
  if (!visible.some((r) => r.key === state.selectedKey)) {
    state.selectedKey = visible[0].key;
  }
  for (const record of visible) {
    state.gridEl.appendChild(buildTile(state, record));
  }
  const selected = state.records.find((r) => r.key === state.selectedKey);
  if (selected) state.detailEl.appendChild(buildDetail(state, selected));
}

/**
 * Selection-only update for a tile click: toggle the tiles' highlight and
 * rebuild just the detail column. Re-rendering the whole grid instead would
 * destroy every tile (focus loss) and reset the grid's scroll position —
 * the "page jumps when I pick a card" effect.
 */
function selectCard(state: WordCardsTabState, key: string): void {
  state.selectedKey = key;
  const tiles = state.gridEl.querySelectorAll(`.${CLS}-tile`);
  for (const tile of tiles) {
    tile.classList.toggle(
      `${CLS}-tile-active`,
      (tile as HTMLElement).getAttribute("data-key") === key,
    );
  }
  clearChildren(state.detailEl);
  const selected = state.records.find((r) => r.key === key);
  if (selected) state.detailEl.appendChild(buildDetail(state, selected));
}

function buildEmpty(state: WordCardsTabState): HTMLElement {
  const box = el(state.doc, "div", `${CLS}-empty`);
  const icon = state.doc.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  ) as unknown as SVGElement;
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("class", `${CLS}-empty-icon`);
  icon.setAttribute("aria-hidden", "true");
  const iconG = state.doc.createElementNS("http://www.w3.org/2000/svg", "g");
  iconG.setAttribute("fill", "none");
  iconG.setAttribute("stroke", "currentColor");
  iconG.setAttribute("stroke-width", "1.2");
  iconG.setAttribute("stroke-linecap", "round");
  iconG.setAttribute("stroke-linejoin", "round");
  const rect = state.doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "4.5");
  rect.setAttribute("y", "3.5");
  rect.setAttribute("width", "15");
  rect.setAttribute("height", "17");
  rect.setAttribute("rx", "2");
  const pathA = state.doc.createElementNS("http://www.w3.org/2000/svg", "path");
  pathA.setAttribute("d", "M9.2 14.5 L12 8 L14.8 14.5");
  const pathBar = state.doc.createElementNS("http://www.w3.org/2000/svg", "path");
  pathBar.setAttribute("d", "M10.4 12.3 H13.6");
  const pathLine = state.doc.createElementNS("http://www.w3.org/2000/svg", "path");
  pathLine.setAttribute("d", "M8.5 17.5 H15.5");
  iconG.append(rect, pathA, pathBar, pathLine);
  icon.appendChild(iconG);

  const title = el(state.doc, "div", `${CLS}-empty-title`);
  title.textContent = getString("wordcards-empty-title");
  const hint = el(state.doc, "div", `${CLS}-empty-hint`);
  hint.textContent = getString(
    getPref("wordcards.enabled")
      ? "wordcards-empty-hint"
      : "wordcards-disabled-hint",
  );
  box.append(icon, title, hint);
  return box;
}

function buildTile(
  state: WordCardsTabState,
  record: WordCardRecord,
): HTMLElement {
  const tile = el(state.doc, "div", `${CLS}-tile`);
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  tile.setAttribute("data-key", record.key);
  if (record.key === state.selectedKey) {
    tile.classList.add(`${CLS}-tile-active`);
  }
  const word = el(state.doc, "div", `${CLS}-tile-word`);
  word.textContent = record.word;
  tile.appendChild(word);
  if (record.latest.phonetic) {
    const phonetic = el(state.doc, "div", `${CLS}-tile-phonetic`);
    phonetic.textContent = record.latest.phonetic;
    tile.appendChild(phonetic);
  }
  const meaning = el(state.doc, "div", `${CLS}-tile-meaning`);
  meaning.textContent = record.latest.senses[0]?.meaning ?? "";
  tile.appendChild(meaning);
  const date = el(state.doc, "div", `${CLS}-tile-date`);
  date.textContent = cardDate(record.updatedAt);
  tile.appendChild(date);

  const select = () => {
    selectCard(state, record.key);
  };
  tile.addEventListener("click", select);
  tile.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (isIMEComposing(e)) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select();
    }
  });
  return tile;
}

function buildDetailPlaceholder(state: WordCardsTabState): HTMLElement {
  const hint = el(state.doc, "div", `${CLS}-hint`);
  hint.textContent = getString("wordcards-detail-empty");
  return hint;
}

/**
 * Speak-button labels track playback: the active kind shows "stop", the
 * other (and an idle speaker) its verb. No-op once the tab is closing or
 * replaced — stop() fires onChange during destroyTab.
 */
function updateSpeakButtons(state: WordCardsTabState): void {
  if (state.closing || activeTab !== state) return;
  const active = state.speaker?.playingKind() ?? null;
  const apply = (
    btn: HTMLButtonElement | null,
    kind: SpeechKind,
    idleKey: string,
  ): void => {
    if (!btn) return;
    const speaking = active === kind;
    btn.textContent = getString(speaking ? "wordcards-stop" : idleKey);
    btn.classList.toggle(`${CLS}-btn-speaking`, speaking);
  };
  apply(state.speakBtn, "word", "wordcards-speak");
  apply(state.examplesBtn, "examples", "wordcards-speak-examples");
}

function buildDetail(
  state: WordCardsTabState,
  record: WordCardRecord,
): HTMLElement {
  // This column was just rebuilt: stale button refs from the previous card
  // would point at detached nodes.
  state.speakBtn = null;
  state.examplesBtn = null;
  const box = el(state.doc, "div", `${CLS}-d`);
  const content: DictionaryCardContent = record.latest;

  const head = el(state.doc, "div", `${CLS}-d-head`);
  const wordEl = el(state.doc, "span", `${CLS}-d-word`);
  wordEl.textContent = record.word;
  head.appendChild(wordEl);
  if (content.phonetic) {
    const phonetic = el(state.doc, "span", `${CLS}-d-phonetic`);
    phonetic.textContent = content.phonetic;
    head.appendChild(phonetic);
  }
  box.appendChild(head);

  for (const sense of content.senses) {
    const line = el(state.doc, "div", `${CLS}-d-sense`);
    if (sense.pos) {
      const pos = el(state.doc, "span", `${CLS}-d-pos`);
      pos.textContent = sense.pos;
      line.appendChild(pos);
    }
    const meaning = el(state.doc, "span");
    meaning.textContent = sense.meaning;
    line.appendChild(meaning);
    box.appendChild(line);
    if (sense.example) {
      const example = el(state.doc, "div", `${CLS}-d-example`);
      example.textContent = sense.example;
      box.appendChild(example);
      if (sense.exampleTranslation) {
        const exampleTrans = el(state.doc, "div", `${CLS}-d-example-trans`);
        exampleTrans.textContent = sense.exampleTranslation;
        box.appendChild(exampleTrans);
      }
    }
  }

  for (const pair of content.examples ?? []) {
    const example = el(state.doc, "div", `${CLS}-d-example`);
    example.textContent = pair.text;
    box.appendChild(example);
    const exampleTrans = el(state.doc, "div", `${CLS}-d-example-trans`);
    exampleTrans.textContent = pair.translation;
    box.appendChild(exampleTrans);
  }

  // In-text contexts, newest first — the sentences this word was met in.
  // Clicking one jumps back to the source location in the reader.
  const contexts = sanitizeContexts(record.contexts);
  if (contexts.length) {
    const ctxTitle = el(state.doc, "div", `${CLS}-d-section`);
    ctxTitle.textContent = getString("wordcards-contexts");
    box.appendChild(ctxTitle);
    for (const context of contexts) {
      box.appendChild(buildContextRow(state, context));
    }
  }

  // Lookup history, newest first — the same card across time and languages.
  const historyTitle = el(state.doc, "div", `${CLS}-d-section`);
  historyTitle.textContent = getString("wordcards-history");
  box.appendChild(historyTitle);
  for (const entry of record.history) {
    const line = el(state.doc, "div", `${CLS}-d-history`);
    const time = el(state.doc, "span", `${CLS}-d-history-time`);
    time.textContent = cardDate(entry.at);
    line.appendChild(time);
    const firstMeaning = entry.content?.senses?.[0]?.meaning ?? "";
    line.appendChild(
      state.doc.createTextNode(firstMeaning || entry.targetLang),
    );
    box.appendChild(line);
  }

  const actions = el(state.doc, "div", `${CLS}-d-actions`);
  const meta = el(state.doc, "span", `${CLS}-d-meta`);
  meta.textContent = getString(`pane-translate-card-source-${content.source}`);
  actions.appendChild(meta);
  // 朗读 / 朗读例句 — rendered only where the window can speak at all; the
  // examples button additionally needs at least one example sentence.
  if (state.speaker?.isSupported()) {
    const speakBtn = el(state.doc, "button", `${CLS}-btn`) as HTMLButtonElement;
    speakBtn.type = "button";
    speakBtn.addEventListener("click", () => {
      state.speaker?.speakWord(record.word);
    });
    actions.appendChild(speakBtn);
    state.speakBtn = speakBtn;
    if (exampleSegments(content).length > 0) {
      const examplesBtn = el(
        state.doc,
        "button",
        `${CLS}-btn`,
      ) as HTMLButtonElement;
      examplesBtn.type = "button";
      examplesBtn.addEventListener("click", () => {
        state.speaker?.speakExamples(record.word, content);
      });
      actions.appendChild(examplesBtn);
      state.examplesBtn = examplesBtn;
    }
  }
  const copyBtn = el(state.doc, "button", `${CLS}-btn`) as HTMLButtonElement;
  copyBtn.type = "button";
  copyBtn.textContent = getString("pane-translate-copy");
  copyBtn.addEventListener("click", async () => {
    const failure = await copyText(state.doc, flattenCardText(record.latest));
    if (state.closing || activeTab !== state) return;
    if (!failure) {
      copyBtn.textContent = getString("pane-translate-copied");
      if (state.copiedTimer) clearTimeout(state.copiedTimer);
      state.copiedTimer = setTimeout(() => {
        state.copiedTimer = null;
        if (state.closing || activeTab !== state) return;
        copyBtn.textContent = getString("pane-translate-copy");
      }, 2000);
    }
  });
  actions.appendChild(copyBtn);
  const deleteBtn = el(state.doc, "button", `${CLS}-btn`) as HTMLButtonElement;
  deleteBtn.type = "button";
  deleteBtn.textContent = getString("wordcards-delete");
  deleteBtn.addEventListener("click", async () => {
    await deleteWordCard(record.word);
    if (state.closing || activeTab !== state) return;
    state.selectedKey = null;
    await reloadRecords(state);
  });
  actions.appendChild(deleteBtn);
  box.appendChild(actions);
  // Sync labels with any playback that is already running (card switched
  // mid-play); a no-op when idle.
  updateSpeakButtons(state);
  return box;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-text contexts: rendering + jump-back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One in-text context row: the sentence plus its source label (title, page).
 * Clicking — or Enter/Space, the tile pattern — opens the source document's
 * reader at the captured position. The row is a real interactive element so
 * the jump is reachable from the keyboard too.
 */
function buildContextRow(
  state: WordCardsTabState,
  context: WordCardContext,
): HTMLElement {
  const row = el(state.doc, "div", `${CLS}-d-ctx`);
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  const sentence = el(state.doc, "div", `${CLS}-d-ctx-sentence`);
  sentence.textContent = context.sentence;
  row.appendChild(sentence);
  const metaParts: string[] = [];
  if (context.itemTitle) metaParts.push(context.itemTitle);
  if (typeof context.pageIndex === "number") {
    // Stored 0-based, shown as the 1-based physical page number.
    metaParts.push(
      getString("wordcards-context-page", { page: context.pageIndex + 1 }),
    );
  }
  if (metaParts.length) {
    const meta = el(state.doc, "div", `${CLS}-d-ctx-meta`);
    meta.textContent = metaParts.join(" · ");
    row.appendChild(meta);
  }
  const open = () => {
    void openContextLocation(state.win, context);
  };
  row.addEventListener("click", open);
  row.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (isIMEComposing(e)) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return row;
}

/**
 * Which reader document a context's stored itemID resolves to: an attachment
 * item opens itself; a parent item needs its best attachment (async, so the
 * caller resolves it). Pure decision core — tests pass plain objects.
 */
export function resolveJumpTargetKind(item: any): "self" | "best-attachment" | null {
  try {
    if (!item || typeof item !== "object") return null;
    if (typeof item.isAttachment === "function") {
      return item.isAttachment() ? "self" : "best-attachment";
    }
    // Zotero items without a parent carry parentItemID === false.
    if (typeof item.parentItemID === "number") return "self";
    return "best-attachment";
  } catch {
    return null;
  }
}

/**
 * Open (or focus) the reader at a context's captured position. Official
 * surfaces only: Zotero.Reader.open(itemID, location) for closed documents,
 * reader.navigate(location) for open ones (the `_readers` id-match mirrors
 * openReaderForCropping in opendataloaderSplitAdapter — Reader.open resolves
 * undefined for an already-open document). Never throws: a failed jump costs
 * a debug log, not a crash.
 */
async function openContextLocation(
  win: any,
  context: WordCardContext,
): Promise<void> {
  try {
    if (typeof context?.itemID !== "number") return;
    const Zotero = win?.Zotero ?? (globalThis as any)?.Zotero;
    const Items = Zotero?.Items;
    if (!Items?.get) return;
    const item = Items.get(context.itemID);
    if (!item) return;

    let attachmentID: number | null = null;
    if (resolveJumpTargetKind(item) === "self") {
      attachmentID = context.itemID;
    } else {
      const best = await item.getBestAttachment?.();
      if (best?.id != null) attachmentID = best.id;
    }
    if (attachmentID == null) {
      safeDebug(
        "[Z-Transplit] wordCards: context jump skipped — no attachment to open",
      );
      return;
    }

    const location =
      typeof context.pageIndex === "number"
        ? {
            // 只传顶层 pageIndex：真机侦察（Zotero 10.0.3）确认 navigate
            // 的 location 一旦携带 position 字段就进入其内部 position 分支
            // 且不滚动，顶层 pageIndex 随之被忽略；裸 pageIndex 是唯一稳定
            // 生效的页级定位形状。矩形级落点等上游 navigate 支持后再加。
            pageIndex: context.pageIndex,
          }
        : undefined;

    // 已打开的阅读器：字段名跨版本不定（_itemID / itemID / _attachmentId /
    // attachmentID），与 openReaderForCropping 的四字段宽匹配保持一致。
    const readers = Array.isArray(Zotero?.Reader?._readers)
      ? Zotero.Reader._readers
      : [];
    const openReader = readers.find(
      (reader: any) =>
        (reader?._itemID ??
          reader?.itemID ??
          reader?._attachmentId ??
          reader?.attachmentID) === attachmentID,
    );
    if (openReader) {
      const Zotero_Tabs = win?.Zotero_Tabs ?? Zotero?.Tabs;
      if (openReader.tabID && Zotero_Tabs?.select) {
        Zotero_Tabs.select(openReader.tabID);
      }
      // 切 tab 后立即 navigate 不滚动（真机侦察：reader 的视图恢复会吃掉
      // 跟随而来的导航）；等一拍再滚。
      if (location) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await openReader.navigate?.(location);
      }
      return;
    }

    if (typeof Zotero?.Reader?.open !== "function") {
      safeDebug(
        "[Z-Transplit] wordCards: Zotero.Reader.open unavailable — context jump skipped",
      );
      return;
    }
    const opened = await Zotero.Reader.open(attachmentID, location);
    // Reader.open 对已打开的文档返回 undefined 且只聚焦不定位——用 navigate
    // 补一次滚动（兜底，正常路径走上面的 openReader 分支）。
    if (!opened && location) {
      const existing = readers.find(
        (reader: any) =>
          (reader?._itemID ??
            reader?.itemID ??
            reader?._attachmentId ??
            reader?.attachmentID) === attachmentID,
      );
      await existing?.navigate?.(location);
    }
  } catch (e) {
    safeDebug("[Z-Transplit] wordCards: context jump failed: " + e);
  }
}
