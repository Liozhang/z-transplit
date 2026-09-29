/**
 * opendataloaderSplitAdapter — Orchestrate translate→split using OpenDataLoader
 * for layout parsing.
 *
 * OpenDataLoader parses the PDF via a local Java jar and emits per-paragraph
 * `bbox + fontSize + text` in the exact coordinate space the renderer wants.
 * This adapter wires:
 *
 *   OpenDataLoader jar → PdfDocumentAnalysis
 *     → odlAnalysisToAssembly (per-page AssemblyResult, no assembler needed)
 *     → translateParagraphs / translateAllPagesBatched (z-transplit's
 *       configured translation engine, via src/core/translation/**)
 *     → LayoutPreservingRenderer (pdf-lib, text + optional image composite)
 *     → mergePageBytes → importTranslatedBytes → openSplitView
 *
 * Fidelity: the renderer overlays translated text onto the LOADED source PDF
 * (white masks over original text), then composites recovered figures back at
 * their bboxes. Content handling (empirically verified against real PDFs):
 *   - Raster images (embedded PNG/JPEG XObjects): ✅ recovered via
 *     --image-output embedded → PlacedImage → embedPng + drawImage.
 *   - Formulas (Σ∫√αβ… folded into text by ODL): ✅ detected, region-cropped,
 *     VLM-extracted to LaTeX, spliced back as $...$ (translation-safe). On VLM
 *     failure the crop is pasted back as an image (better than corrupted symbols).
 *   - Vector charts (matplotlib/R vector PDFs = draw instructions): ❌ NOT
 *     recovered. ODL emits only surrounding text (axis labels, legends) as
 *     paragraphs; the draw instructions produce no image/figure element and no
 *     bbox to crop. These figures are lost in the translated PDF.
 *   - Tables / background / grid lines: preserved by overlay mode (the source
 *     page is the render target), which is the default path.
 *
 * Translation engine: createTranslator() / createAIBatchTranslator() from
 * src/core/translation/translationEngines.ts, with the formula-preserving
 * prompt. Before any work starts, featureReadiness.checkTranslationReadiness()
 * preflights the configured engine; when it is not ready this throws an
 * actionable error (which prefs to fill) instead of failing midway through a
 * multi-minute parse.
 *
 * Ported from leadero's src/core/pdf/translation/opendataloaderSplitAdapter.ts.
 * Changes: MinerU fallback half removed (single OpenDataLoader backend),
 * ModelRouter narrative replaced by the local engine layer + readiness
 * preflight, leadero data-dir/log prefixes renamed.
 *
 * @module core/pdf/translation/opendataloaderSplitAdapter
 */

import { parsePdfWithOpenDataLoader } from "../backendSelector";
import { odlAnalysisToAssembly } from "./odlToAssembly";
import type { FormulaBlock } from "./odlToAssembly";
import {
  extractFormulaLatex,
  isFormulaVisionAvailable,
} from "./formulaExtractor";
import { rasterizeRegionToDataURL } from "./ZoteroPdfRasterizer";
import {
  translateParagraphs,
  translateAllPagesBatched,
  type ParagraphTranslator,
} from "./translateParagraphs";
import { renderLayoutPreserving, renderOverlayTranslated } from "./LayoutPreservingRenderer";
import { mergePageBytes } from "./pdfMerge";
import { importTranslatedBytes } from "./translatedAttachment";
import {
  createTranslator,
  supportsBatching,
  createAIBatchTranslator,
  engineCacheIdentity,
} from "../../translation/translationEngines";
import {
  checkTranslationReadiness,
} from "../../translation/featureReadiness";
import { getPrefDynamic } from "../../../utils/prefs";
import { getString } from "../../../utils/locale";
import {
  fontLangForTarget,
  isCjkTarget,
  readFontBytesForLang,
} from "../platform";
import { safeDebug } from "../../../utils/logger";


export interface OdlSplitOptions {
  sourceItem: any;
  onProgress?: (msg: string) => void;
  /**
   * Split-view opener. Required for outcome "split" (the default); unused for
   * outcome "attachment".
   */
  openSplitView?: (win: any, item: any, att: any) => Promise<string | null>;
  /** Cooperative cancel signal — aborts translation mid-flight. */
  signal?: AbortSignal;
  /**
   * What to do with the translated PDF. "split" (default) opens the
   * side-by-side view; "attachment" only saves it and (when provided) hands it
   * to `openAttachment` — the item-tree menu's "translate to attachment" flow.
   */
  outcome?: "split" | "attachment";
  /** Attachment-mode callback — called after the translated PDF is imported. */
  openAttachment?: (attachmentId: number) => void;
}

export interface OdlSplitResult {
  translatedAttachmentId: number;
  splitTabID: string | null;
}

/**
 * User cancellation. Callers must detect it by NAME, not message text: the
 * message is localized (FTL), so a hardcoded-string comparison breaks under
 * l10n. The zh/en message deliberately keeps 已取消/cancelled so
 * backendSelector.isInfraError still classifies it as user cancellation.
 */
export class TranslationCancelledError extends Error {
  constructor() {
    super(getString("odl-progress-cancelled"));
    this.name = "ZTransplitCancelled";
  }
}

/** User-overridable font directory under the Zotero data directory. */
function translationAssetsDir(): string {
  const dataDir = (Zotero as any).DataDirectory?.dir || "";
  // PathUtils.join, never template concatenation: DataDirectory.dir carries
  // Windows backslashes and a mixed "/..." tail makes IOUtils reject the whole
  // path with NS_ERROR_FILE_UNRECOGNIZED_PATH (found in the README-shot round
  // on a fresh data dir; earlier rounds ran on dirs where the check happened
  // to be skipped).
  return (globalThis as any).PathUtils?.join?.(dataDir, "ztransplit", "translation-assets")
    ?? `${dataDir}\ztransplit	ranslation-assets`;
}

/** Mix-safe join for paths under the data dir (see translationAssetsDir). */
function joinAssetPath(dataDir: string, name: string): string {
  return (globalThis as any).PathUtils?.join?.(
    dataDir, "ztransplit", "translation-assets", name,
  ) ?? `${dataDir}\ztransplit	ranslation-assets\${name}`;
}

/**
 * Copy bytes into a bundle-realm typed array. Buffers straight from IOUtils
 * live in the privileged realm — pdf-lib's `instanceof Uint8Array/ArrayBuffer`
 * fails on them and embedFont rejects the font ("was actually of type NaN":
 * pdf-lib's getType reports any non-matching object that coerces to NaN as
 * NaN). Same cross-realm family as the reader Xray issues (§12.5 R1).
 */
function realmLocalCopy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * User font overrides live in `{DataDir}/ztransplit/translation-assets/` under
 * script-neutral basenames — the same file serves every target language, and
 * users pick whatever face they prefer (e.g. Noto Serif SC to match a paper's
 * serif typography). Each name accepts .ttf / .otf / .ttc (matching the
 * preferences-pane copy). The legacy per-language NotoSans* names are still
 * honored last so overrides placed before the neutral convention keep working
 * after an upgrade.
 */
const FONT_OVERRIDE_EXTENSIONS = [".ttf", ".otf", ".ttc"] as const;
const FONT_OVERRIDE_BASENAMES = {
  regular: "translated-regular",
  bold: "translated-bold",
  italic: "translated-italic",
  boldItalic: "translated-bold-italic",
} as const;

/** Legacy exact-filename regular override, before the neutral convention. */
function legacyRegularOverride(targetLanguage: string): string | null {
  switch (fontLangForTarget(targetLanguage)) {
    case "zh":
      return "NotoSansSC.ttf";
    case "ja":
      return "NotoSansJP.ttf";
    case "ko":
      return "NotoSansKR.ttf";
    default:
      return null; // non-CJK target — no CJK font needed
  }
}

/** Legacy exact-filename variant override (e.g. "NotoSansSC-Bold.ttf"). */
function legacyVariantOverride(
  variant: "Bold" | "Italic" | "BoldItalic",
  targetLanguage: string,
): string | null {
  const legacy = legacyRegularOverride(targetLanguage);
  return legacy ? `${legacy.replace(/\.ttf$/i, "")}-${variant}.ttf` : null;
}

/** Read the first existing asset among `names`; null when none is present. */
async function readFirstAsset(names: string[]): Promise<Uint8Array | null> {
  const IOUtils = (globalThis as any).IOUtils;
  const dataDir = (Zotero as any).DataDirectory?.dir;
  if (!IOUtils || !dataDir) return null;
  for (const name of names) {
    try {
      const p = joinAssetPath(dataDir, name);
      if (await IOUtils.exists(p)) {
        return realmLocalCopy(await IOUtils.read(p));
      }
    } catch (e) {
      safeDebug("[Z-Transplit] opendataloaderSplitAdapter: " + e);
      /* ignore */
    }
  }
  return null;
}

/** Every filename one override slot may carry, most-preferred first. */
function overrideCandidates(basename: string, legacyName: string | null): string[] {
  const names = FONT_OVERRIDE_EXTENSIONS.map((ext) => `${basename}${ext}`);
  if (legacyName) names.push(legacyName);
  return names;
}

/**
 * Resolve the CJK font for a translation target language: the first existing
 * user-placed asset in `{DataDir}/ztransplit/translation-assets/`, then the
 * OS system-default font for that script (via the shared platform module).
 */
async function resolveCjkFont(targetLanguage: string): Promise<Uint8Array | null> {
  const override = await readFirstAsset(
    overrideCandidates(FONT_OVERRIDE_BASENAMES.regular, legacyRegularOverride(targetLanguage)),
  );
  if (override) return override;
  return readFontBytesForLang(fontLangForTarget(targetLanguage));
}

/**
 * Resolve bold/italic CJK variants a user may have placed in the assets dir
 * (neutral basenames, then the legacy per-language names). Each is optional;
 * when absent the renderer degrades to regular for that style. System fonts
 * don't supply these, so only user-placed assets are checked.
 */
async function readCjkVariants(
  targetLanguage: string,
): Promise<{ bold: Uint8Array | null; italic: Uint8Array | null; boldItalic: Uint8Array | null }> {
  const readVariant = (
    basename: string,
    variant: "Bold" | "Italic" | "BoldItalic",
  ): Promise<Uint8Array | null> =>
    readFirstAsset(overrideCandidates(basename, legacyVariantOverride(variant, targetLanguage)));
  const [bold, italic, boldItalic] = await Promise.all([
    readVariant(FONT_OVERRIDE_BASENAMES.bold, "Bold"),
    readVariant(FONT_OVERRIDE_BASENAMES.italic, "Italic"),
    readVariant(FONT_OVERRIDE_BASENAMES.boldItalic, "BoldItalic"),
  ]);
  return { bold, italic, boldItalic };
}

// ─── Translator (engine-backed; formula-preserving prompt included) ──

function makeTranslator(
  targetLanguage: string,
  sourceLanguage?: string,
): ParagraphTranslator {
  return async (text, _tgt, _src) => {
    return createTranslator(targetLanguage, sourceLanguage)(text, targetLanguage, sourceLanguage);
  };
}

/**
 * Zotero's UI locale (e.g. "zh-CN"), or "" on hosts without the Zotero global
 * (vitest). Mirrors src/ui/translatePane.ts#defaultTargetLang so the PDF
 * pipeline and the text pane resolve the same default.
 */
function zoteroUILocale(): string {
  try {
    const locale =
      (typeof Zotero === "undefined" ? undefined : (Zotero as any)?.locale) ??
      (globalThis as any)?.Zotero?.locale;
    return typeof locale === "string" ? locale : "";
  } catch {
    return "";
  }
}

/**
 * Preflight the configured translation engine BEFORE any expensive work.
 * Throws a human-readable, actionable error when the engine isn't ready
 * (missing API key / endpoint / plugin) instead of failing mid-parse.
 */
function assertEngineReady(): void {
  const readiness = checkTranslationReadiness();
  if (readiness.ready) return;
  // Localize the gap through the same FTL keys the item pane uses
  // (readiness-reason-*, see src/ui/translatePane.ts#runTranslation) — a bare
  // message id in a user-facing error is a bug, not extra information.
  const gaps = readiness.missing
    .map((m) => `${m.prefKey}（${getString(m.reasonKey)}）`)
    .filter(Boolean)
    .join("；");
  throw new Error(getString("odl-error-engine-not-ready", {
    gaps: gaps || getString("readiness-reason-unknown"),
  }));
}

/**
 * Translate a source PDF via OpenDataLoader + the configured translation engine
 * and open split view.
 *
 * @throws if the translation engine is not configured, the JVM is unavailable,
 *   ODL parse fails, or rendering/split-view fails.
 */
export async function translateAndSplitWithOpenDataLoader(
  opts: OdlSplitOptions,
): Promise<OdlSplitResult> {
  const { sourceItem, openSplitView: openSplitViewFn } = opts;
  const onProgress = opts.onProgress || (() => {});

  // 0. Preflight: the engine must be ready before we spend minutes parsing.
  assertEngineReady();

  // 0-1. Parse the source PDF via OpenDataLoader (the only backend).
  onProgress(getString("odl-progress-parsing"));
  const inputPath = sourceItem.getFilePath?.();
  if (!inputPath) {
    throw new Error(getString("odl-error-source-path"));
  }
  const { analysis } = await parsePdfWithOpenDataLoader(inputPath, {
    imageOutput: "embedded",
    signal: opts.signal,
    onProgress,
  });
  if (!analysis || !analysis.pages || analysis.pages.length === 0) {
    throw new Error(
      analysis?.filteredMarkdown
        ? getString("odl-error-parse-failed", { detail: analysis.filteredMarkdown })
        : getString("odl-error-parse-no-pages"),
    );
  }
  //    already sliced paragraphs with geometry in the right coordinate space).
  const { assemblies, pageSizes, formulaBlocks } = odlAnalysisToAssembly(analysis);
  const totalPages = assemblies.length;
  const totalParagraphs = assemblies.reduce(
    (sum, a) => sum + a.paragraphs.length,
    0,
  );
  if (totalParagraphs === 0) {
    throw new Error(getString("odl-error-parse-no-text"));
  }

  //    which the translator would corrupt. When a vision model is configured,
  //    crop each formula-bearing paragraph's bbox and ask the VLM for LaTeX,
  //    then splice the LaTeX back into the paragraph text (protected from
  //    translation by formulaPreservingPrompt). Without vision, degrade: the
  //    formulas stay inline and may translate imperfectly (a known limitation).
  const visionOk = isFormulaVisionAvailable();
  if (formulaBlocks.length > 0) {
    if (visionOk) {
      onProgress(
        getString("odl-progress-formula-vlm", { count: formulaBlocks.length }),
      );
      await extractFormulasForTranslation(sourceItem.id, assemblies, formulaBlocks, onProgress);
    } else {
      onProgress(
        getString("odl-progress-formula-novlm", { count: formulaBlocks.length }),
      );
    }
  }

  //    Resolve the CJK font for the target script (zh/ja/ko) + a Latin font for
  //    English runs, plus optional Bold/Italic variants. Warn loudly if the CJK
  //    font is missing for a CJK target — without it every glyph becomes '?'.
  const targetLanguage =
    (getPrefDynamic("translate.targetLanguage") as string | undefined) ||
    // "" = follow Zotero's UI locale (addon/prefs.js declares exactly that);
    // the final "zh-CN" only guards hosts with no Zotero global at all.
    zoteroUILocale() ||
    "zh-CN";
  // One title, three consumers: the overlay PDF's metadata, the white-page
  // merged PDF's metadata, and the Zotero attachment title. splitViewCleanup's
  // recognition regex must keep matching this convention.
  const translatedTitle = `Translated (${targetLanguage})`;
  const cjkFontBytes = isCjkTarget(targetLanguage)
    ? await resolveCjkFont(targetLanguage)
    : null;
  // Latin font is always resolved — used for the Latin runs in mixed paragraphs
  // (and as the sole font when the target is itself Latin).
  const latinFontBytes = await readFontBytesForLang("latin");
  const fontVariants = await readCjkVariants(targetLanguage);
  if (!cjkFontBytes && isCjkTarget(targetLanguage)) {
    onProgress(
      getString("odl-progress-font-missing", {
        fontFile: `${FONT_OVERRIDE_BASENAMES.regular}.ttf`,
        assetsDir: translationAssetsDir(),
      }),
    );
  }

  // 4b. Capture formula screenshots for visual preservation. Independent of
  //     the VLM LaTeX-extraction step above: even when VLM is unavailable or
  //     fails, we rasterize each formula-bearing region so the renderer can
  //     paste a clean image of the source math at the original bbox (instead
  //     of dropping the {vn} token and leaving dangling text). Requires the
  //     reader to be open — we open it transiently here.
  if (formulaBlocks.length > 0) {
    await captureFormulaScreenshots(
      sourceItem.id,
      assemblies,
      formulaBlocks,
      onProgress,
    );
  }

  //    call per chunk) for engines that support batching — it gives the model
  //    cross-paragraph context and cuts call count ~25-50×. Fall back to
  //    per-page per-paragraph for stateless MT engines (Google/Bing/DeepL).
  let failedTranslations = 0;
  let translatedSets: string[][];

  if (supportsBatching()) {
    const batchHandle = await createAIBatchTranslator(targetLanguage);
    const batchResult = await translateAllPagesBatched(
      assemblies.map((a) => a.texts),
      batchHandle.translate,
      {
        targetLanguage,
        // Source language is auto-detected by the engines — cache keys use "auto".
        inputBudgetChars: batchHandle.inputBudgetChars,
        outputBudgetChars: batchHandle.outputBudgetChars,
        onProgress,
        signal: opts.signal,
        cacheIdentity: engineCacheIdentity(),
      },
    );
    translatedSets = batchResult.translatedSets;
    failedTranslations = batchResult.failedCount;
  } else {
    const translator = makeTranslator(targetLanguage);
    translatedSets = [];
    for (let i = 0; i < totalPages; i++) {
      const assembly = assemblies[i];
      onProgress(
        getString("odl-progress-page", {
          current: i + 1,
          total: totalPages,
          count: assembly.paragraphs.length,
        }),
      );
      const { results, status } = await translateParagraphs(
        assembly.texts,
        translator,
        targetLanguage,
        undefined,
        4,
        { cacheIdentity: engineCacheIdentity() },
      );
      translatedSets.push(results);
      failedTranslations += status.filter((s) => s && s.failed).length;
    }
  }

  // Abort check: if the user cancelled during translation, stop before
  // rendering — no point compositing a half-translated PDF.
  if (opts.signal?.aborted) {
    throw new TranslationCancelledError();
  }

  //    every page) — this preserves ALL original vector content (figures, charts,
  //    table lines) at full fidelity. Fall back to white-page mode if the source
  //    bytes can't be read.
  let merged: Uint8Array;
  const IOUtils = (globalThis as any).IOUtils;
  let sourcePdfBytes: Uint8Array | null = null;
  try {
    if (IOUtils && inputPath) {
      const raw = await IOUtils.read(inputPath);
      // IOUtils.read returns Uint8Array; ensure we have a real typed array (not
      // a view with byteOffset that confuses pdf-lib). Copy into a clean buffer.
      sourcePdfBytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    }
  } catch (e) {
    safeDebug("[Z-Transplit] opendataloaderSplitAdapter: " + e);
    /* fall back to white-page mode */
  }

  if (sourcePdfBytes) {
    onProgress(getString("odl-progress-overlay"));
    const result = await renderOverlayTranslated(
      sourcePdfBytes,
      assemblies,
      translatedSets,
      {
        targetLanguage,
        ...(cjkFontBytes ? { cjkFontBytes } : {}),
        ...(latinFontBytes ? { latinFontBytes } : {}),
        ...(fontVariants.bold ? { boldFontBytes: fontVariants.bold } : {}),
        ...(fontVariants.italic
          ? { italicFontBytes: fontVariants.italic }
          : {}),
        ...(fontVariants.boldItalic
          ? { boldItalicFontBytes: fontVariants.boldItalic }
          : {}),
        docTitle: translatedTitle,
      },
    );
    merged = result.bytes;
  } else {
    onProgress(getString("odl-progress-render-white"));
    const pageBytes: Uint8Array[] = [];
    for (let i = 0; i < totalPages; i++) {
      const render = await renderLayoutPreserving(
        assemblies[i],
        translatedSets[i],
        {
          targetLanguage,
          pageWidth: pageSizes[i].width,
          pageHeight: pageSizes[i].height,
          ...(cjkFontBytes ? { cjkFontBytes } : {}),
          ...(latinFontBytes ? { latinFontBytes } : {}),
          ...(fontVariants.bold ? { boldFontBytes: fontVariants.bold } : {}),
          ...(fontVariants.italic
            ? { italicFontBytes: fontVariants.italic }
            : {}),
          ...(fontVariants.boldItalic
            ? { boldItalicFontBytes: fontVariants.boldItalic }
            : {}),
        },
      );
      pageBytes.push(render.bytes);
    }
    if (pageBytes.length === 0) throw new Error(getString("odl-error-render-empty"));
    merged = await mergePageBytes(pageBytes, translatedTitle);
  }
  const parentItemID = sourceItem.parentItemID;
  const translatedAtt = await importTranslatedBytes(
    merged,
    parentItemID,
    translatedTitle,
    sourceItem,
  );

  // Attachment outcome: the item-tree "translate to attachment" flow stops
  // here — no split view, optional auto-open of the result.
  if (opts.outcome === "attachment") {
    onProgress(
      summarizePages(totalPages, totalParagraphs, failedTranslations),
    );
    try {
      opts.openAttachment?.(translatedAtt.id);
    } catch (e) {
      safeDebug("[Z-Transplit split] open translated attachment failed: " + e);
    }
    return {
      translatedAttachmentId: translatedAtt.id,
      splitTabID: null,
    };
  }

  onProgress(getString("odl-progress-opening-split"));
  if (!openSplitViewFn) {
    throw new Error(getString("odl-error-no-split-opener"));
  }
  const win = (Zotero as any).getMainWindow?.() || null;
  let splitTabID: string | null = null;
  try {
    splitTabID = await openSplitViewFn!(win, sourceItem, translatedAtt);
    onProgress(
      summarizePages(totalPages, totalParagraphs, failedTranslations),
    );
  } catch (e) {
    // 译文已生成并入库——失败仅发生在分屏容器打开（openSplitView 超时抛错，
    // 不再返回 null）。不能让用户以为翻译白做：结果里 translatedAttachmentId
    // 依然有效，进度条文案明确说明译文已保存。
    safeDebug(`[Z-Transplit split] open split view failed after translation: ${e}`);
    onProgress(
      getString("odl-progress-summary-nosplit", {
        pages: totalPages,
        paragraphs: totalParagraphs,
      }) + failedSuffix(failedTranslations),
    );
  }

  return {
    translatedAttachmentId: translatedAtt.id,
    splitTabID,
  };
}

/** "Done: N pages, M paragraphs" (+ failed-paragraph suffix when any). */
function summarizePages(
  totalPages: number,
  totalParagraphs: number,
  failedTranslations: number,
): string {
  const base = getString("odl-progress-summary", {
    pages: totalPages,
    paragraphs: totalParagraphs,
  });
  return base + failedSuffix(failedTranslations);
}

/** Localized ", N paragraphs failed" suffix; empty when nothing failed. */
function failedSuffix(failedTranslations: number): string {
  return failedTranslations > 0
    ? getString("odl-progress-summary-failed", { failed: failedTranslations })
    : "";
}


/**
 * Wait for a freshly-opened reader's pdf.js to be ready (PDFViewerApplication +
 * pdfDocument available).
 */
async function waitForReaderPdf(reader: any): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    // Outer reader wraps the real reader under _internalReader; direct/internal
    // readers expose _primaryView at the top level.
    const primaryView =
      reader?._internalReader?._primaryView ?? reader?._primaryView;
    if (primaryView) return;
    await (Zotero as any).Promise.delay(100);
  }
  throw new Error(getString("odl-error-reader-pdf-timeout"));
}

/**
 * Open the source PDF in a reader for the duration of cropping (the rasterizer
 * needs a live pdf.js instance). Returns { reader, openedNew } or null when the
 * reader can't be opened at all.
 */
async function openReaderForCropping(
  attachmentId: number,
): Promise<{ reader: any; openedNew: boolean } | null> {
  let reader: any;
  let openedNew = false;
  try {
    reader = await (Zotero as any).Reader.open(attachmentId);
    openedNew = !!reader;
    // Reader.open() returns undefined when the tab is already open — find the
    // existing reader so we can use its pdf.js instance for rasterization.
    if (!reader) {
      reader = (Zotero as any).Reader?._readers?.find(
        (r: any) => (r._itemID ?? r.itemID ?? r._attachmentId ?? r.attachmentID) === attachmentId,
      );
    }
    if (!reader) return null;
    await waitForReaderPdf(reader);
    return { reader, openedNew };
  } catch (_e) {
    // Only close the reader if we opened a new one.
    if (openedNew) {
      try { reader?.close?.(); } catch (e) { safeDebug("[Z-Transplit] opendataloaderSplitAdapter: " + e);  /* best-effort */ }
    }
    return null;
  }
}

/**
 * For each formula-bearing paragraph: crop its bbox from the open reader, ask
 * the vision model for LaTeX, and splice the LaTeX back into the paragraph's
 * text so it survives translation verbatim (formulaPreservingPrompt protects
 * $...$). Failures are soft: a single bad crop/VLM response keeps the original
 * text rather than aborting the whole document.
 *
 * Opens the source PDF in a reader for the duration of cropping (the rasterizer
 * needs a live pdf.js instance), then closes it.
 */
async function extractFormulasForTranslation(
  attachmentId: number,
  assemblies: import("./translationIR").AssemblyResult[],
  formulaBlocks: FormulaBlock[],
  onProgress: (msg: string) => void,
): Promise<void> {
  const opened = await openReaderForCropping(attachmentId);
  if (!opened) {
    onProgress(getString("odl-progress-crop-reader-missing-skip"));
    return;
  }
  const { reader, openedNew } = opened;

  let processed = 0;
  let failed = 0;
  let imageFallback = 0;
  try {
    for (const fb of formulaBlocks) {
      const assembly = assemblies[fb.pageNumber - 1];
      if (!assembly) continue;
      // Capture the crop OUTSIDE the try so it's available to the catch branch
      // for image fallback if VLM extraction fails.
      let dataUrl: string | null = null;
      try {
        dataUrl = await rasterizeRegionToDataURL({
          attachmentId,
          pageNum: fb.pageNumber,
          bbox: fb.bbox,
        });
        const latex = await extractFormulaLatex(dataUrl);
        if (latex && latex.toUpperCase() !== "NONE") {
          // Splice the LaTeX in, replacing the formula-laden original so the
          // translator doesn't corrupt the math symbols. $...$ is preserved.
          assembly.texts[fb.paragraphIndex] = latex;
        }
        // "NONE" = model saw no formula — keep original text, no fallback.
        processed++;
      } catch (e) {
        safeDebug("[Z-Transplit] opendataloaderSplitAdapter: " + e);
        // VLM extraction failed. If we have a crop, paste it back as an image
        // at the formula's bbox (better than corrupted symbols getting
        // translated). Store in placedFormulas (NOT assembly.images) so BOTH
        // overlay and white-page render modes composite it — overlay mode does
        // not render `assembly.images` (it skips them to avoid double-drawing
        // the source's own images), which previously caused the formula region
        // to appear as a blank white hole in the default overlay path.
        if (dataUrl) {
          const placed = {
            bbox: { x: fb.bbox.x, y: fb.bbox.y, width: fb.bbox.width, height: fb.bbox.height },
            dataUri: dataUrl,
          };
          if (!assembly.placedFormulas) assembly.placedFormulas = [];
          assembly.placedFormulas.push(placed);
          // Clear the text so the corrupted symbols aren't also drawn under the
          // image (the renderer skips empty translated text).
          assembly.texts[fb.paragraphIndex] = "";
          imageFallback++;
        }
        failed++;
      }
      if (processed > 0 && processed % 5 === 0) {
        onProgress(getString("odl-progress-crop-progress", {
          current: processed,
          total: formulaBlocks.length,
        }));
      }
    }
  } finally {
    // Only close the reader if we opened it. Existing readers are the user's own
    // tabs and must not be closed.
    if (openedNew) {
      try {
        reader?.close?.();
      } catch (e) {
        safeDebug("[Z-Transplit] opendataloaderSplitAdapter: " + e);
        /* best-effort */
      }
    }
  }
  onProgress(
    getString("odl-progress-crop-done", { ok: processed }) +
      (imageFallback > 0
        ? getString("odl-progress-crop-fallback", { count: imageFallback })
        : "") +
      (failed - imageFallback > 0
        ? getString("odl-progress-crop-failed", { count: failed - imageFallback })
        : ""),
  );
}

/**
 * Rasterize each formula-bearing paragraph's bbox and store the screenshot in
 * `assembly.placedFormulas`. This is the visual-preservation path: the renderer
 * pastes these images back at the original coordinates so formulas survive
 * translation as clean images instead of being dropped or rendered as raw LaTeX.
 *
 * Independent of `extractFormulasForTranslation` (VLM LaTeX): we capture
 * screenshots regardless of whether a vision model is configured, so formulas
 * are always preserved visually. When VLM is also available, both run — the
 * LaTeX splice gives selectable text and the screenshot is a fallback.
 *
 * Opens the source PDF in a reader transiently (the rasterizer needs a live
 * pdf.js instance), then closes it. Failures are soft: a single bad crop is
 * skipped without aborting the whole document.
 */
async function captureFormulaScreenshots(
  attachmentId: number,
  assemblies: import("./translationIR").AssemblyResult[],
  formulaBlocks: FormulaBlock[],
  onProgress: (msg: string) => void,
): Promise<void> {
  const opened = await openReaderForCropping(attachmentId);
  if (!opened) {
    onProgress(getString("odl-progress-crop-reader-missing-text"));
    return;
  }
  const { reader, openedNew } = opened;

  let captured = 0;
  let failed = 0;
  try {
    for (const fb of formulaBlocks) {
      const assembly = assemblies[fb.pageNumber - 1];
      if (!assembly) continue;
      try {
        const dataUrl = await rasterizeRegionToDataURL({
          attachmentId,
          pageNum: fb.pageNumber,
          bbox: fb.bbox,
        });
        if (dataUrl) {
          if (!assembly.placedFormulas) assembly.placedFormulas = [];
          assembly.placedFormulas.push({
            bbox: {
              x: fb.bbox.x,
              y: fb.bbox.y,
              width: fb.bbox.width,
              height: fb.bbox.height,
            },
            dataUri: dataUrl,
          });
          captured++;
        } else {
          failed++;
        }
      } catch (e) {
        safeDebug("[Z-Transplit] opendataloaderSplitAdapter: " + e);
        failed++;
      }
      if (captured > 0 && captured % 5 === 0) {
        onProgress(getString("odl-progress-shot-progress", {
          current: captured,
          total: formulaBlocks.length,
        }));
      }
    }
  } finally {
    // Only close the reader if we opened it. Existing readers are the user's own
    // tabs and must not be closed.
    if (openedNew) {
      try {
        reader?.close?.();
      } catch (e) {
        safeDebug("[Z-Transplit] opendataloaderSplitAdapter: " + e);
        /* best-effort */
      }
    }
  }
  onProgress(
    getString("odl-progress-shot-done", { ok: captured }) +
      (failed > 0 ? getString("odl-progress-shot-failed", { count: failed }) : ""),
  );
}
