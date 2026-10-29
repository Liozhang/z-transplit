/**
 * glossary — user glossary (terminology table) for the LLM engines.
 *
 * A glossary pins specific source terms to fixed translations ("transformer =
 * 变换器"). It only applies where a prompt exists to inject it into: the AI
 * engine, the custom OpenAI-compatible engine, and the batch translator both
 * share. Traditional MT endpoints (Google/Bing/DeepL) have no injection point
 * and are unaffected.
 *
 * Format: one entry per line, `原文=译文`. A line without `=` falls back to a
 * full-width or half-width colon separator (both are common IME outputs);
 * anything else is skipped by the lenient parser and REJECTED by the pane's
 * strict validator, mirroring the headers preference design.
 */

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
