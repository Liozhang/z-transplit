/**
 * sentenceContext — extract the sentence a looked-up word appeared in, from
 * the reader's own PDF page text.
 *
 * Inputs are the pieces a dictionary lookup already has at hand: the reader
 * instance, the word, and the selection position ({pageIndex, rects}) that
 * Zotero's 「renderTextSelectionPopup」 annotation carries (see translatePane's
 * selection sync). The module is deliberately two-layered:
 *
 *   - Pure geometry/text logic (groupItemsIntoLines → linesForSelection →
 *     joinLinesToText → pickSentence → sentenceFromItems) runs on plain
 *     objects, so the whole extraction is unit-testable in Node without
 *     Zotero or pdf.js.
 *   - One host function (captureSentenceContext) bridges into the content
 *     realm — the same wrappedJSObject unwrap chain pdfReaderTts uses — and
 *     degrades to null on every failure shape. A context is a bonus for the
 *     word card, never a precondition of the lookup: any throw, missing
 *     viewer, or scan-only page results in "no context this time".
 *
 * Geometry assumptions (pdf.js text content and Zotero PDF annotation
 * positions share unrotated PDF user space: origin bottom-left, y grows
 * upward):
 *   - text items carry transform[4]/[5] = x / baseline-y, plus width;
 *   - selection rects are [x1, y1, x2, y2] with axis order normalized here.
 * Rotation or exotic layouts can break line matching; the whole-page text
 * fallback then still locates the word, and if that fails too the capture
 * simply returns null.
 *
 * @module core/wordcards/sentenceContext
 */

import { safeDebug } from "../../utils/logger";
import { splitSentences } from "../readAloud/sentenceSplitter";

/** Cap on one stored sentence — review display text, not a document quote. */
export const SENTENCE_MAX_CHARS = 500;

/** Baseline-y tolerance when clustering text items into one line (pt). */
export const LINE_Y_TOLERANCE = 3;

/** x-overlap slack when deciding whether a line shares the selection's column (pt). */
const COLUMN_X_TOLERANCE = 6;

/** Vertical gap (× median line gap) above which two lines are separate paragraphs. */
const PARAGRAPH_GAP_FACTOR = 2;

/** Manual sentence-expansion budget (chars) when the splitter's spans miss. */
const FALLBACK_EXPANSION_CHARS = 400;

/** CJK range check — CJK "words" match as substrings (no word boundaries). */
const CJK_RE =
  /[\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

/** Structural subset of a pdf.js text content item that the logic reads. */
export interface PdfTextItem {
  str?: string;
  /** pdf.js transform matrix; [4] = x, [5] = baseline y (user space). */
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

/** One visual line: baseline y, x-extent, joined text. */
export interface PdfTextLine {
  y: number;
  xMin: number;
  xMax: number;
  text: string;
}

/** Selection position shape as carried by Zotero PDF annotation positions. */
export interface SelectionPositionLike {
  pageIndex: number;
  rects?: number[][];
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching normalization
// ─────────────────────────────────────────────────────────────────────────────

/** Ligature expansions so "ﬁx" still matches "fix". */
const LIGATURES: Record<string, string> = {
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬀ": "ff",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
};

/**
 * Match form: lowercase, apostrophes unified, ligatures expanded, whitespace
 * collapsed. Used for containment checks (span/whole-text), never for index
 * math — slicing always happens on the original string.
 */
export function normalizeForMatch(text: string): string {
  let out = "";
  for (const ch of text || "") {
    const expansion = LIGATURES[ch];
    out += expansion !== undefined ? expansion.toLowerCase() : ch.toLowerCase();
  }
  return out.replace(/['’]/g, "'").replace(/\s+/g, " ").trim();
}

/** Is the char at either side of a raw-text match a letter/digit/underscore? */
function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure pipeline
// ─────────────────────────────────────────────────────────────────────────────

/** Join one line's x-sorted item strings; spaces only between Latin-ish runs. */
function joinItemsOfLine(strs: string[]): string {
  let text = "";
  for (const str of strs) {
    if (!str) continue;
    if (
      text &&
      /[\p{L}\p{N}]$/u.test(text) &&
      /^[\p{L}\p{N}]/u.test(str)
    ) {
      // pdf.js splits runs without spaces sometimes; CJK runs stay untouched.
      text += " ";
    }
    text += str;
  }
  return text;
}

/**
 * Cluster text items into visual lines by baseline y (± LINE_Y_TOLERANCE),
 * items sorted by x inside each line, lines top-first (PDF y grows upward).
 * Items without a usable transform or with empty text are skipped.
 */
export function groupItemsIntoLines(items: PdfTextItem[]): PdfTextLine[] {
  type Pending = { x: number; y: number; w: number; str: string };
  const pending: Pending[] = [];
  for (const item of items ?? []) {
    const str = typeof item?.str === "string" ? item.str : "";
    if (!str.trim()) continue;
    const t = item.transform;
    if (!Array.isArray(t) || !Number.isFinite(t[4]) || !Number.isFinite(t[5])) {
      continue;
    }
    pending.push({
      x: t[4],
      y: t[5],
      w: Number.isFinite(item.width) ? (item.width as number) : 0,
      str,
    });
  }
  if (!pending.length) return [];
  pending.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: PdfTextLine[] = [];
  let cluster: Pending[] = [];
  let clusterY = Number.NaN;
  const flush = () => {
    if (!cluster.length) return;
    cluster.sort((a, b) => a.x - b.x);
    lines.push({
      y: clusterY,
      xMin: Math.min(...cluster.map((p) => p.x)),
      xMax: Math.max(...cluster.map((p) => p.x + p.w)),
      text: joinItemsOfLine(cluster.map((p) => p.str)),
    });
    cluster = [];
  };
  for (const p of pending) {
    if (!Number.isFinite(clusterY) || Math.abs(p.y - clusterY) > LINE_Y_TOLERANCE) {
      flush();
      clusterY = p.y;
    }
    cluster.push(p);
  }
  flush();
  return lines;
}

/** Normalize a rect's axis order (producers vary) → [xLo, yLo, xHi, yHi]. */
function normalizeRect(rect: unknown): [number, number, number, number] | null {
  if (!Array.isArray(rect) || rect.length < 4) return null;
  if (!(rect as unknown[]).every(Number.isFinite)) return null;
  const r = rect as number[];
  return [
    Math.min(r[0], r[2]),
    Math.min(r[1], r[3]),
    Math.max(r[0], r[2]),
    Math.max(r[1], r[3]),
  ];
}

/**
 * Keep only items whose x-extent overlaps a selection rect's x-range. Done
 * BEFORE line clustering: on two-column pages the two columns share the same
 * baselines, so a plain y-cluster would fuse both columns into one line and
 * defeat every later x-filter. A full-width line (title spanning both
 * columns) still overlaps and stays — its vertical distance to the paragraph
 * is handled by the paragraph-gap rule.
 */
export function itemsForSelection(
  items: PdfTextItem[],
  rects?: number[][],
): PdfTextItem[] {
  const normalized = (rects ?? [])
    .map(normalizeRect)
    .filter((r): r is [number, number, number, number] => !!r);
  if (!normalized.length) return items;
  return (items ?? []).filter((item) => {
    const t = item?.transform;
    if (!Array.isArray(t) || !Number.isFinite(t[4])) return false;
    const xLo = t[4] - COLUMN_X_TOLERANCE;
    const xHi = t[4] + (Number.isFinite(item.width) ? (item.width as number) : 0) + COLUMN_X_TOLERANCE;
    return normalized.some(([rxLo, , rxHi]) => xLo <= rxHi && xHi >= rxLo);
  });
}

/**
 * Lines overlapping any selection rect in y AND x. The x filter keeps the
 * matches inside the selection's column on two-column layouts.
 */
export function linesForSelection(
  lines: PdfTextLine[],
  rects?: number[][],
): PdfTextLine[] {
  const normalized = (rects ?? [])
    .map(normalizeRect)
    .filter((r): r is [number, number, number, number] => !!r);
  if (!normalized.length) return [];
  return lines.filter((line) =>
    normalized.some(
      ([xLo, yLo, xHi, yHi]) =>
        line.y >= yLo - LINE_Y_TOLERANCE &&
        line.y <= yHi + LINE_Y_TOLERANCE &&
        line.xMin <= xHi + COLUMN_X_TOLERANCE &&
        line.xMax >= xLo - COLUMN_X_TOLERANCE,
    ),
  );
}

/**
 * Join lines into display text. Consecutive close lines merge into one
 * paragraph; a vertical gap beyond PARAGRAPH_GAP_FACTOR × the median line
 * gap starts a new paragraph (emitted as "\n", a hard boundary for the
 * sentence splitter). A line ending in "-" followed by a lowercase letter is
 * a hyphenated word split across lines → join without the hyphen.
 */
export function joinLinesToText(lines: PdfTextLine[]): string {
  if (!lines.length) return "";
  // Line-height proxy: the lower quartile of positive line gaps — body text
  // dominates that band, while superscripts and footnotes (tighter) and
  // paragraph breaks (wider) stay out of the estimate.
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y; // positive when reading top→bottom
    if (gap > 0.5) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const lineHeight = gaps.length ? gaps[Math.floor((gaps.length - 1) * 0.25)] : 0;
  const paragraphBreak =
    lineHeight > 0 ? lineHeight * PARAGRAPH_GAP_FACTOR : Number.POSITIVE_INFINITY;

  let text = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0) {
      const gap = lines[i - 1].y - line.y;
      if (gap > paragraphBreak) {
        text += "\n";
      } else if (text.endsWith("-") && /^\p{Ll}/u.test(line.text)) {
        text = text.slice(0, -1); // hyphenated line break: "pa-" + "perwork"
      } else {
        text += " ";
      }
    }
    text += line.text;
  }
  return text;
}

/**
 * Pick the sentence containing `word` from `text`. Primary: splitSentences
 * spans (abbreviation-aware). `anchorLines` — the text of the lines the
 * selection actually covered — breaks ties when the word occurs several
 * times on the page: the sentence overlapping the most anchor lines wins,
 * so the selected occurrence is extracted, not the first one in the text
 * stream. Fallback: manual terminator scan around the first raw-text match.
 * Returns null when the word is not in the text at all.
 */
export function pickSentence(
  text: string,
  word: string,
  anchorLines?: string[],
): string | null {
  if (!text || !word) return null;
  const wordForm = normalizeForMatch(word);
  if (!wordForm) return null;

  const anchors = (anchorLines ?? [])
    .map((line) => normalizeForMatch(line))
    .filter((line) => line.length > 0);
  // Word-level overlap: a VISUAL line routinely spans a sentence boundary
  // (previous sentence's tail + next one's head), so "sentence contains the
  // whole line" almost never fires. Counting how many anchor words a
  // sentence covers is the robust tiebreak; words under 3 chars (of, the,
  // in…) carry no signal and are dropped.
  const anchorWords = Array.from(
    new Set(anchors.flatMap((a) => a.split(" ")).filter((w) => w.length >= 3)),
  );
  let best: { sentence: string; covered: number } | null = null;
  for (const span of splitSentences(text)) {
    const sentence = text.slice(span.start, span.end).trim();
    if (!sentence || !normalizeForMatch(sentence).includes(wordForm)) continue;
    if (!anchors.length) return sentence.slice(0, SENTENCE_MAX_CHARS);
    const sentenceForm = normalizeForMatch(sentence);
    const covered = anchorWords.filter((w) => sentenceForm.includes(w)).length;
    if (!best || covered > best.covered) {
      best = { sentence: sentence.slice(0, SENTENCE_MAX_CHARS), covered };
    }
  }
  if (best) return best.sentence;
  if (!anchors.length) return expandAroundRawMatch(text, word);
  // Anchored page: no split span overlapped the anchor lines — try the raw
  // scan around each anchor line's first occurrence before giving up.
  for (const anchor of anchorLines ?? []) {
    const at = text.indexOf(anchor);
    if (at >= 0) {
      const hit = expandAroundRawMatch(text.slice(0, at + anchor.length + FALLBACK_EXPANSION_CHARS), word);
      if (hit && normalizeForMatch(hit).includes(wordForm)) return hit;
    }
  }
  return expandAroundRawMatch(text, word);
}

/**
 * Fallback sentence extraction: case-folded (and apostrophe-folded) index of
 * the word in the raw text, then scan outward for sentence terminators or
 * paragraph breaks. Lowercasing keeps 1:1 indices for ordinary scripts, so
 * the raw slice is exact enough for boundary detection.
 */
function expandAroundRawMatch(text: string, word: string): string | null {
  const fold = (s: string): string => s.toLowerCase().replace(/['’]/g, "'");
  const haystack = fold(text);
  const needle = fold(word);
  if (!needle) return null;
  const cjk = CJK_RE.test(word);

  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const before = at > 0 ? haystack[at - 1] : "";
    const after = at + needle.length < haystack.length ? haystack[at + needle.length] : "";
    if (cjk || (!isWordChar(before) && !isWordChar(after))) break;
    at = haystack.indexOf(needle, at + 1);
  }
  if (at < 0) return null;

  // Backward: stop at a terminator, paragraph break, or the budget.
  let start = Math.max(0, at - FALLBACK_EXPANSION_CHARS);
  for (let i = at - 1; i >= start; i--) {
    const ch = text[i];
    if (ch === "\n" || /[.!?。！？]/.test(ch)) {
      start = i + 1;
      break;
    }
  }
  // Forward: include the terminator and any closing quotes/brackets.
  const limit = Math.min(text.length, at + needle.length + FALLBACK_EXPANSION_CHARS);
  let end = limit;
  for (let i = at + needle.length; i < limit; i++) {
    const ch = text[i];
    if (ch === "\n") {
      end = i;
      break;
    }
    if (/[.!?。！？]/.test(ch)) {
      end = i + 1;
      while (end < limit && /["'”’)\]]/.test(text[end])) end++;
      break;
    }
  }
  const sentence = text.slice(start, end).trim();
  return sentence ? sentence.slice(0, SENTENCE_MAX_CHARS) : null;
}

/** Lines sharing the matched lines' x-span (± tolerance) — same column. */
function columnAround(all: PdfTextLine[], matched: PdfTextLine[]): PdfTextLine[] {
  const xLo = Math.min(...matched.map((l) => l.xMin)) - COLUMN_X_TOLERANCE;
  const xHi = Math.max(...matched.map((l) => l.xMax)) + COLUMN_X_TOLERANCE;
  const column = all.filter((l) => l.xMax >= xLo && l.xMin <= xHi);
  return column.length ? column : matched;
}

/**
 * Pure entry point: page text items + selection position + word → sentence,
 * or null. Primary path: with rects, items are x-scoped to the selection's
 * column(s) before clustering (see itemsForSelection) and the matching lines
 * feed the join. When the rects match nothing (rotated pages, odd geometry)
 * or the word is not in the scoped text, the whole page's lines are retried.
 */
export function sentenceFromItems(
  items: PdfTextItem[],
  position: SelectionPositionLike,
  word: string,
): string | null {
  const rects =
    Array.isArray(position?.rects) && position.rects.length > 0
      ? position.rects
      : undefined;
  if (rects) {
    const scoped = groupItemsIntoLines(itemsForSelection(items, rects));
    const matched = linesForSelection(scoped, rects);
    if (matched.length) {
      const sentence = pickSentence(
        joinLinesToText(columnAround(scoped, matched)),
        word,
        // The lines the selection actually covered — the sentence-overlap
        // tiebreak extracts the selected occurrence, not the first one.
        matched.map((l) => l.text),
      );
      if (sentence) return sentence;
    }
  }
  const lines = groupItemsIntoLines(items);
  if (!lines.length) return null;
  return pickSentence(joinLinesToText(lines), word);
}

// ─────────────────────────────────────────────────────────────────────────────
// Host access — content-realm reader bridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the pdf.js viewer application for a reader instance. Same unwrap
 * chain as pdfReaderTts#viewerApp (kept local rather than exported across
 * feature domains, matching this codebase's small-defensive-duplicate norm;
 * PDFViewerApplication is a content-realm window global hidden behind the
 * Xray — direct access returns undefined).
 */
function viewerApp(reader: any): any {
  try {
    const internal = reader?._internalReader ?? reader;
    const primaryView = internal?._primaryView;
    const iframeWin = primaryView?._iframeWindow;
    const raw = iframeWin?.wrappedJSObject ?? iframeWin;
    return raw?.PDFViewerApplication ?? null;
  } catch {
    return null;
  }
}

export interface CapturedSentenceContext {
  sentence: string;
  pageIndex: number;
  rects?: number[][];
}

/**
 * Extract the sentence around `word` on the page `position` points at.
 * Resolves null (never throws) whenever anything is missing: no viewer, no
 * text layer (scanned page), a bad position, or the word not found in the
 * page text.
 */
export async function captureSentenceContext(
  reader: any,
  word: string,
  position: SelectionPositionLike | null | undefined,
): Promise<CapturedSentenceContext | null> {
  try {
    const normalized = (word || "").replace(/\s+/g, " ").trim();
    if (
      !reader ||
      !normalized ||
      !position ||
      !Number.isFinite(position.pageIndex) ||
      position.pageIndex < 0
    ) {
      return null;
    }
    const app = viewerApp(reader);
    const pdfViewer = app?.pdfViewer;
    if (!pdfViewer) return null;
    // getPage lives on the PDFDocumentProxy, not the viewer (pdfReaderTts).
    const pdfDocument = pdfViewer.pdfDocument || app.pdfDocument;
    if (!pdfDocument?.getPage) return null;
    const pageIndex = position.pageIndex;
    const numPages = Number(pdfDocument.numPages);
    if (Number.isFinite(numPages) && pageIndex + 1 > numPages) return null;
    const page = await pdfDocument.getPage(pageIndex + 1);
    const rawPage = page?.wrappedJSObject ?? page;
    if (!rawPage?.getTextContent) return null;
    const content = await rawPage.getTextContent();
    const rawContent = content?.wrappedJSObject ?? content;
    const items = rawContent?.items?.wrappedJSObject ?? rawContent?.items;
    if (!Array.isArray(items)) return null;
    const sentence = sentenceFromItems(
      items as PdfTextItem[],
      position,
      normalized,
    );
    if (!sentence) return null;
    return {
      sentence,
      pageIndex,
      rects: Array.isArray(position.rects)
        ? (position.rects as number[][])
        : undefined,
    };
  } catch (e) {
    safeDebug("[Z-Transplit] sentenceContext: capture failed: " + e);
    return null;
  }
}
