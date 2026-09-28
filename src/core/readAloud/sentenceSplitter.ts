/**
 * sentenceSplitter — sentence segmentation for the read-aloud engine.
 *
 * Two implementations with one contract:
 *   - Intl.Segmenter (granularity "sentence") where available — Gecko 125+,
 *     i.e. Zotero 10's runtime;
 *   - a bounded regex fallback for Zotero 7's Gecko 115, with an abbreviation
 *     guard so "e.g." / "et al." / "Fig." don't terminate sentences.
 *
 * Both return spans aligned to the SAME input string (start/end are character
 * offsets into `text`), so callers can highlight the exact source slice.
 *
 * @module core/readAloud/sentenceSplitter
 */

export interface SentenceSpan {
  start: number;
  end: number;
  text: string;
}

/** Abbreviations that must NOT end a sentence (regex-fallback guard). */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "et al", "al", "cf", "vs", "ca", "no", "Nos", "Vol",
  "pp", "p", "Fig", "Figs", "Tab", "Eq", "Eqs", "Sec", "Ref", "Refs", "Dr",
  "Prof", "Mr", "Mrs", "Ms", "Jr", "Sr", "St", "approx", "dept", "univ",
]);

function isAbbreviationBreak(text: string, end: number): boolean {
  // `end` is the index AFTER the terminator (and its trailing whitespace —
  // the split regex consumes "\s*"). Walk back over that whitespace first.
  let e = end - 1;
  while (e >= 0 && /\s/.test(text[e])) e--;
  if (e < 0 || text[e] !== ".") return false;
  // Walk back over the word directly before the period.
  let i = e - 1;
  let word = "";
  while (i >= 0 && /[A-Za-z]/.test(text[i])) {
    word = text[i] + word;
    i--;
  }
  if (!word) return false;
  // Single-letter initials ("e.g." → break after "e.", "g."; "J. Smith").
  if (/^[A-Za-z]$/.test(word)) return true;
  return ABBREVIATIONS.has(word);
}

function splitByRegex(text: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  const re = /[^.!?。！？\n]*[.!?。！？]+["'”’)\]]*\s*|[^.!?。！？\n]+$/g;
  let spanStart: number | null = null;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const endsSentence = /[.!?。！？]/.test(match[0]);
    // An abbreviation break ("… e.g. this …") keeps the current span open.
    const abbrev = endsSentence && isAbbreviationBreak(text, end);
    if (spanStart === null) spanStart = start;
    if (abbrev) continue;
    const slice = text.slice(spanStart, end);
    if (slice.trim()) out.push({ start: spanStart, end, text: slice });
    spanStart = null;
  }
  if (spanStart !== null) {
    const slice = text.slice(spanStart);
    if (slice.trim()) out.push({ start: spanStart, end: text.length, text: slice });
  }
  return out;
}

function splitBySegmenter(text: string): SentenceSpan[] {
  const Segmenter = (globalThis as any).Intl?.Segmenter;
  if (typeof Segmenter !== "function") return splitByRegex(text);
  const seg = new Segmenter(undefined, { granularity: "sentence" });
  const out: SentenceSpan[] = [];
  let cursor = 0;
  for (const part of seg.segment(text) as Iterable<{ segment: string; index: number }>) {
    const start = part.index;
    // Guard against implementations that skip ahead (shouldn't happen).
    const spanStart = Math.max(start, cursor);
    const end = spanStart + part.segment.length;
    cursor = end;
    if (part.segment.trim()) {
      out.push({ start: spanStart, end, text: part.segment });
    }
  }
  return out;
}

/**
 * Split `text` into sentence spans. Whitespace-only tails are dropped; the
 * concatenation of spans is NOT guaranteed to equal `text` (leading/trailing
 * whitespace between sentences is attached to the preceding sentence).
 */
export function splitSentences(text: string): SentenceSpan[] {
  if (!text || !text.trim()) return [];
  const spans = splitBySegmenter(text);
  // Sanity: if the segmenter produced one giant sentence for a long input,
  // fall back to the regex splitter which is more aggressive on terminators.
  if (spans.length === 1 && text.length > 400) return splitByRegex(text);
  return spans;
}
