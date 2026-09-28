/**
 * backendSelector — PDF parsing backend selection for the OpenDataLoader pipeline.
 *
 * z-transplit parses PDFs through ONE backend: the local OpenDataLoader jar
 * (`java -jar opendataloader-pdf-cli.jar`), selected by the
 * `pdfParser.backend` pref (any value other than a known remote backend maps
 * to OpenDataLoader — there are no others anymore).
 *
 * TRIMMED FROM LEADERO: the original file implemented a two-backend cascade
 * (OpenDataLoader + MinerU, a remote VLM service) with infra-error-triggered
 * automatic fallback. The remote half is gone by design (see deviations in the
 * port notes): no MinerU client, no quota store, no pdfParser.mineru.* prefs.
 * What remains is the part the translate→split pipeline actually uses:
 *   - a Java + JAR health preflight with an actionable error,
 *   - the jar invocation with image-output/timeout/signal plumbing,
 *   - ODL error classification (java-missing / jar-missing / timeout /
 *     parse-failed / no-text) so callers can produce human-readable hints.
 *
 * User cancellation is NEVER classified as an infrastructure error (it used to
 * trigger a fallback that restarted a parse the user had just cancelled).
 *
 * Ported from leadero's src/core/pdf/backendSelector.ts with the MinerU half
 * removed.
 */

import type { PdfDocumentAnalysis } from "./PdfIR";

import { adaptOpenDataLoaderJson } from "./OpenDataLoaderJsonAdapter";
import { parsePdfToJson, checkHealth } from "./OpenDataLoaderPdfClient";
import { PdfParseError } from "./PdfParseError";

import { safeDebug } from "../../utils/logger";
import { getString } from "../../utils/locale";

/**
 * The only parsing backend. Kept as a type (not a bare string) so call sites
 * that log/compare a backend keep compiling if a second local backend ever
 * returns.
 */
export type PdfBackend = "opendataloader";

export interface BackendParseOptions {
  startPage?: number;
  endPage?: number;
  signal?: AbortSignal;
  /** "embedded" for the translate pipeline (figures recovered); "off" otherwise. */
  imageOutput?: "off" | "embedded";
  onProgress?: (msg: string) => void;
}

export interface BackendParseResult {
  analysis: PdfDocumentAnalysis;
  /** The backend that produced the result. */
  backend: PdfBackend;
  /**
   * True if a non-default backend setting was in effect and got mapped to
   * OpenDataLoader. Always false today (single backend) — kept in the result
   * shape so the orchestrator's progress messaging doesn't need a rewrite if a
   * backend is ever added.
   */
  fellBack: boolean;
}

/**
 * Whether the OpenDataLoader backend is usable right now (Java + JAR health).
 * Cheap enough for a pre-flight; no JVM spawn beyond `java -version`.
 */
export async function isBackendAvailable(): Promise<boolean> {
  try {
    const health = await checkHealth();
    return health.healthy;
  } catch (e) {
    safeDebug("[Z-Transplit] backendSelector: " + e);
    return false;
  }
}

/**
 * Parse a PDF with OpenDataLoader.
 *
 * @throws PdfParseError with a classified reason (java-missing / jar-missing /
 *   timeout / parse-failed / no-text) so callers can map it to a user hint.
 * @throws AbortError (name === "AbortError") when the caller's signal fired.
 */
export async function parsePdfWithOpenDataLoader(
  filePath: string,
  options?: BackendParseOptions,
): Promise<BackendParseResult> {
  const analysis = await tryOpenDataLoader(filePath, options);
  return { analysis, backend: "opendataloader", fellBack: false };
}

/**
 * Back-compat alias for {@link parsePdfWithOpenDataLoader}. The name is a
 * leftover from the two-backend cascade; with a single backend there is
 * nothing to fall back to, so it resolves straight to OpenDataLoader.
 */
export async function parsePdfWithFallback(
  filePath: string,
  options?: BackendParseOptions,
): Promise<BackendParseResult> {
  return parsePdfWithOpenDataLoader(filePath, options);
}

async function tryOpenDataLoader(
  filePath: string,
  options?: BackendParseOptions,
): Promise<PdfDocumentAnalysis> {
  // Preflight: Java + JAR health.
  const health = await checkHealth();
  // debug 级：常规 preflight 记录不该占错误通道，路径只在调试开关下可见
  const dbg =
    typeof (globalThis as any).Zotero?.debug === "function"
      ? (m: string) => safeDebug(m)
      : (m: string) => console.debug(m);
  dbg(
    `[Z-Transplit ODL] tryOpenDataLoader: health=${health.healthy} error="${health.error ?? ""}"`,
  );
  if (!health.healthy) {
    throw new PdfParseError(
      "java-missing",
      getString("err-java-unavailable", { detail: health.error ?? "" }),
    );
  }

  const jsonResult = await parsePdfToJson(filePath, {
    startPage: options?.startPage,
    endPage: options?.endPage,
    format: "json",
    signal: options?.signal,
    imageOutput: options?.imageOutput ?? "off",
  });

  if (!jsonResult.success || !jsonResult.data) {
    // Classify: timeout vs parse-failed vs java-missing
    const err = jsonResult.error || "";
    throw classifyOdlRuntimeError(err);
  }

  const analysis = adaptOpenDataLoaderJson(jsonResult.data);
  if (!analysis.pages || analysis.pages.length === 0) {
    throw new PdfParseError("no-text", getString("err-parse-no-pages"));
  }
  return analysis;
}


/**
 * Determine whether an error is an "infrastructure" error (fixable by the
 * environment/user) vs. a "content" error.
 *
 * Kept from leadero's selector because callers (and the readiness preflight)
 * still branch on it; with a single backend it no longer triggers a fallback,
 * but the classification drives which user-facing hint is shown.
 *
 * User cancellation is NOT an infrastructure error — an AbortError (or
 * 已取消/cancelled wording) must never be re-interpreted as "retry with
 * something else".
 */
export function isInfraError(e: any): boolean {
  const msg = String(e?.message || e);

  if (e?.name === "AbortError" || /abort|已取消|cancelled/i.test(msg)) {
    return false;
  }

  // ODL PdfParseError
  if (e instanceof PdfParseError) {
    const reason = (e as any).reason as string;
    // Infrastructure reasons: can be fixed by installing Java / the JAR
    if (
      reason === "java-missing" ||
      reason === "jar-missing" ||
      reason === "timeout"
    ) {
      return true;
    }
    // Content reasons: re-parsing likely won't help
    return false;
  }

  // Generic network errors → infra
  if (e instanceof TypeError) return true;
  if (/network|fetch|timeout|ECONN|socket/i.test(msg)) return true;

  return false;
}

export function classifyOdlRuntimeError(error: string): PdfParseError {
  const lower = error.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return new PdfParseError("timeout", error);
  }
  // M-25: match Java *launch-failure* signatures instead of the bare "java"
  // substring — a java.lang.* stack trace from a RUNNING JVM (e.g.
  // NullPointerException) is a runtime error, not "Java is not installed".
  const javaLaunchFailure =
    /java.*(is not recognized|not found|command not found|no such file|无法找到|找不到)|(no such file|无法找到|找不到).*java/i.test(
      lower,
    ) ||
    (lower.includes("jvm") && lower.includes("not found"));
  if (javaLaunchFailure) {
    return new PdfParseError("java-missing", error);
  }
  return new PdfParseError("parse-failed", error);
}