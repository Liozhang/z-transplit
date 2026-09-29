/**
 * youdaoDict — keyless Youdao web-dictionary lookup (dict.youdao.com/jsonapi).
 *
 * Same risk class as the keyless Bing web endpoint in translationEngines.ts:
 * an unofficial, reverse-engineered endpoint that can change or vanish without
 * notice. The contract here is therefore deliberately one-way: resolve to a
 * card on success, to null on ANY shape mismatch or network failure — the
 * caller (dictionaryCard.ts) silently degrades to its next layer. Nothing in
 * this module throws.
 *
 * Verified against the live endpoint (2026-09-29):
 *   en: https://dict.youdao.com/jsonapi?s=dict&q=resonance&le=eng
 *     → simple.word[0].usphone "ˈrezənəns",
 *       ec.word[0].trs[0].tr[0].l.i ["n. （声音的）深沉，洪亮；…"],
 *       blng_sents_part.sentence-pair[{sentence-eng, sentence-translation}]
 *   fr: …&le=fr → fc.word[0].phone "bɔ̃ʒu:r", fc.word[0].trs (POS "m."),
 *       same blng_sents_part shape
 *   de: …&le=de → thin multle-only entry (one bare meaning, no phonetic/POS)
 * Branch names vary with the source language (ec 英汉 / fc 法汉 / dc 德汉 /
 * jc 日汉 / kc 韩汉 / multle 多语), so the parser scans every `*.word[0]`
 * branch for `trs` instead of hardcoding `ec` — one shape, many languages.
 */

import { abortSignalTimeout } from "../../utils/abort";
import { safeDebug } from "../../utils/logger";
import { toErrorMessage } from "../../utils/error";
import type {
  DictionaryCardContent,
  DictionarySense,
} from "./types";

/** Keyless endpoint — fail fast so the chain can degrade (see Bing web). */
const YOUDAO_TIMEOUT_MS = 10000;

/** Card-level bilingual example pairs kept from blng_sents_part. */
const MAX_EXAMPLES = 2;

/** Senses kept per card (a long tail adds noise, not information). */
const MAX_SENSES = 8;

/**
 * `le` (language edition) candidates by script of the source word. Kana and
 * Hangul map to their single edition; everything else is treated as Latin
 * script and tried against the two editions with substantial dictionaries.
 * German/Russian etc. editions are thin today — the model layer covers those
 * pairs with a full card instead.
 */
function leCandidates(word: string): string[] {
  if (/[\u3040-\u30FF]/.test(word)) return ["jp"];
  if (/[\uAC00-\uD7AF]/.test(word)) return ["ko"];
  return ["eng", "fr"];
}

/**
 * Caller abort + timeout. AbortSignal.any exists on newer Gecko only (Firefox
 * 124+; Zotero 7.0 ships ESR 115), so fall back to the caller's signal alone —
 * losing the timeout is safe because a superseded request's result is ignored
 * by the pane, and a hanging fetch dies with the tab.
 */
function fetchSignal(signal?: AbortSignal): AbortSignal | undefined {
  const timeout = abortSignalTimeout(YOUDAO_TIMEOUT_MS);
  if (!signal) return timeout;
  const any = (globalThis as any).AbortSignal?.any;
  if (typeof any === "function") {
    try {
      return any([signal, timeout]);
    } catch {
      /* fall through */
    }
  }
  return signal;
}

/**
 * Look a word up on Youdao. Resolves null when no edition yields a usable
 * entry — never throws, never surfaces endpoint noise.
 */
export async function lookupYoudao(
  word: string,
  signal?: AbortSignal,
): Promise<DictionaryCardContent | null> {
  for (const le of leCandidates(word)) {
    if (signal?.aborted) return null;
    try {
      const card = await lookupYoudaoWithLe(word, le, signal);
      if (card) return card;
    } catch (e) {
      // A network-level failure is likely to repeat for the next edition —
      // stop instead of burning the chain's time budget on dead endpoints.
      safeDebug(`[Z-Transplit] youdaoDict (${le}) failed: ${toErrorMessage(e)}`);
      return null;
    }
  }
  return null;
}

async function lookupYoudaoWithLe(
  word: string,
  le: string,
  signal?: AbortSignal,
): Promise<DictionaryCardContent | null> {
  const url =
    `https://dict.youdao.com/jsonapi?s=dict&q=` +
    encodeURIComponent(word) +
    `&le=${encodeURIComponent(le)}`;
  const resp = await fetch(url, { signal: fetchSignal(signal) });
  if (!resp.ok) return null;
  const data = (await resp.json()) as any;
  return parseYoudaoResponse(data, word);
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Youdao embeds <b>/<i> highlight markup in senses and examples — strip it. */
function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

/**
 * Split "n. （声音的）深沉，洪亮" into { pos: "n.", meaning: "…" }.
 * Lines without a leading POS abbreviation keep the whole text as meaning.
 */
function splitPosLine(line: string): DictionarySense | null {
  const text = stripTags(line).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const match = text.match(/^([a-zA-Z]{1,12}\.)\s+(.+)$/);
  if (match) {
    return { pos: match[1], meaning: match[2].trim() };
  }
  return { meaning: text };
}

function parseYoudaoResponse(
  data: any,
  fallbackWord: string,
): DictionaryCardContent | null {
  if (!data || typeof data !== "object") return null;

  const simpleWord = data?.simple?.word?.[0];
  const phonetic = firstString(
    simpleWord?.usphone,
    simpleWord?.ukphone,
    simpleWord?.phone,
  );

  // Senses: scan every top-level `*.word[0].trs` branch. The branch key varies
  // by dictionary edition (ec/fc/dc/…); unrelated branches (web_trans, auth_
  // sents_part, …) have no `.word` array and are skipped by the shape checks.
  const senses: DictionarySense[] = [];
  for (const branch of Object.values(data)) {
    if (!branch || typeof branch !== "object") continue;
    const entry = (branch as any)?.word?.[0];
    const trGroups = entry?.trs;
    if (!Array.isArray(trGroups)) continue;
    for (const group of trGroups) {
      const trs = group?.tr;
      if (!Array.isArray(trs)) continue;
      const groupPos = firstString(group?.pos);
      for (const tr of trs) {
        const raw = tr?.l?.i;
        const lines = Array.isArray(raw)
          ? raw
          : typeof raw === "string"
            ? [raw]
            : [];
        const linePos = firstString(groupPos, tr?.l?.pos, tr?.pos);
        for (const line of lines) {
          if (typeof line !== "string") continue;
          const sense = splitPosLine(line);
          if (sense && !sense.pos && linePos) sense.pos = linePos;
          if (sense) senses.push(sense);
          if (senses.length >= MAX_SENSES) break;
        }
        if (senses.length >= MAX_SENSES) break;
      }
      if (senses.length >= MAX_SENSES) break;
    }
    if (senses.length >= MAX_SENSES) break;
  }
  // No usable senses anywhere → this edition has nothing to offer (thin or
  // unrelated response). null sends the chain to the next edition/layer.
  if (senses.length === 0) return null;

  const pairs = data?.blng_sents_part?.["sentence-pair"];
  const examples = Array.isArray(pairs)
    ? pairs
        .map((pair: any) => {
          const text = firstString(pair?.["sentence-eng"], pair?.["sentence-foreign"]);
          const translation = firstString(pair?.["sentence-translation"]);
          return text && translation
            ? { text: stripTags(text), translation: stripTags(translation) }
            : null;
        })
        .filter((x): x is { text: string; translation: string } => x !== null)
        .slice(0, MAX_EXAMPLES)
    : [];

  const card: DictionaryCardContent = {
    word: firstString(simpleWord?.word) ?? fallbackWord,
    phonetic,
    senses,
    examples: examples.length > 0 ? examples : undefined,
    source: "youdao",
  };
  // Every field above passed a structural guard (non-empty strings, ≥1 sense),
  // and the chain re-validates the card with the shared zod schema before
  // accepting it — so no second schema copy is needed here.
  return card;
}
