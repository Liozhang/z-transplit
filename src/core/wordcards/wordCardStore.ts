/**
 * wordCardStore — persistent store of dictionary word cards.
 *
 * Deliberately NOT built on translationCache: the cache is content-addressed
 * by engine identity with no time order and no single-record delete, while a
 * word card is one record per word with an append-only lookup history and
 * user-facing delete/clear. The MECHANICS, however, mirror translationCache
 * one-to-one: one small JSON file per record bucketed by key prefix, Gecko
 * IOUtils with atomic-ish single-file writes, PathUtils path joining, SHA-1
 * keys via SubtleCrypto, an injectable base directory for tests, and
 * operations that never throw.
 *
 * Storage layout:
 *   {DataDir}/ztransplit/word-cards/v1/<key[0:2]>/<key>.json
 *
 * Key: sha1 of the normalized word (case-folded, apostrophes unified) — the
 * same word looked up again merges into one card, whatever the engine or
 * target language was; each lookup lands in the record's history.
 *
 * An in-memory index (Map key → record) is loaded lazily on first access and
 * kept in sync by every mutation, so pane chip reads and tab listing never
 * rescan the disk after the first touch.
 */

import { safeDebug } from "../../utils/logger";
import { DictionaryCardContentSchema } from "../translation/dictionaryCard";
import type { DictionaryCardContent } from "../translation/types";

const STORE_VERSION = 1;

/** Lookup history kept per card (newest first; older entries are dropped). */
const HISTORY_LIMIT = 20;

export interface WordCardHistoryEntry {
  /** Epoch ms of the lookup. */
  at: number;
  targetLang: string;
  content: DictionaryCardContent;
}

export interface WordCardRecord {
  v: number;
  key: string;
  /** Display form of the word (first seen casing preserved). */
  word: string;
  createdAt: number;
  updatedAt: number;
  lookups: number;
  /** Item the most recent lookup came from (provenance; display is up to callers). */
  sourceItemID?: number;
  latest: DictionaryCardContent;
  history: WordCardHistoryEntry[];
}

/** Injectable base directory (tests). Undefined = derive from Zotero.DataDirectory. */
let overrideBaseDir: string | null | undefined;

/**
 * Override the store directory (tests; pass null to reset to auto-detect).
 * Always drops the in-memory index: a directory change (or a deliberate
 * re-set, the restart simulation) must never serve records scanned from a
 * previous directory.
 */
export function setWordCardDirForTests(dir: string | null): void {
  overrideBaseDir = dir;
  indexPromise = null;
}

function dataRoot(): string | null {
  if (overrideBaseDir !== undefined) return overrideBaseDir;
  try {
    const dir = (globalThis as any)?.Zotero?.DataDirectory?.dir;
    return typeof dir === "string" && dir ? dir : null;
  } catch {
    return null;
  }
}

function storeRoot(): string | null {
  const root = dataRoot();
  if (!root) return null;
  return joinPath(root, "ztransplit", "word-cards", `v${STORE_VERSION}`);
}

/**
 * Cross-platform path join — PathUtils normalizes for the OS (Gecko's IOUtils
 * rejects mixed separators); plain joining is the Node-test fallback.
 * Same implementation as translationCache.ts.
 */
function joinPath(...parts: string[]): string {
  const PathUtils = (globalThis as any).PathUtils;
  if (PathUtils?.join) {
    try {
      return PathUtils.join(...parts);
    } catch {
      /* fall through */
    }
  }
  return parts.join("/");
}

/** SHA-1 hex via the SubtleCrypto available in Gecko and Node 16+. */
async function sha1Hex(text: string): Promise<string> {
  try {
    const subtle = (globalThis as any)?.crypto?.subtle;
    if (!subtle) return "";
    const data = new TextEncoder().encode(text);
    const digest = await subtle.digest("SHA-1", data);
    return Array.from(new Uint8Array(digest))
      .map((b: number) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

/**
 * Key normalization: whitespace collapsed, case-folded, apostrophes unified,
 * so "Don't" / "don’t" / "don't " are one card. Display keeps the first-seen
 * casing via the record's `word` field.
 */
function normalizeWord(word: string): string {
  return (word || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/['’]/g, "'");
}

async function cardKey(normalized: string): Promise<string | null> {
  if (!normalized) return null;
  const hash = await sha1Hex(`${STORE_VERSION}|${normalized}`);
  return hash || null;
}

function recordPath(key: string): string | null {
  const root = storeRoot();
  if (!root) return null;
  // Defensive: the key comes from our own sha1 hex, but never let odd
  // characters near the filesystem.
  if (!/^[0-9a-f]{8,64}$/.test(key)) return null;
  return joinPath(root, key.slice(0, 2), `${key}.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory index
// ─────────────────────────────────────────────────────────────────────────────

let indexPromise: Promise<Map<string, WordCardRecord>> | null = null;

function isRecord(value: any): value is WordCardRecord {
  if (!value || typeof value !== "object" || value.v !== STORE_VERSION) return false;
  if (typeof value.key !== "string" || typeof value.word !== "string") return false;
  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return false;
  // The card itself must still satisfy the shared schema — a record whose card
  // content predates a schema change is skipped, not served.
  return DictionaryCardContentSchema.safeParse(value.latest).success;
}

/** Scan the store directory into a fresh Map. Never throws; corrupt files are skipped. */
async function loadIndex(): Promise<Map<string, WordCardRecord>> {
  const map = new Map<string, WordCardRecord>();
  const root = storeRoot();
  const IOUtils = (globalThis as any).IOUtils;
  if (!root || !IOUtils?.getChildren) return map;
  try {
    if (IOUtils.exists && !(await IOUtils.exists(root))) return map;
    const buckets = await IOUtils.getChildren(root);
    for (const bucket of buckets as any[]) {
      if (!bucket.isDirectory) continue;
      const files = await IOUtils.getChildren(bucket.path);
      for (const file of files as any[]) {
        if (file.isDirectory) continue;
        try {
          const bytes = await IOUtils.read(file.path);
          const rec = JSON.parse(new TextDecoder().decode(bytes));
          if (isRecord(rec)) map.set(rec.key, rec);
        } catch {
          // Corrupt/foreign file — skip it, like translationCache does.
        }
      }
    }
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardStore index load failed: " + e);
  }
  return map;
}

async function getIndex(): Promise<Map<string, WordCardRecord>> {
  if (!indexPromise) {
    indexPromise = loadIndex();
    // A failed load must be retryable, not cached-forever-empty.
    indexPromise.catch(() => {
      indexPromise = null;
    });
  }
  return indexPromise;
}

function invalidateIndex(): void {
  indexPromise = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Record I/O
// ─────────────────────────────────────────────────────────────────────────────

async function writeRecord(record: WordCardRecord): Promise<void> {
  const path = recordPath(record.key);
  if (!path) return;
  try {
    const IOUtils = (globalThis as any).IOUtils;
    if (!IOUtils?.write || !IOUtils?.makeDirectory) return;
    const bucket = path.slice(0, path.lastIndexOf("/"));
    // makeDirectory with createDirs creates intermediate directories.
    await IOUtils.makeDirectory(bucket, { createDirs: true, ignoreExisting: true });
    await IOUtils.write(path, new TextEncoder().encode(JSON.stringify(record)));
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardStore write failed: " + e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — every function is defensive and never throws
// ─────────────────────────────────────────────────────────────────────────────

export interface UpsertWordCardOptions {
  word: string;
  targetLang: string;
  content: DictionaryCardContent;
  sourceItemID?: number;
}

/**
 * Record one lookup: create the card or merge into the existing one (update
 * latest, bump counters, push history). Never throws.
 */
export async function upsertWordCard(options: UpsertWordCardOptions): Promise<void> {
  try {
    const normalized = normalizeWord(options.word);
    if (!normalized) return;
    if (!DictionaryCardContentSchema.safeParse(options.content).success) return;
    const key = await cardKey(normalized);
    if (!key) return;

    const index = await getIndex();
    const existing = index.get(key);
    const now = Date.now();
    const record: WordCardRecord = existing ?? {
      v: STORE_VERSION,
      key,
      word: options.word.replace(/\s+/g, " ").trim() || normalized,
      createdAt: now,
      updatedAt: now,
      lookups: 0,
      latest: options.content,
      history: [],
    };
    record.updatedAt = now;
    record.lookups = (record.lookups ?? 0) + 1;
    if (options.sourceItemID !== undefined) record.sourceItemID = options.sourceItemID;
    record.latest = options.content;
    record.history = [
      { at: now, targetLang: options.targetLang || "auto", content: options.content },
      ...(Array.isArray(record.history) ? record.history : []),
    ].slice(0, HISTORY_LIMIT);

    index.set(key, record);
    await writeRecord(record);
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardStore upsert failed: " + e);
  }
}

/** One card by word, or null. Never throws. */
export async function getWordCard(word: string): Promise<WordCardRecord | null> {
  try {
    const key = await cardKey(normalizeWord(word));
    if (!key) return null;
    return (await getIndex()).get(key) ?? null;
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardStore get failed: " + e);
    return null;
  }
}

/** All cards, most recently updated first. Never throws. */
export async function listWordCards(): Promise<WordCardRecord[]> {
  try {
    const all = Array.from((await getIndex()).values());
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return all;
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardStore list failed: " + e);
    return [];
  }
}

/** The n most recently updated cards (pane chip strip). Never throws. */
export async function recentWordCards(n: number): Promise<WordCardRecord[]> {
  const all = await listWordCards();
  return n > 0 ? all.slice(0, n) : [];
}

/** Delete one card by word. Resolves true when a card was removed. Never throws. */
export async function deleteWordCard(word: string): Promise<boolean> {
  try {
    const key = await cardKey(normalizeWord(word));
    if (!key) return false;
    const index = await getIndex();
    if (!index.delete(key)) return false;
    const path = recordPath(key);
    const IOUtils = (globalThis as any).IOUtils;
    if (path && IOUtils?.remove) {
      await IOUtils.remove(path, { ignoreExisting: true } as any);
    }
    return true;
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardStore delete failed: " + e);
    return false;
  }
}

/** Remove every card (tab's clear-all). Never throws. */
export async function clearAllWordCards(): Promise<void> {
  try {
    invalidateIndex();
    const root = storeRoot();
    const IOUtils = (globalThis as any).IOUtils;
    if (root && IOUtils?.remove) {
      await IOUtils.remove(root, { recursive: true });
    }
  } catch (e) {
    safeDebug("[Z-Transplit] wordCardStore clear failed: " + e);
  }
}
