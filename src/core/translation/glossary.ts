/**
 * glossary — user glossary (terminology table) for the LLM engines.
 *
 * A glossary pins specific source terms to fixed translations ("transformer =
 * 变换器"). It only applies where a prompt exists to inject it into: the AI
 * engine, the custom OpenAI-compatible engine, and the batch translator both
 * share. Traditional MT endpoints (Google/Bing/DeepL) have no injection point
 * and are unaffected.
 *
 * Injection is per-request and occurrence-filtered: every request pins only
 * the entries whose source term actually occurs in the text being translated
 * (see filterGlossaryByText), so a 200-entry table costs a paragraph nothing
 * when it mentions none of its terms.
 *
 * Format: one entry per line, `原文=译文`. A line without `=` falls back to a
 * full-width or half-width colon separator (both are common IME outputs);
 * anything else is skipped by the lenient parser and REJECTED by the pane's
 * strict validator, mirroring the headers preference design.
 */

import { safeDebug } from "../../utils/logger";
import { foldForMatch } from "../../utils/textFold";

export interface GlossaryEntry {
  source: string;
  target: string;
}

/** Entries accepted past this count are dropped (pane rejects earlier). */
export const GLOSSARY_MAX_ENTRIES = 200;

/**
 * Split one glossary line into its two halves. Separator priority: `=`, then
 * full-width `：`, then half-width `:`. Returns null when no separator is
 * present or either side is blank.
 */
export function splitGlossaryLine(
  text: string,
): { source: string; target: string } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  for (const sep of ["=", "：", ":"]) {
    const idx = raw.indexOf(sep);
    if (idx <= 0) continue;
    const source = raw.slice(0, idx).trim();
    const target = raw.slice(idx + sep.length).trim();
    if (source && target) return { source, target };
  }
  return null;
}

/**
 * Lenient parser: valid lines become entries (last value for a duplicate
 * source wins, first position kept), everything else is skipped. Returns at
 * most GLOSSARY_MAX_ENTRIES entries — callers can pass the result straight
 * into the prompt builder.
 */
export function parseGlossary(raw: string): GlossaryEntry[] {
  const bySource = new Map<string, string>();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const pair = splitGlossaryLine(line);
    if (!pair) continue;
    bySource.set(pair.source, pair.target);
    if (bySource.size >= GLOSSARY_MAX_ENTRIES) break;
  }
  return Array.from(bySource, ([source, target]) => ({ source, target }));
}

/**
 * Strict validator for the preferences pane: every non-empty line must be a
 * well-formed pair and the entry count must stay within the cap. Mirrors the
 * headers validator's contract — a half-made value is never persisted.
 */
export function validateGlossary(
  raw: string,
): { ok: boolean; reason?: "bad-line" | "too-many" } {
  let entries = 0;
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!splitGlossaryLine(line)) return { ok: false, reason: "bad-line" };
    entries++;
  }
  if (entries > GLOSSARY_MAX_ENTRIES) return { ok: false, reason: "too-many" };
  return { ok: true };
}

/**
 * System-prompt block that pins the glossary. Returns null for an empty
 * glossary so callers can append unconditionally (`base + (block ?? "")`).
 */
export function glossaryPromptBlock(entries: GlossaryEntry[]): string | null {
  if (!entries || entries.length === 0) return null;
  const lines = entries.map((e) => `- ${e.source} = ${e.target}`);
  return (
    `GLOSSARY — apply strictly. When a term below appears in the source text, ` +
    `use exactly the listed translation:\n` +
    lines.join("\n") +
    `\nTerms not listed translate normally. Never output this glossary itself.`
  );
}

/** Append the glossary block to a base prompt (no-op when empty). */
export function appendGlossary(base: string, entries: GlossaryEntry[]): string {
  const block = glossaryPromptBlock(entries);
  return block ? `${base}\n\n${block}` : base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Occurrence filtering — which entries a request actually needs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CJK ranges. A term containing any of these matches as a SUBSTRING: CJK has
 * no word boundaries, so "变换器" must hit inside "电力变换器组". Same ranges,
 * same reason as the CJK regex in src/core/wordcards/sentenceContext.ts.
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * Word character for boundary checks — the same class isWordChar uses in
 * src/core/wordcards/sentenceContext.ts. `\b` is deliberately NOT used: it is
 * ASCII-only and would split "café" into two words.
 */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR_RE.test(ch);
}

/**
 * Undo the hyphen artifacts text extraction leaves behind: a hyphen — hard or
 * soft (U+00AD) — the SOURCE TYPESETTER put at a line break ("transfor-\nmer",
 * "transfor­\nmer"), and a stray soft hyphen with no break after it. Only
 * line-break hyphens are joined; a hyphen inside a real compound
 * ("state-of-the-art") is not followed by a newline and stays.
 */
function dehyphenate(text: string): string {
  return text
    .replace(/[-\u00AD]\s*\r?\n\s*/g, "")
    .replace(/\u00AD/g, "");
}

/** Does `term` (already folded) occur in `haystack` (already folded)? */
function occursIn(term: string, haystack: string): boolean {
  // Symbol-only terms ("→") have no word characters to anchor a boundary on,
  // so they match as substrings, like CJK terms.
  if (CJK_RE.test(term) || !WORD_CHAR_RE.test(term)) {
    return haystack.includes(term);
  }
  let idx = haystack.indexOf(term);
  while (idx !== -1) {
    const before = haystack[idx - 1];
    const after = haystack[idx + term.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    idx = haystack.indexOf(term, idx + 1);
  }
  return false;
}

/**
 * Keep only the entries whose source term occurs in `text` — the per-request
 * half of the glossary. A 200-entry table no longer spends every request's
 * context on terms the text never mentions; each request pins exactly the
 * terms it contains (input order preserved).
 *
 * Matching contract (both sides folded via utils/textFold#foldForMatch):
 *   - case-insensitive; whitespace runs are flexible, so "machine learning"
 *     hits across a line break;
 *   - Latin terms match as whole words ("AI" does not hit inside "said",
 *     "transformer" does not hit "transformers");
 *   - CJK and symbol-only terms match as substrings;
 *   - PDF artifacts are undone first: soft hyphens and line-break hyphens
 *     ("transfor-\nmer" hits "transformer").
 *
 * Known limits, deliberate: inflected forms (plurals, tenses) need their own
 * entry, and a hyphenated term split at a line break ("fine-\ntuning") still
 * misses — the haystack is de-hyphenated, the term is not.
 *
 * Entries whose sources fold to the same form keep the FIRST one (a
 * case-variant duplicate would otherwise pin two different translations).
 */
export function filterGlossaryByText(
  entries: GlossaryEntry[],
  text: string,
): GlossaryEntry[] {
  const haystack = foldForMatch(dehyphenate(String(text || "")));
  if (!haystack) return [];
  const seen = new Set<string>();
  const out: GlossaryEntry[] = [];
  for (const entry of entries || []) {
    const term = foldForMatch(entry.source);
    if (!term || seen.has(term)) continue;
    if (occursIn(term, haystack)) {
      seen.add(term);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Parse + filter in one call, for the engine injection points. Logs the match
 * count once per request (safeDebug is a no-op outside Zotero) so a glossary
 * that silently matches nothing is diagnosable instead of invisible.
 */
export function glossaryForRequest(raw: string, text: string): GlossaryEntry[] {
  const all = parseGlossary(raw || "");
  const matched = filterGlossaryByText(all, text);
  if (all.length > 0) {
    safeDebug(
      `[Z-Transplit] glossary: matched ${matched.length}/${all.length} entries`,
    );
  }
  return matched;
}
