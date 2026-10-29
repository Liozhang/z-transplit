/**
 * pageRange — parse the user's page-range input for partial-PDF translation.
 *
 * Accepts single pages ("3"), closed ranges ("1-3"), and comma-separated
 * mixes ("1-3,7,10-12"). Separators tolerate the full-width comma (，、
 * common IME outputs) and the en/em/full-width dash; tokens must still be
 * well-formed — any malformed token rejects the WHOLE input, so a typo can
 * never silently translate the wrong pages. Output is a sorted, de-duplicated
 * 1-based page list; bounds against the document are checked by the caller
 * (which knows the page count).
 */

/** Anything claiming more pages than this in one token is treated as a typo. */
const PAGE_NUMBER_SANITY_MAX = 100000;

export function parsePageRangeSpec(raw: string): number[] | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const normalized = text.replace(/[，、]/g, ",").replace(/[–—－]/g, "-");
  const pages: number[] = [];
  for (const part of normalized.split(",")) {
    const token = part.trim();
    if (!token) return null; // "1,,3" / trailing comma — strict reject
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start) return null;
      if (end > PAGE_NUMBER_SANITY_MAX) return null;
      for (let p = start; p <= end; p++) pages.push(p);
      continue;
    }
    if (!/^\d+$/.test(token)) return null;
    const page = Number(token);
    if (page < 1 || page > PAGE_NUMBER_SANITY_MAX) return null;
    pages.push(page);
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}
