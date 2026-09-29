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
} from "../core/wordcards/wordCardStore";
import type { WordCardRecord } from "../core/wordcards/wordCardStore";
import type { DictionaryCardContent } from "../core/translation/types";

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
  height: 100%; min-height: 0; box-sizing: border-box;
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
    const { id, container } = Zotero_Tabs.add({
      id: WORDCARDS_TAB_ID,
      type: WORDCARDS_TAB_ID,
      title: getString("wordcards-tab-title"),
      select: true,
      onClose: () => destroyTab(),
    });
    void mountTab(win, id, container);
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
  };
  activeTab = state;

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
    state.selectedKey = record.key;
    render(state);
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

function buildDetail(
  state: WordCardsTabState,
  record: WordCardRecord,
): HTMLElement {
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
  return box;
}
