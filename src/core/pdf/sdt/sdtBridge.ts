/**
 * sdt/sdtBridge — session bridge into the Zotero 10 reader's SDT reading mode.
 *
 * Zotero 10's reader can overlay the PDF with a REFLOWED HTML view built from
 * its structured document text (SDT): `_setReadingMode(true)` hides the PDF
 * iframe and creates an SDTView whose document contains one element per
 * content block, each addressable via `data-ref-path` (top-level blocks are
 * plain numbers, "0", "1", …). This bridge owns the enter/exit lifecycle and
 * the block inventory the bilingual interleave view is built on.
 *
 * All accessed APIs are reader internals (`_setReadingMode`, `_loadSDT`,
 * `_primarySDTView`) — they are probed by src/core/capabilities.ts before this
 * module is invoked, and re-checked defensively here. Nothing here touches
 * Zotero 7 (capability disclosure handles that upstream).
 *
 * @module core/pdf/sdt/sdtBridge
 */

import { safeDebug } from "../../../utils/logger";

/** One translatable text block of the SDT reading-mode view. */
export interface SdtBlock {
  /** The block's `data-ref-path` (top-level block index as a string). */
  refPath: string;
  /** The original block element (owned by Zotero's SDTView — never mutate). */
  el: HTMLElement;
  /** The block's visible text (innerText, whitespace-trimmed). */
  text: string;
}

export interface BilingualSession {
  reader: any;
  internalReader: any;
  /** Zotero's SDTView instance (reader internals). */
  sdtView: any;
  /** The SDTView iframe's document (chrome-privileged access). */
  doc: Document;
  /** `<article id="sdt-content">` root of the reflowed view. */
  container: HTMLElement;
  blocks: SdtBlock[];
  exit: () => Promise<void>;
}

const ENTER_TIMEOUT_MS = 15000;
const BLOCK_WAIT_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Enter the SDT reading mode on this reader and collect the block inventory.
 *
 * Returns null (never throws) when the mode is unavailable or the SDT pack
 * fails to load for this document — callers show a capability disclosure.
 */
export async function enterBilingualSession(
  reader: any,
): Promise<BilingualSession | null> {
  try {
    const internalReader = reader?._internalReader ?? reader;
    if (
      !internalReader ||
      typeof internalReader._setReadingMode !== "function" ||
      typeof internalReader._loadSDT !== "function"
    ) {
      safeDebug("[Z-Transplit] sdtBridge: SDT mode API not present");
      return null;
    }

    // The internal reader lives in the reader iframe's content realm. From
    // chrome, Xray wrappers expose prototype methods but HIDE runtime-added
    // expando properties — `_primarySDTView` is assigned at enter time and is
    // therefore invisible through the Xray (found in the 10.0.3 manual
    // verification: enter resolved, view never "appeared"). All expando reads
    // must go through wrappedJSObject (the raw content object).
    const rawInternal: any =
      (internalReader as any).wrappedJSObject ?? internalReader;

    // EVERYTHING must run against the RAW content object: a method invoked
    // through the Xray gets `this` = Xray, where the reader's runtime
    // properties (_sdtPack, _sdt, _primarySDTView — all assigned
    // post-construction by the reader itself) are invisible, so _loadSDT
    // always sees "no pack" and the enter silently no-ops. Calling through
    // wrappedJSObject binds `this` to the real object (found in the 10.0.3
    // manual verification: enter resolved, view never appeared, state flags
    // frozen at enabled=false).
    if (typeof rawInternal._handleReadingModeEnabledChange === "function") {
      // Official entry (what the reader's own toolbar uses): catches its own
      // failures and surfaces the reader's error message. Resolution does not
      // guarantee success — the view poll below is the source of truth.
      await rawInternal._handleReadingModeEnabledChange(true);
    } else if (typeof rawInternal._setReadingMode === "function") {
      // _setReadingMode serializes internally (_readingModeQueue) and rejects
      // when the SDT is unavailable ("SDT unavailable"). Args are
      // (primary, enabled) — BOTH must be passed (see safeExit).
      await withTimeout(rawInternal._setReadingMode(true, true), ENTER_TIMEOUT_MS);
    } else {
      safeDebug("[Z-Transplit] sdtBridge: no reading-mode entry point");
      return null;
    }

    // The overlay view is created synchronously at the end of the enter
    // transition; poll briefly in case the transition is still settling.
    let sdtView: any = null;
    const start = Date.now();
    while (Date.now() - start < ENTER_TIMEOUT_MS) {
      sdtView = rawInternal._primarySDTView ?? null;
      if (sdtView) break;
      await sleep(100);
    }
    if (!sdtView) {
      safeDebug(
        "[Z-Transplit] sdtBridge: _primarySDTView never appeared" +
          " (state.loading=" + rawInternal._state?.readingModeLoading +
          " enabled=" + rawInternal._state?.primaryReadingModeEnabled + ")",
      );
      await safeExit(internalReader);
      return null;
    }
    // The view object is also content-realm — unwrap before touching its
    // fields (_iframe etc. may be hidden behind the same Xray).
    const rawView: any = sdtView.wrappedJSObject ?? sdtView;

    // The view's iframe document must contain the rendered blocks. The SDT
    // view renders progressively (React), so wait until at least one
    // TRANSLATABLE block exists, re-fetching the container each round — the
    // article node captured too early can be replaced by a re-render.
    let container: HTMLElement | null = null;
    let blocks: SdtBlock[] = [];
    const waitStart = Date.now();
    while (Date.now() - waitStart < BLOCK_WAIT_TIMEOUT_MS) {
      const fresh: HTMLElement | null =
        (rawView._iframe?.contentDocument as any)?.getElementById?.("sdt-content") ??
        null;
      if (fresh) {
        blocks = collectBlocks(fresh);
        if (blocks.length > 0) {
          container = fresh;
          break;
        }
      }
      await sleep(250);
    }
    if (!container || blocks.length === 0) {
      safeDebug("[Z-Transplit] sdtBridge: no translatable blocks");
      await safeExit(internalReader);
      return null;
    }

    const exit = async (): Promise<void> => {
      await safeExit(internalReader);
    };

    return {
      reader,
      internalReader,
      sdtView: rawView,
      doc: rawView._iframe?.contentDocument ?? container.ownerDocument,
      container,
      blocks,
      exit,
    };
  } catch (e) {
    safeDebug("[Z-Transplit] sdtBridge enter failed: " + e);
    return null;
  }
}

/** Exit the reading mode; safe to call multiple times. */
export async function exitBilingualSession(session: BilingualSession | null): Promise<void> {
  if (!session) return;
  await session.exit();
}

async function safeExit(internalReader: any): Promise<void> {
  try {
    // Raw object for the same Xray reason as the enter call (see above).
    // SIGNATURE TRAP (found in the 10.0.3 verification): _setReadingMode takes
    // (primary, enabled) — a bare (false) lands on `primary` and `enabled`
    // becomes undefined, so the exit branch never runs. Pass both explicitly.
    const raw: any = internalReader?.wrappedJSObject ?? internalReader;
    await raw?._setReadingMode?.(true, false);
    safeDebug(
      "[Z-Transplit] sdtBridge: exit done, view=" +
        !!raw?._primarySDTView,
    );
  } catch (e) {
    safeDebug("[Z-Transplit] sdtBridge exit failed: " + e);
  }
}

async function withTimeout(p: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: any = null;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("sdt enter timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


/**
 * Collect the translatable top-level blocks.
 *
 * The renderer maps block types to tags: paragraph→p, heading→h2,
 * caption→figcaption, note→aside, preformatted→pre. Containers (lists,
 * tables), images and math carry a ref-path too but translating their
 * aggregated text is wrong, so they are skipped — same for reference sections.
 */
const TRANSLATABLE_TAGS = new Set(["P", "H2", "FIGCAPTION", "ASIDE", "PRE"]);

export function collectBlocks(container: HTMLElement): SdtBlock[] {
  const blocks: SdtBlock[] = [];
  for (const el of Array.from(container.children) as HTMLElement[]) {
    const refPath = el.dataset?.refPath;
    if (!refPath || !TRANSLATABLE_TAGS.has(el.tagName)) continue;
    if (el.classList.contains("sdt-reference")) continue;
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 2) continue;
    blocks.push({ refPath, el, text });
  }
  return blocks;
}
