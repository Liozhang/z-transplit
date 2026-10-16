/**
 * OpenDataLoaderPdfClient — Local PDF → Markdown/JSON via opendataloader-pdf CLI (JVM).
 *
 * Uses opendataloader-pdf CLI (JVM) for local PDF parsing.
 * Uses nsIProcess.runwAsync to spawn `java -jar opendataloader-pdf-cli.jar`.
 *
 * Output contract:
 *  - format: `options.format ?? "json"`; parsePdfToMarkdown() pins "markdown"
 *  - imageOutput: `options.imageOutput ?? config.imageOutput`, i.e. pref-driven
 *    ("off" by default; "embedded" base64 data URIs inline when the
 *    pdfParser.opendataloader.returnImages pref is on)
 *  - the .json / .md file is read from the output directory after the JVM exits
 *
 * Ported from leadero's src/core/pdf/OpenDataLoaderPdfClient.ts. Changes:
 *   - `log` (leadero's verbose-gated channel) maps to this repo's dev-gated
 *     `debug` from src/utils/logger.ts;
 *   - every [Leadero ODL] / [Leadero] prefix and the leadero-odl-* temp-file
 *     prefix are renamed;
 *   - the addon-ID fallback is z-transplit's own;
 *   - packed-XPI installs: Zotero keeps plugins as a packed .xpi (rootURI is
 *     a jar: URI), so the bundled jars are inside a zip and `java -jar` can
 *     never find them on disk. getJarPath() extracts them to
 *     {DataDir}/ztransplit/lib/ on first use (SHA-256-checked against the
 *     shipped PROVENANCE*.json) — see extractJarFromPackedXpi.
 * Host-coupled (nsIProcess / nsIFile / Zotero.getTempDirectory) — not
 * unit-testable in Node.
 */

import { getPref } from "../../utils/prefs";
import { getCachedManagedJavaExe } from "./JavaRuntimeManager";
import { sha256Hex } from "../../utils/hash";
import {
  downloadPinnedJar,
  type DownloadProgress,
  type PinnedJarMeta,
} from "./OdlJarDownloader";
import { Semaphore } from "../../utils/Semaphore";
// `debug` is the dev-build-gated channel (see logger.ts): diagnostics that
// should stay off the always-on error console in production builds.
import { debug as log, safeDebug } from "../../utils/logger";
import { toErrorMessage } from "../../utils/error";
import { getString } from "../../utils/locale";

/** Limits concurrent JVM processes to prevent OOM under parallel PDF parsing.
 *  Each JVM consumes ~200-400MB RSS; 2 is a safe ceiling for typical machines. */
const JVM_SEMAPHORE = new Semaphore(2);

export interface OpenDataLoaderPdfConfig {
  tableMethod: string;
  readingOrder: string;
  useStructTree: boolean;
  timeout: number; // seconds
  /**
   * Image output mode passed to the jar's `--image-output` flag.
   *   - "off": no images
   *   - "embedded": base64 data URIs inline in JSON (required for the
   *     translate→split pipeline to composite figures back onto the page)
   *   - "external": file references (default; not useful in-process)
   * Default "off" — the pure heuristic engine emits no image elements anyway,
   * so this only matters when a hybrid AI backend is configured.
   */
  imageOutput: "off" | "embedded" | "external";
}

export interface OpenDataLoaderPdfParseOptions {
  startPage?: number;
  endPage?: number;
  format?: "markdown" | "json";
  signal?: AbortSignal;
  /**
   * Override the configured `--image-output` mode for this call. When omitted,
   * the pref-derived default (pdfParser.opendataloader.returnImages) is used.
   * The translate→split pipeline passes "embedded" so figures are composited
   * back onto the translated page regardless of the parser's global setting.
   */
  imageOutput?: "off" | "embedded" | "external";
}

export interface OpenDataLoaderPdfParseResult {
  success: boolean;
  markdown: string;
  json?: any;
  images: Record<string, string>; // filename → data:image/... base64
  source: "opendataloader-pdf";
  taskId?: string;
  error?: string;
}

export interface OpenDataLoaderJsonParseResult {
  success: boolean;
  data: any; // parsed JSON root (schema.json shape)
  source: "opendataloader-pdf";
  taskId?: string;
  error?: string;
}

interface HealthResult {
  healthy: boolean;
  version?: string;
  error?: string;
}

function loadConfig(): OpenDataLoaderPdfConfig {
  const rawTable = getPref("pdfParser.opendataloader.tableEnable");
  let tableMethod: string;
  if (typeof rawTable === "boolean") {
    // backward compatibility: old prefs stored true/false
    tableMethod = rawTable ? "cluster" : "default";
  } else {
    tableMethod = (rawTable as string) === "cluster" ? "cluster" : "default";
  }

  return {
    tableMethod,
    readingOrder: "xycut",
    useStructTree:
      (getPref("pdfParser.opendataloader.useStructTree") as boolean) ?? false,
    timeout: (getPref("pdfParser.opendataloader.timeout") as number) ?? 300,
    // returnImages pref now drives the jar's --image-output flag. When true,
    // emit base64 data URIs inline (so the JSON adapter can pick them up into
    // PdfChartArea.imageDataUri for downstream rendering).
    imageOutput: (getPref("pdfParser.opendataloader.returnImages") as boolean)
      ? "embedded"
      : "off",
  };
}

/**
 * Check whether Java is available on PATH.
 */
export async function checkHealth(): Promise<HealthResult> {
  // Refresh the managed-JRE cache first so resolveJavaExecutable() (sync) can
  // pick up a freshly-downloaded JRE without a Zotero restart. Dynamic import
  // to avoid a circular dependency (JavaRuntimeManager imports checkHealth).
  try {
    const { getManagedJavaExe } = await import("./JavaRuntimeManager");
    await getManagedJavaExe();
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    /* best-effort: fall through to system detection */
  }
  let javaExe = resolveJavaExecutable();
  log(`[Z-Transplit ODL] checkHealth: javaExe="${javaExe}"`);
  if (!javaExe) {
    return {
      healthy: false,
      error:
        "Java runtime not found. Please install Java 11+ and add it to PATH.",
    };
  }

  // Run `java -version` directly (NOT through the JAR) to verify Java works.
  // execJava() prepends `-jar <jarPath>` which would pass `-version` to the
  // opendataloader-pdf CLI and cause a non-zero exit.
  let result = await runProcess(javaExe, ["-version"], 10000);
  log(
    `[Z-Transplit ODL] checkHealth: java -version exitCode=${result.exitCode} timedOut=${result.timedOut}`,
  );
  // A managed JRE that exists but won't run (e.g. a truncated extraction)
  // must not poison every later parse: drop it — this also clears the sync
  // cache — and retry once with whatever remains, usually system PATH Java.
  if (result.exitCode !== 0 && javaExe === getCachedManagedJavaExe()) {
    try {
      const { discardManagedRuntime } = await import("./JavaRuntimeManager");
      await discardManagedRuntime();
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      /* best-effort */
    }
    const fallbackExe = resolveJavaExecutable();
    if (fallbackExe && fallbackExe !== javaExe) {
      javaExe = fallbackExe;
      result = await runProcess(javaExe, ["-version"], 10000);
      log(
        `[Z-Transplit ODL] checkHealth: retry javaExe="${javaExe}" exitCode=${result.exitCode}`,
      );
    }
  }
  if (result.exitCode !== 0) {
    return { healthy: false, error: result.stderr || "java -version failed" };
  }

  const versionMatch =
    result.stderr.match(/version "([^"]+)"/) ||
    result.stderr.match(/Java\(TM\) SE Runtime Environment.*"([^"]+)"/);
  const version = versionMatch ? versionMatch[1] : undefined;

  // Verify the major version is >= 11. The opendataloader-pdf jar is compiled
  // for Java 11 bytecode; running it on Java 8 crashes with a cryptic
  // UnsupportedClassVersionError instead of a clear "upgrade Java" message.
  // We extract the major version (for 1.x style "1.8" → 8, for modern "17.0.1" → 17).
  if (version) {
    let major: number | undefined;
    const parts = version.split(".");
    const first = parseInt(parts[0], 10);
    if (!Number.isNaN(first)) {
      major = first === 1 && parts.length > 1 ? parseInt(parts[1], 10) : first;
    }
    if (major !== undefined && !Number.isNaN(major) && major < 11) {
      return {
        healthy: false,
        error: getString("err-java-too-old", { version }),
      };
    }
  }

  return { healthy: true, version };
}

/**
 * Resolve the `java` executable using a PATH search over standard locations.
 */
function resolveJavaExecutable(): string | null {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const Services = (globalThis as any).Services as any;

  //    refreshes this cache on each health probe; if a managed JRE exists it
  //    wins over system PATH so the user never needs to touch PATH/restart.
  const managed = getCachedManagedJavaExe();
  if (managed) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    try {
      file.initWithPath(managed);
      if (file.exists() && file.isExecutable()) return managed;
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      /* bad cached path — fall through */
    }
  }

  const createFile = (path: string) => {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      return file;
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      return null;
    }
  };

  const isWindows = (
    Services.appinfo?.OS?.toUpperCase?.() ||
    (navigator as any)?.platform ||
    ""
  ).startsWith("WIN");
  const extensions = isWindows ? [".exe", ".cmd", ".bat", ""] : [""];
  const separator = isWindows ? ";" : ":";

  // Only standard install locations are probed — never a developer-machine path.
  const absoluteCandidates = isWindows
    ? [
        "C:\\Program Files\\Java\\jdk-17\\bin\\java.exe",
        "C:\\Program Files\\Eclipse Adoptium\\jdk-17\\bin\\java.exe",
        "C:\\Program Files\\Eclipse Adoptium\\jdk-11\\bin\\java.exe",
      ]
    : ["/usr/bin/java", "/usr/local/bin/java", "/opt/homebrew/bin/java"];

  for (const candidate of absoluteCandidates) {
    const file = createFile(candidate);
    if (file && file.exists() && file.isExecutable()) return candidate;
  }

  const env = Cc["@mozilla.org/process/environment;1"]?.getService(
    Ci.nsIEnvironment,
  );
  const pathStr = env?.get("PATH") || "";

  for (const dir of pathStr.split(separator)) {
    const dirTrimmed = dir.trim();
    if (!dirTrimmed) continue;

    for (const ext of extensions) {
      const candidate = dirTrimmed + (isWindows ? "\\" : "/") + "java" + ext;
      const file = createFile(candidate);
      if (file && file.exists() && file.isExecutable()) return candidate;
    }
  }

  return null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** M-20: set when the caller's AbortSignal (not a timeout) killed the process. */
  aborted?: boolean;
}

/**
 * Generic `java -jar <jarPath> <args…>` runner shared by every JVM-based tool
 * (OpenDataLoader parser, original-text remover). Refreshes the managed-JRE
 * cache, resolves the java executable, and enforces the JVM concurrency cap.
 */
export async function execJar(
  jarPath: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal, // M-20: thread cancellation into the process runner
): Promise<ExecResult> {
  // Refresh the managed-JRE cache before the sync resolver runs — on a cold
  // session (no prior checkHealth) resolveJavaExecutable() misses the managed
  // JRE entirely and every parse fast-fails "java executable not found".
  // Same dynamic import as checkHealth — JavaRuntimeManager imports checkHealth.
  try {
    const { getManagedJavaExe } = await import("./JavaRuntimeManager");
    await getManagedJavaExe();
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient.execJar: " + e);
    /* best-effort: fall through to system detection */
  }
  const javaExe = resolveJavaExecutable();
  if (!javaExe) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "java executable not found",
      timedOut: false,
    };
  }

  const commandArgs = [
    "-Djava.awt.headless=true",
    "-Dapple.awt.UIElement=true",
    "-jar",
    jarPath,
    ...args,
  ];

  const release = await JVM_SEMAPHORE.acquire();
  try {
    // M-20: pass the caller's AbortSignal down so user cancellation kills the
    // JVM immediately instead of waiting out the hard timeout.
    return await runProcess(javaExe, commandArgs, timeoutMs, signal);
  } finally {
    release();
  }
}

async function execJava(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const jarPath = await getJarPath();
  return execJar(jarPath, args, timeoutMs, signal);
}

// ─── Packed-XPI extraction fallback ──────────────────────────────────────────
// Zotero keeps installed plugins PACKED: extensions/<id>.xpi with a jar:
// rootURI. The bundled jars live inside that zip, `java -jar` needs real
// files, and none of the disk probes in getJarPath can ever succeed — this
// was the root cause of the misleading「解析组件缺失（未找到 jar 文件）」
// dialog on every normal (install-from-xpi) setup. On first use we extract
// core/pdf/lib/<jar> from the XPI into {DataDir}/ztransplit/lib/, verified
// against the SHA-256 that the PROVENANCE*.json shipped next to the jar
// declares; the verified copy is reused via a session memo, re-extracted
// when it goes missing or its hash stops matching (plugin update, truncated
// write, antivirus quarantine).

/** Session memo of verified extracted copies — keyed by jar file name. */
const extractedJarMemo = new Map<string, string>();

/**
 * 精简版安装（不含内置 jar）下载兜底的会话失败登记：失败一次后，本次会话
 * 内的后续解析不再重试整条“探测 + 下载”链路（离线时避免每次解析白等一轮）。
 * 重启 Zotero 或换网络环境后自然重置。
 */
const jarDownloadFailed = new Set<string>();

/**
 * 最近一次下载兜底的失败细节。runOpenDataLoader 把它附在「JAR file not
 * found」错误里，错误分类据此给出「下载失败、检查网络」而不是误导性的
 * 「请重新安装插件」。
 */
let lastJarProvisionFailure: string | null = null;

function joinPath(...parts: string[]): string {
  const { join } = (globalThis as any).PathUtils || {};
  if (join) return join(...parts);
  return parts.join("/");
}

/** {DataDir}/ztransplit/lib/ — where packed installs get their jars unpacked. */
function extractedJarPaths(jarFileName: string): { dir: string; target: string } {
  const dataDir = (globalThis as any).Zotero?.DataDirectory?.dir;
  if (!dataDir) {
    throw new Error(
      "Zotero.DataDirectory.dir is unavailable; cannot stage extracted jars",
    );
  }
  const dir = joinPath(String(dataDir), "ztransplit", "lib");
  return { dir, target: joinPath(dir, jarFileName) };
}

/**
 * jar:file:///C:/…%40addon.xpi!/ → file:///C:/…%40addon.xpi.
 * Pure string logic (percent-decoding happens in pathFromFileUrl via
 * nsIFileURL); returns null for anything that is not a jar-wrapped file URL,
 * i.e. for every unpacked install's plain file: rootURI. Exported for tests.
 */
export function fileUrlFromJarUri(
  rootURI: string | null | undefined,
): string | null {
  if (!rootURI || !rootURI.startsWith("jar:")) return null;
  const inner = rootURI.slice("jar:".length);
  if (!inner.startsWith("file:")) return null;
  const bang = inner.indexOf("!");
  const fileUrl = bang === -1 ? inner : inner.slice(0, bang);
  return fileUrl || null;
}

/** file: URL → native path (nsIFileURL performs the percent-decoding). */
function pathFromFileUrl(fileUrl: string): string | null {
  try {
    const Ci = (Components as any).interfaces;
    const file = (globalThis as any).Services.io
      .newURI(fileUrl)
      .QueryInterface(Ci.nsIFileURL).file;
    return file?.path || null;
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    return null;
  }
}

/** nsIZipReader.hasEntry with a getEntry fallback for older builds. */
function zipHasEntry(zipReader: any, entryPath: string): boolean {
  try {
    if (typeof zipReader.hasEntry === "function") {
      return !!zipReader.hasEntry(entryPath);
    }
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    /* fall through to getEntry */
  }
  try {
    return !!zipReader.getEntry(entryPath);
  } catch (e) {
    return false;
  }
}

/**
 * 读取 zip 里的小文本条目（随包 PROVENANCE*.json）。
 *
 * Gecko 的 nsIBinaryInputStream.readArrayBuffer 只接受「长度 + 预分配缓冲」
 * 的双参形式（Zotero 自身 mimeTypeHandler.js 即如此调用），单参返回 ArrayBuffer
 * 的写法从未在本宿主验证通过；小文件不值得再赌一条流式路径，统一走
 * nsIZipReader.extract 落到临时文件后按文本读回，用完即删。
 */
function readZipEntryText(zipReader: any, entryPath: string): string {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const tmpDir =
    (Zotero as any).getTempDirectory?.() ||
    Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsProperties)
      .get("TmpD", Ci.nsIFile);
  const tmpFile = tmpDir.clone();
  tmpFile.append(
    `ztransplit-zipread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  zipReader.extract(entryPath, tmpFile);
  try {
    return (globalThis as any).Zotero?.File?.getContents?.(tmpFile) || "";
  } finally {
    try {
      if (tmpFile.exists()) tmpFile.remove(false);
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    }
  }
}

/**
 * The reference SHA-256 for `jarFileName`, read from the PROVENANCE*.json
 * files shipped next to the jar (inside the same zip). Null when the build
 * predates the provenance files — the caller then skips verification.
 */
function readProvenanceSha256(
  zipReader: any,
  jarFileName: string,
): string | null {
  try {
    // Gecko 的 nsIZipReader 没有 getEntries()，条目枚举只有 findEntries()。
    const finder = zipReader.findEntries("*");
    while (finder.hasMore()) {
      const name = zipEntryName(finder.getNext());
      if (!/^core\/pdf\/lib\/PROVENANCE.*\.json$/.test(name)) continue;
      try {
        const meta = JSON.parse(readZipEntryText(zipReader, name));
        if (meta?.file === jarFileName && typeof meta?.sha256 === "string") {
          return meta.sha256.toLowerCase();
        }
      } catch (e) {
        safeDebug(
          `[Z-Transplit ODL] provenance entry ${name} unreadable: ${e}`,
        );
      }
    }
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
  }
  return null;
}

/**
 * Extract core/pdf/lib/<jarFileName> from the packed XPI at `xpiPath` into
 * {DataDir}/ztransplit/lib/ and return the on-disk path.
 *
 * An existing extracted copy is reused only after its SHA-256 matches the
 * provenance reference (so a plugin update or a corrupted file triggers a
 * clean re-extract); with no provenance reference available the copy is
 * accepted as-is. The entry is unpacked with nsIZipReader.extract into a
 * staging file and only takes the target's place after its bytes hash to the
 * provenance reference, so an interrupted or tampered write can never be
 * served. Throws on checksum mismatch, missing entry, or any zip/IO failure —
 * getJarPath treats that as "component unavailable" and falls through to its
 * not-found path. Exported for the unit suite (tests fake the host boundary).
 */
export async function extractJarFromPackedXpi(
  xpiPath: string,
  jarFileName: string,
): Promise<string> {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const IOUtils = (globalThis as any).IOUtils;

  const xpiFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  xpiFile.initWithPath(xpiPath);

  const zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    Ci.nsIZipReader,
  );
  zipReader.open(xpiFile);
  try {
    const entryPath = `core/pdf/lib/${jarFileName}`;
    if (!zipHasEntry(zipReader, entryPath)) {
      throw new Error(`zip entry ${entryPath} not found in ${xpiPath}`);
    }
    const expected = readProvenanceSha256(zipReader, jarFileName);

    const { dir, target } = extractedJarPaths(jarFileName);
    if (await IOUtils.exists(target)) {
      if (!expected) return target;
      const actual = await sha256Hex(await IOUtils.read(target));
      if (actual === expected) return target;
      log(
        `[Z-Transplit ODL] extracted jar hash mismatch (${jarFileName}), re-extracting: ${target}`,
      );
    }

    await IOUtils.makeDirectory(dir, { createAncestors: true });
    const staging = joinPath(
      dir,
      `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${jarFileName}`,
    );
    try {
      const stagingFile = Cc["@mozilla.org/file/local;1"].createInstance(
        Ci.nsIFile,
      );
      stagingFile.initWithPath(staging);
      zipReader.extract(entryPath, stagingFile);
      // 压缩条目可能携带只读权限位，会让后续的覆盖与清理失败——解压后立即
      // 改回普通权限（尽力而为）。
      try {
        await IOUtils.setPermissions(staging, 0o644);
      } catch (e) {
        safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      }
      if (expected) {
        const hash = await sha256Hex(await IOUtils.read(staging));
        if (hash !== expected) {
          throw new Error(
            `jar checksum mismatch for ${jarFileName}: expected ${expected}, got ${hash}`,
          );
        }
      }
      await IOUtils.remove(target, { ignoreAbsent: true });
      await IOUtils.move(staging, target);
    } catch (e) {
      try {
        await IOUtils.remove(staging, { ignoreAbsent: true });
      } catch (e2) {
        safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e2);
      }
      throw e;
    }
    log(
      `[Z-Transplit ODL] extracted ${jarFileName} from packed XPI → ${target}`,
    );
    return target;
  } finally {
    try {
      zipReader.close();
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    }
  }
}

/** nsIZipReader 枚举元素 → 条目名（不同 Gecko 版本元素类型不同，防御式处理）。 */
function zipEntryName(raw: any): string {
  try {
    if (typeof raw === "string") return raw;
    const Ci = (Components as any).interfaces;
    return (
      ((raw?.QueryInterface?.(Ci.nsISupportsCString)?.data ?? raw?.name) as
        | string
        | undefined) || ""
    );
  } catch (e) {
    return raw?.name ?? "";
  }
}

/**
 * 从随包分发的 PROVENANCE*.json 读取某个 jar 的固定指纹（版本、SHA-256、
 * 字节数）。解包安装读 core/pdf/lib/ 目录；打包安装从 XPI 压缩包内读取。
 * 精简版安装包不含 jar 但始终携带这些来源文件——它们是下载兜底的信任锚，
 * 找不到指纹时绝不发起下载。
 */
async function readPinnedJarMeta(
  jarFileName: string,
  sources: { baseDir?: string; packedXpiPath?: string | null },
): Promise<PinnedJarMeta | null> {
  const raw: any[] = [];
  if (sources.baseDir) {
    try {
      const libDir = joinPath(sources.baseDir, "core", "pdf", "lib");
      const children = (await (globalThis as any).IOUtils.getChildren(
        libDir,
      )) as string[];
      for (const child of children) {
        const name = child.split(/[\\/]/).pop() || "";
        if (!/^PROVENANCE.*\.json$/i.test(name)) continue;
        try {
          raw.push(
            JSON.parse(
              await (globalThis as any).IOUtils.readUTF8(child),
            ),
          );
        } catch (e) {
          safeDebug(
            `[Z-Transplit ODL] provenance file ${name} unreadable: ${e}`,
          );
        }
      }
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    }
  }
  if (sources.packedXpiPath) {
    try {
      const Cc = (Components as any).classes;
      const Ci = (Components as any).interfaces;
      const xpiFile = Cc["@mozilla.org/file/local;1"].createInstance(
        Ci.nsIFile,
      );
      xpiFile.initWithPath(sources.packedXpiPath);
      const zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
        Ci.nsIZipReader,
      );
      zipReader.open(xpiFile);
      try {
        // Gecko 的 nsIZipReader 没有 getEntries()，条目枚举只有 findEntries()。
        const finder = zipReader.findEntries("*");
        while (finder.hasMore()) {
          const name = zipEntryName(finder.getNext());
          if (!/^core\/pdf\/lib\/PROVENANCE.*\.json$/i.test(name)) continue;
          try {
            raw.push(JSON.parse(readZipEntryText(zipReader, name)));
          } catch (e) {
            safeDebug(
              `[Z-Transplit ODL] provenance entry ${name} unreadable: ${e}`,
            );
          }
        }
      } finally {
        try {
          zipReader.close();
        } catch (e) {
          safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
        }
      }
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    }
  }
  for (const meta of raw) {
    if (
      meta?.file === jarFileName &&
      typeof meta?.sha256 === "string" &&
      typeof meta?.version === "string"
    ) {
      return {
        file: meta.file,
        artifact: String(meta.artifact || ""),
        version: meta.version,
        sha256: (meta.sha256 as string).toLowerCase(),
        bytes: Number(meta.bytes) || 0,
      };
    }
  }
  return null;
}

/**
 * 流水线内触发的下载没有调用方界面——挂一个进度窗口让等待可见。
 * 全部 UI 调用尽力而为：窗口故障绝不阻断下载本身。
 */
function makeJarDownloadProgress(): ((p: DownloadProgress) => void) | undefined {
  try {
    const win = new (Zotero as any).ProgressWindow({
      window: (Zotero as any).getMainWindow?.() || null,
    });
    win.changeHeadline(getString("odl-jar-download-window"));
    win.show();
    let lastStep = -1;
    return (p: DownloadProgress) => {
      try {
        if (p.phase === "downloading") {
          // 每个网络分片都会触发进度事件（24MB 可达数百次），按 10% 步进汇报。
          const step = Math.floor((p.percent || 0) / 10) * 10;
          if (step === lastStep) return;
          lastStep = step;
        }
        if (p.phase === "failed") {
          win.addDescription(
            "✗ " + (p.message || getString("odl-error-jar-download-failed")),
          );
          win.startCloseTimer?.(15000);
          return;
        }
        if (p.message) win.addDescription(p.message);
        if (p.phase === "done") win.startCloseTimer?.(6000);
      } catch (e) {
        safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      }
    };
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    return undefined;
  }
}

/**
 * 解析插件安装根：baseDir（解包安装的目录，打包安装时为空串）与
 * packedXpiSource（打包安装时 .xpi 的磁盘路径，否则为 null）。getJarPath 与
 * getOdlJarStatus 共用这份定位逻辑——状态检查不触发下载，但必须与真实解析
 * 走同一套定位，否则面板显示与实际行为会分叉。
 */
async function resolveLibSources(): Promise<{
  baseDir: string;
  packedXpiSource: string | null;
}> {
  // Resolve relative to this file: src/core/pdf/lib/opendataloader-pdf-cli.jar
  // Note: zotero-plugin-scaffold strips the leading `src/` from build output,
  // so in the deployed extension the JAR lives at `core/pdf/lib/...`.
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const addonID =
    (globalThis as any).addon?.data?.config?.addonID || "ztransplit@zotero.org";

  // Where a PACKED XPI lives, when the install turns out to be packed. Set
  // from rootURI (authoritative) first, or from the profile scan below.
  let packedXpiSource: string | null = null;

  // ── Resolve the addon's install root ──────────────────────────────────────
  // Priority:
  //  1. Zotero.getAddonDirectory(addonID) / addon.getInstallPath() — legacy APIs,
  //                                               may be absent on Zotero 9;
  //                                               non-filesystem results
  //                                               (nsIURI/jar:/XPI) discarded
  //  2. bootstrap `rootURI` free variable       — file: URI converted to a dir;
  //                                               a jar:-wrapped URI (packed
  //                                               install) feeds the packedXpi
  //                                               source instead
  //  3. ProfD/extensions scan for "<addonID>" (dir); "<addonID>.xpi" (file)
  //                                               recorded as the packedXpi
  //                                               source
  //  4. relative fallbacks under baseDir / the scaffold build tree
  //  5. extraction from the packed XPI into {DataDir}/ztransplit/lib/
  let rawDir =
    (Zotero as any).getAddonDirectory?.(addonID) ||
    (Zotero as any).getAddon?.(addonID)?.getInstallPath?.() ||
    null;

  // M-22e-2: getInstallPath() on Zotero 9 may return a nsIURI whose .path is
  // empty (e.g. resource://ztransplit@zotero.org/) or a "jar:..." string. Both
  // look truthy but carry no usable filesystem path. Discard them so the
  // profile-scan fallback below actually runs.
  if (rawDir) {
    const pathStr =
      typeof rawDir === "string"
        ? rawDir
        : typeof rawDir === "object" && "path" in rawDir
          ? String((rawDir as any).path)
          : String(rawDir);
    if (
      !pathStr ||
      pathStr.startsWith("resource://") ||
      pathStr.startsWith("jar:")
    ) {
      rawDir = null;
    } else if (
      typeof rawDir !== "string" &&
      typeof (rawDir as any).isFile === "function" &&
      (rawDir as any).isFile()
    ) {
      // An XPI file is not a directory — downstream code expects a directory
      // tree containing `core/pdf/lib/...`.
      rawDir = null;
    }
  }

  // M-22e: getAddonDirectory is removed in Zotero 9 (Gecko 115+). Resolve the
  // install root from the bootstrap-provided rootURI instead. NOTE: rootURI is
  // a free variable on the bootstrap scope object (see typings/global.d.ts) —
  // globalThis.addon has NO rootURI property, so reading `addon?.rootURI`
  // always yields undefined and must not gate this block.
  if (!rawDir) {
    //    "file:///C:/.../extensions/<addonID>/" — convert directly via
    //    nsIFileURL to the addon directory.
    const uriStr = typeof rootURI !== "undefined" ? rootURI : "";
    log(`[Z-Transplit ODL] getJarPath: rootURI="${uriStr}"`);
    try {
      if (uriStr.startsWith("file:")) {
        const uriFile = (
          (globalThis as any).Services.io
            .newURI(uriStr)
            .QueryInterface(Ci.nsIFileURL) as any
        ).file;
        if (uriFile?.path) rawDir = uriFile;
      }
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      /* not a file: URI — fall through to the profile scan */
    }
    //    A jar:-wrapped rootURI means the plugin is installed PACKED — the
    //    bundled jar can only come from extracting the XPI, so remember its
    //    file path for the extraction fallback at the bottom.
    if (!rawDir && !packedXpiSource) {
      const jarFileUrl = fileUrlFromJarUri(uriStr);
      if (jarFileUrl) {
        packedXpiSource = pathFromFileUrl(jarFileUrl);
        log(
          `[Z-Transplit ODL] getJarPath: packed XPI from rootURI = "${packedXpiSource}"`,
        );
      }
    }
    //    Profile scan: ProfD is the real profile root (Zotero.DataDirectory.dir
    //    is the <profile>/zotero data subdir); nsIFile.append() keeps
    //    platform-native separators — string concat would produce mixed-slash
    //    paths that initWithPath rejects on Windows.
    if (!rawDir) {
      try {
        const dirService = Cc[
          "@mozilla.org/file/directory_service;1"
        ].getService((Components.interfaces as any).nsIProperties);
        const profileFile = dirService.get(
          "ProfD",
          (Components.interfaces as any).nsIFile,
        ) as nsIFile;
        const extDir = profileFile.clone();
        extDir.append("extensions");
        log(`[Z-Transplit ODL] getJarPath: extDir="${extDir.path}"`);
        if (extDir.exists() && extDir.isDirectory()) {
          const entries = extDir.directoryEntries;
          // <addonID>.xpi is a FILE, not a directory tree — the old code
          // accepted it as rawDir and built impossible paths like
          // "…\ztransplit@zotero.org.xpi\core\pdf\lib\…". Remember it as
          // the packed-install source for the extraction fallback instead.
          let packedXpiEntry: string | null = null;
          while (entries.hasMoreElements()) {
            const rawEntry = entries.getNext();
            const entry = rawEntry?.QueryInterface?.(
              Ci.nsIFile,
            ) as nsIFile | null;
            if (!entry) continue;
            const leaf = entry.leafName;
            if (leaf === `${addonID}.xpi`) {
              try {
                if (entry.isFile()) packedXpiEntry = entry.path;
              } catch (e) {
                safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
              }
              continue;
            }
            if (leaf === addonID) {
              // Match "<addonID>" (directory) only.
              try {
                if (entry.isDirectory()) {
                  rawDir = entry;
                  break;
                }
              } catch (e) {
                safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
              }
            }
          }
          if (!packedXpiSource && packedXpiEntry) {
            packedXpiSource = packedXpiEntry;
            log(
              `[Z-Transplit ODL] getJarPath: packed XPI from profile scan = "${packedXpiSource}"`,
            );
          }
        }
      } catch (e) {
        safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
        /* profile scan failed — fall through to relative-path candidates */
      }
    }
  }

  const baseDir = rawDir ? String(rawDir.path ?? rawDir) : "";
  return { baseDir, packedXpiSource };
}

export async function getJarPath(
  jarFileName = "opendataloader-pdf-cli.jar",
  opts: { allowDownload?: boolean } = {},
): Promise<string> {
  // Session memo: once a packed-XPI install has a verified extracted copy,
  // every later call short-circuits here (no probing, no re-hashing).
  const IOUtils = (globalThis as any).IOUtils;
  const memoed = extractedJarMemo.get(jarFileName);
  if (memoed) {
    try {
      if (await IOUtils.exists(memoed)) return memoed;
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    }
    extractedJarMemo.delete(jarFileName);
  }

  const { join } = (globalThis as any).PathUtils || {};
  const { baseDir, packedXpiSource } = await resolveLibSources();

  log(
    `[Z-Transplit ODL] getJarPath: baseDir="${baseDir}" PathUtils.join=${!!join}`,
  );

  const relative = ["core", "pdf", "lib", jarFileName];

  // PathUtils.join does not accept an empty first segment.
  if (baseDir && join) {
    const joined = join(baseDir, ...relative);
    // M-22b: validate the joined path before returning — in dev environments
    // getAddonDirectory may return a path whose layout doesn't match the
    // source tree (e.g. the JAR lives under `src/` which is stripped in the
    // built XPI). Fall through to the existence-check loop when missing.
    try {
      if (await IOUtils.exists(joined)) return joined;
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      /* fall through */
    }
  }

  // M-22: nsIFile.initWithPath on Windows rejects mixed or forward-slash paths.
  const isWin = (Zotero as any).isWin;
  const normalize = (p: string) =>
    isWin ? p.replace(/[/\\]+/g, "\\") : p.replace(/[/\\]+/g, "/");

  const candidates: string[] = [];
  if (baseDir) {
    // M-22c: in dev installs getAddonDirectory may return the project root
    // while the JAR lives under `src/`. Try both layouts.
    candidates.push(normalize(baseDir + "/" + relative.join("/")));
    candidates.push(normalize(baseDir + "/src/" + relative.join("/")));
  }
  candidates.push(
    normalize(`.scaffold/build/addon/core/pdf/lib/${jarFileName}`),
    normalize(`core/pdf/lib/${jarFileName}`),
  );

  for (const candidate of candidates) {
    try {
      let exists = false;
      if (typeof IOUtils !== "undefined" && IOUtils.exists) {
        exists = await IOUtils.exists(candidate);
      } else if (typeof Zotero.File !== "undefined" && (Zotero.File as any).exists) {
        // zotero-types 4.1+ no longer declares Zotero.File.exists; the runtime
        // probe stays (some Zotero builds expose it) but the type does not.
        exists = await (Zotero.File as any).exists(candidate);
      }
      log(
        `[Z-Transplit ODL] getJarPath candidate: ${candidate} → ${exists ? "FOUND" : "not found"}`,
      );
      if (exists) return candidate;
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      log(`[Z-Transplit ODL] getJarPath candidate: ${candidate} → ERROR`);
      // ignore and try next candidate
    }
  }

  // ── Packed-XPI extraction fallback ────────────────────────────────────────
  // Every disk probe failed. When the plugin is installed as a packed XPI,
  // the bundled jar exists only inside that zip — unpack it (SHA-256-checked
  // against the shipped provenance file) and serve the copy. This is what
  // makes a normal install-from-xpi work at all.
  if (packedXpiSource) {
    try {
      const extracted = await extractJarFromPackedXpi(packedXpiSource, jarFileName);
      extractedJarMemo.set(jarFileName, extracted);
      return extracted;
    } catch (e) {
      // Loud: losing this detail is the difference between "works" and the
      // misleading「解析组件缺失」dialog.
      safeDebug(
        `[Z-Transplit ODL] getJarPath: extraction from packed XPI failed: ${e}`,
      );
      try {
        (globalThis as any).Zotero?.logError?.(e);
      } catch (e2) {
        safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e2);
        /* best-effort */
      }
    }
  }

  // ── Download fallback (slim builds) ───────────────────────────────────────
  // 精简版安装包不内置 24MB 的解析组件：按随包分发的 PROVENANCE 指纹从镜像
  // 取件（探测择优 → 整包下载 → 解包核对 SHA-256 → 原子落地）。会话内失败
  // 一次即止，避免离线时每次解析都重跑整条探测链路。
  if (
    opts.allowDownload !== false &&
    (packedXpiSource || baseDir) &&
    !jarDownloadFailed.has(jarFileName)
  ) {
    const meta = await readPinnedJarMeta(jarFileName, {
      baseDir: baseDir || undefined,
      packedXpiPath: packedXpiSource,
    });
    if (meta) {
      try {
        const paths = extractedJarPaths(jarFileName);
        const downloaded = await downloadPinnedJar(
          meta,
          paths,
          makeJarDownloadProgress(),
        );
        extractedJarMemo.set(jarFileName, downloaded);
        return downloaded;
      } catch (e) {
        jarDownloadFailed.add(jarFileName);
        lastJarProvisionFailure = String(e);
        safeDebug(
          `[Z-Transplit ODL] getJarPath: download fallback failed: ${e}`,
        );
        try {
          (globalThis as any).Zotero?.logError?.(e);
        } catch (e2) {
          safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e2);
          /* best-effort */
        }
      }
    }
  }

  // Last resort: return the relative path under baseDir and let the caller
  // surface the resulting file-not-found error.
  const fallback = normalize(
    baseDir
      ? `${baseDir}/${relative.join("/")}`
      : `./core/pdf/lib/${jarFileName}`,
  );
  log(`[Z-Transplit ODL] getJarPath fallback: ${fallback}`);
  return fallback;
}

/** 设置面板「解析组件」小节的状态读数（Zotero.ZTransplit.odlJar.getStatus）。 */
export interface OdlJarStatus {
  /** 组件当前可用（落地副本指纹相符，或随包内置/解包安装树里存在）。 */
  present: boolean;
  /** PROVENANCE 声明的组件版本；来源文件缺失或不可读时为 undefined。 */
  version?: string;
  /** present 时的位置类别：landed=数据目录副本，bundled=随包内置或安装树。 */
  source?: "landed" | "bundled";
  /** 组件的磁盘路径（bundled 且未解压时没有）。 */
  path?: string;
  /** 数据目录副本存在但指纹与 PROVENANCE 不符——解析时会自动重新获取。 */
  stale?: boolean;
}

/** 打包安装的 XPI 里是否内置了某个 jar（完整版构建为真，精简版为假）。 */
function packedXpiBundlesJar(xpiPath: string, jarFileName: string): boolean {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const xpiFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  xpiFile.initWithPath(xpiPath);
  const zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    Ci.nsIZipReader,
  );
  zipReader.open(xpiFile);
  try {
    return zipHasEntry(zipReader, `core/pdf/lib/${jarFileName}`);
  } finally {
    try {
      zipReader.close();
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    }
  }
}

/**
 * 解析组件状态检查（只读，不触发下载/解压）：设置面板的「检查状态」按钮
 * 调用。定位逻辑与 getJarPath 相同（resolveLibSources），按“数据目录落地
 * 副本 → 打包 XPI 内置 → 解包安装树”的顺序判断组件是否可用。
 */
export async function getOdlJarStatus(
  jarFileName = "opendataloader-pdf-cli.jar",
): Promise<OdlJarStatus> {
  const IOUtils = (globalThis as any).IOUtils;
  const { baseDir, packedXpiSource } = await resolveLibSources();
  const meta = await readPinnedJarMeta(jarFileName, {
    baseDir: baseDir || undefined,
    packedXpiPath: packedXpiSource,
  });
  const version = meta?.version;

  // 1) 数据目录落地副本（精简版下载的，或打包安装解压出来的）。
  try {
    const { target } = extractedJarPaths(jarFileName);
    if (await IOUtils.exists(target)) {
      // 指纹不符视为不可用：getJarPath 在真实解析时会自动重新获取，
      // 「下载 / 修复」按钮则立即修复。
      let stale = false;
      if (meta) {
        stale = (await sha256Hex(await IOUtils.read(target))) !== meta.sha256;
      }
      return {
        present: !stale,
        stale,
        version,
        source: "landed",
        path: target,
      };
    }
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
  }

  // 2) 打包安装：jar 内置在 XPI 里（完整版构建）。
  if (packedXpiSource) {
    try {
      if (packedXpiBundlesJar(packedXpiSource, jarFileName)) {
        return { present: true, version, source: "bundled" };
      }
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    }
  }

  // 3) 解包安装（开发目录）：jar 就在安装树里。
  if (baseDir) {
    try {
      const candidate = joinPath(baseDir, "core", "pdf", "lib", jarFileName);
      if (await IOUtils.exists(candidate)) {
        return { present: true, version, source: "bundled", path: candidate };
      }
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    }
  }

  return { present: false, version };
}

/**
 * 「下载 / 修复」入口（Zotero.ZTransplit.odlJar.install）：清掉会话失败
 * 登记与已验证副本备忘后重走 getJarPath——落地副本完好且指纹相符时直接
 * 返回，缺失或损坏时触发解压/下载（进度窗口挂在主窗口）。取不到组件时
 * 抛错，错误消息带上最后一次下载失败的细节供界面归因。
 */
export async function installOdlJar(
  jarFileName = "opendataloader-pdf-cli.jar",
): Promise<string> {
  const IOUtils = (globalThis as any).IOUtils;
  // 完好的落地副本直接返回：修复按钮不该为一次例行核对弹出进度窗口。
  try {
    const status = await getOdlJarStatus(jarFileName);
    if (status.present && status.source === "landed" && status.path) {
      extractedJarMemo.set(jarFileName, status.path);
      return status.path;
    }
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
  }
  jarDownloadFailed.delete(jarFileName);
  extractedJarMemo.delete(jarFileName);
  lastJarProvisionFailure = null;
  const path = await getJarPath(jarFileName);
  let ok = false;
  try {
    ok = await IOUtils.exists(path);
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
  }
  if (!ok) {
    throw new Error(
      `ODL jar provision failed${
        lastJarProvisionFailure ? `: ${lastJarProvisionFailure}` : ""
      }`,
    );
  }
  return path;
}

// ─── External process runner ────────────────────────────────────────────────
//
// Windows: Zotero's Subprocess.sys.mjs (CreateProcessW + Job Object) launches
//   the JVM directly from a raw argv — no .bat, no cmd.exe, no capture files —
//   so Unicode paths and shell metacharacters survive whatever the console
//   code page is. Both output streams are piped and drained in parallel.
// Unix: unchanged `/bin/sh -c 'exec … > out 2> err'` via nsIProcess.runwAsync
//   with capture files; only failure diagnostics and cleanup were fixed.

/** Result ownership: the first terminal intent (exit / timeout / abort / launch
 *  failure) wins; later kill-caused exit events never rewrite it. */
type RunOutcome =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout" }
  | { kind: "abort" }
  | { kind: "launch-failure"; message: string };

/** Windows-only: pin the JVM's default charset and stdio stream encodings to
 *  UTF-8 so Chinese paths/messages round-trip under a CP936 host. Prepended to
 *  the caller's argv — every runProcess caller invokes Java, and JVM options
 *  must precede the main class / -jar. */
const WINDOWS_JVM_ENCODING_ARGS = [
  "-Dfile.encoding=UTF-8",
  "-Dstdout.encoding=UTF-8",
  "-Dstderr.encoding=UTF-8",
];

function isWindowsHost(): boolean {
  const Services = (globalThis as any).Services as any;
  return (
    Services?.appinfo?.OS?.toUpperCase?.() ||
    (globalThis as any).navigator?.platform ||
    ""
  ).startsWith("WIN");
}

function getSubprocess(): any {
  const { Subprocess } = (globalThis as any).ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  return Subprocess;
}

/** Assemble the final ExecResult from the owning outcome plus whatever output
 *  was captured. Control hints ("Process timed out" / "aborted") lead the
 *  stderr so they stay recognizable after UI truncation; capture failures are
 *  appended and never replace the original cause or the real exit code. */
function buildRunResult(
  outcome: RunOutcome,
  stdout: string,
  stderr: string,
  captureErrors: string[],
): ExecResult {
  const extras = captureErrors.filter(Boolean);
  const join = (...parts: string[]) => parts.filter(Boolean).join("\n");
  switch (outcome.kind) {
    case "timeout":
      return {
        exitCode: -1,
        stdout,
        stderr: join("Process timed out", stderr, ...extras),
        timedOut: true,
      };
    case "abort":
      return {
        exitCode: -1,
        stdout,
        stderr: join("aborted", stderr, ...extras),
        timedOut: false,
        aborted: true,
      };
    case "launch-failure":
      return {
        exitCode: -1,
        stdout,
        stderr: join(outcome.message, stderr, ...extras),
        timedOut: false,
      };
    case "exit":
      return {
        exitCode: outcome.exitCode,
        stdout,
        stderr: join(stderr, ...extras),
        timedOut: false,
      };
  }
}

/**
 * Run an external process and capture both output streams. See the runner
 * notes above for the per-platform launch mechanisms. Shared contract:
 * `runProcess(resolvedExe, args, timeoutMs, signal?)` → real exit code plus
 * full stdout/stderr; timeout and cancellation stay distinguishable sentinels.
 */
export function runProcess(
  resolvedExe: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal, // M-20: cooperative cancellation
): Promise<ExecResult> {
  // M-20: already cancelled before spawn — don't even start the JVM.
  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: -1,
      stdout: "",
      stderr: "aborted",
      timedOut: false,
      aborted: true,
    });
  }
  return isWindowsHost()
    ? runProcessWindows(resolvedExe, args, timeoutMs, signal)
    : runProcessUnix(resolvedExe, args, timeoutMs, signal);
}

/** Drain one InputPipe to EOF with the streaming UTF-8 reader. `readString()`
 *  returns one chunk per call and an empty string at end of stream; an empty
 *  chunk while the pipe is still open is a partial multi-byte sequence held by
 *  the decoder, so reading must continue. A read failure keeps what was already
 *  captured and reports it — it must not throw past the caller. */
async function drainPipe(
  pipe: any,
  sink: string[],
  label: string,
  captureErrors: string[],
  onReadFailure: () => void,
): Promise<void> {
  if (!pipe) return;
  try {
    for (;;) {
      const chunk = await pipe.readString();
      if (chunk) {
        sink.push(chunk);
        continue;
      }
      if (pipe.closed !== false) break; // EOF
      // Empty decode with the pipe still open: wait for the rest of the char.
    }
  } catch (e) {
    captureErrors.push(`${label} capture failed: ${toErrorMessage(e)}`);
    onReadFailure();
  }
}

async function runProcessWindows(
  resolvedExe: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  // Held in a box so async continuation points don't fight TS control-flow
  // narrowing of a reassigned local.
  const state: { outcome: RunOutcome | null } = { outcome: null };
  let proc: any = null;
  let waitSettled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  let killPromise: Promise<void> | null = null;
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const captureErrors: string[] = [];

  const claim = (o: RunOutcome): boolean => {
    if (state.outcome) return false;
    state.outcome = o;
    return true;
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const detachAbort = () => {
    if (onAbort && signal) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch (e) {
        safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      }
      onAbort = null;
    }
  };

  // Subprocess.kill(0) force-terminates the Windows Job Object, so the whole
  // process tree goes away; it resolves with the real termination code once
  // the process has exited. Never fire-and-forget: the returned promise is
  // awaited before this call settles (and thus before execJar releases its
  // JVM slot). A no handle yet means there is nothing to kill — the stop
  // intent stays recorded and the spawn path kills the late handle on arrival.
  const killRunning = (): Promise<void> => {
    if (!proc) return Promise.resolve();
    if (!killPromise) {
      killPromise = (async () => {
        try {
          await proc.kill(0);
        } catch (e) {
          captureErrors.push("kill failed: " + toErrorMessage(e));
        }
      })();
    }
    return killPromise;
  };

  const requestStop = (kind: "timeout" | "abort"): void => {
    // First terminal intent owns the result; duplicate/late events are no-ops.
    if (!claim({ kind })) return;
    if (proc) void killRunning();
    // With no handle yet the stop intent is recorded and the spawn path below
    // kills the late handle as soon as it arrives — never return early and
    // leave the process unmanaged.
  };

  // Timeout and abort hooks go in BEFORE spawning so they also cover the
  // async Subprocess.call startup window.
  timer = setTimeout(() => requestStop("timeout"), timeoutMs);
  if (signal) {
    onAbort = () => requestStop("abort");
    signal.addEventListener("abort", onAbort, { once: true });
    // Re-check after registering to close the check/register race.
    if (signal.aborted) requestStop("abort");
    if (state.outcome?.kind === "abort" && !proc) {
      // Pre-spawn cancellation: the JVM is never started.
      clearTimer();
      detachAbort();
      return buildRunResult(
        state.outcome,
        stdoutParts.join(""),
        stderrParts.join(""),
        captureErrors,
      );
    }
  }

  try {
    const Subprocess = getSubprocess();
    proc = await Subprocess.call({
      command: resolvedExe,
      arguments: [...WINDOWS_JVM_ENCODING_ARGS, ...args],
      stderr: "pipe",
    });
  } catch (e: any) {
    // Bad executable / worker error: a real launch failure — keep the real
    // exception text and stay distinguishable from a non-zero JVM exit.
    clearTimer();
    detachAbort();
    const message = toErrorMessage(e);
    if (!claim({ kind: "launch-failure", message })) {
      // A stop intent already owns the result; keep the launch error visible
      // instead of silently swallowing it.
      captureErrors.push(message);
    }
    return buildRunResult(
      state.outcome!,
      stdoutParts.join(""),
      stderrParts.join(""),
      captureErrors,
    );
  }

  // Timeout/abort recorded during the startup window: kill the late handle now.
  if (state.outcome?.kind === "timeout" || state.outcome?.kind === "abort") {
    await killRunning();
  }

  // No stdin input is ever written; close our end immediately.
  try {
    await proc.stdin?.close();
  } catch (e) {
    captureErrors.push("stdin close failed: " + toErrorMessage(e));
  }

  // Drain both pipes concurrently from the first moment — a full pipe buffer
  // must never deadlock the child. A read failure keeps captured content and,
  // if the process is still running, stops it so the run can finalize and
  // still report the actual termination code.
  const onReadFailure = () => {
    if (!waitSettled) void killRunning();
  };
  const readers = [
    drainPipe(proc.stdout, stdoutParts, "stdout", captureErrors, onReadFailure),
    drainPipe(proc.stderr, stderrParts, "stderr", captureErrors, onReadFailure),
  ];

  let exitCode = -1;
  try {
    const info = await proc.wait();
    const code = Number(info?.exitCode);
    // Unknown exit codes are never reported as success.
    exitCode = Number.isInteger(code) ? code : -1;
  } catch (e) {
    captureErrors.push("wait failed: " + toErrorMessage(e));
  } finally {
    waitSettled = true;
  }
  // Natural completion claims the result only if no stop intent got there
  // first — a kill-caused exit code (e.g. -9) must not overwrite timeout/abort.
  claim({ kind: "exit", exitCode });

  await Promise.all(readers);
  if (killPromise) await killPromise;

  clearTimer();
  detachAbort();
  // Close any pipe still open (stdin was closed at spawn; an EOF'd pipe is
  // already closed). A close failure is recorded but never overwrites the
  // captured result.
  for (const p of [proc?.stdout, proc?.stderr]) {
    try {
      if (p && !p.closed) await p.close();
    } catch (e) {
      captureErrors.push("pipe close failed: " + toErrorMessage(e));
    }
  }

  return buildRunResult(
    state.outcome ?? { kind: "exit", exitCode: -1 },
    stdoutParts.join(""),
    stderrParts.join(""),
    captureErrors,
  );
}

/** Read the nsIProcess exit value defensively: subject (QI'd to nsIProcess)
 *  first, then the local handle; null when it cannot be read — callers must
 *  never substitute 0 for "unknown". */
function readExitValueSafe(subject: any, proc: any): number | null {
  const Ci = (Components as any)?.interfaces;
  const tryRead = (obj: any): number | null => {
    try {
      if (!obj) return null;
      let o = obj;
      if (Ci?.nsIProcess && typeof o.QueryInterface === "function") {
        try {
          o = o.QueryInterface(Ci.nsIProcess);
        } catch {
          /* keep the raw object */
        }
      }
      const v = o.exitValue;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  return tryRead(subject) ?? tryRead(proc);
}

function runProcessUnix(
  resolvedExe: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const Cc = (Components as any).classes;
    const Ci = (Components as any).interfaces;

    let proc: any = null;
    let outcome: RunOutcome | null = null;
    let settled = false;
    let onAbort: (() => void) | null = null;
    const captureErrors: string[] = [];

    const claim = (o: RunOutcome): boolean => {
      if (outcome) return false;
      outcome = o;
      return true;
    };

    const tmpDir =
      (Zotero as any).getTempDirectory?.() ||
      Cc["@mozilla.org/file/directory_service;1"]
        .getService(Ci.nsProperties)
        .get("TmpD", Ci.nsIFile);

    const ts = Date.now();
    const makeFile = (suffix: string) => {
      const f = tmpDir.clone();
      f.append(`ztransplit-odl-${ts}-${suffix}.txt`);
      return f.path;
    };
    const stdoutPath = makeFile("out");
    const stderrPath = makeFile("err");

    // L-28: hard-timeout handle, cleared whenever the run settles early.
    let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const clearHardTimeout = () => {
      if (hardTimeoutId !== null) {
        clearTimeout(hardTimeoutId);
        hardTimeoutId = null;
      }
    };

    const removeIfExists = (path: string) => {
      try {
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(path);
        if (f.exists()) f.remove(false);
      } catch (e) {
        safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      }
    };

    const cleanup = () => {
      clearHardTimeout();
      if (onAbort) {
        try {
          signal?.removeEventListener("abort", onAbort);
        } catch (e) {
          safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
        }
        onAbort = null;
      }
      // Remove the stdout/stderr capture files — previously these leaked on
      // every jar invocation, accumulating in the temp dir over time.
      removeIfExists(stdoutPath);
      removeIfExists(stderrPath);
    };

    // Independent reads: one missing/broken capture file must not block the
    // other stream, and natural exits read before cleanup deletes them.
    const readCapture = (path: string, label: string): string => {
      try {
        const Z = (globalThis as any).Zotero;
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        if (!file.exists()) return "";
        return Z?.File?.getContents?.(file) || "";
      } catch (e) {
        captureErrors.push(`${label} capture failed: ${toErrorMessage(e)}`);
        return "";
      }
    };

    const finish = (fallbackHint?: string) => {
      if (settled) return;
      settled = true;
      const stdout = readCapture(stdoutPath, "stdout");
      const stderr = readCapture(stderrPath, "stderr");
      cleanup();
      let o: RunOutcome = outcome ?? { kind: "exit", exitCode: -1 };
      // process-failed with an unreadable exit value and no output at all is
      // the one case that still gets the launch-failure hint; any captured
      // diagnostics take precedence so runtime failures are never rewritten
      // into "Process failed to launch".
      if (
        o.kind === "exit" &&
        o.exitCode === -1 &&
        fallbackHint &&
        !stdout &&
        !stderr
      ) {
        o = { kind: "launch-failure", message: fallbackHint };
      }
      resolve(buildRunResult(o, stdout, stderr, captureErrors));
    };

    const observer = {
      observe: (subject: any, topic: string) => {
        if (settled) return;
        if (topic !== "process-finished" && topic !== "process-failed") {
          // Unknown topics are not completions at all — and never "success".
          return;
        }
        // Both completion topics share one read-output-then-cleanup path and
        // propagate the REAL exit value; -1 only when it cannot be read.
        const code = readExitValueSafe(subject, proc);
        if (!claim({ kind: "exit", exitCode: code ?? -1 })) return;
        finish(
          topic === "process-failed" ? "Process failed to launch" : undefined,
        );
      },
      QueryInterface: (iid: any) => {
        if (iid.equals(Ci.nsIObserver) || iid.equals(Ci.nsISupports))
          return observer;
        throw Components.results.NS_NOINTERFACE;
      },
    };

    try {
      // Unix: shell wrapper with redirection. `exec` makes sh REPLACE itself
      // with the target process, so proc.pid is the JVM itself and
      // proc.kill() cannot orphan it.
      const shPath = "/bin/sh";
      const cmd = buildUnixCommand(resolvedExe, args, stdoutPath, stderrPath);

      const shellFile = Cc["@mozilla.org/file/local;1"].createInstance(
        Ci.nsIFile,
      );
      shellFile.initWithPath(shPath);
      proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      proc.init(shellFile);
      proc.runwAsync(["-c", cmd], 2, observer);
    } catch (e: any) {
      // Sync init/runwAsync failure: clean up anything already created and
      // keep the real exception as a genuine launch failure.
      claim({ kind: "launch-failure", message: toErrorMessage(e) });
      finish();
      return;
    }

    // Hard timeout: kill the process tree and settle only after the kill has
    // completed and the capture files were read (no fire-and-forget).
    hardTimeoutId = setTimeout(() => {
      if (!claim({ kind: "timeout" })) return;
      void (async () => {
        await killProcessTree(proc);
        finish();
      })();
    }, timeoutMs);

    // M-20: cooperative cancellation — mirror the hard-timeout path.
    if (signal) {
      onAbort = () => {
        if (!claim({ kind: "abort" })) return;
        void (async () => {
          await killProcessTree(proc);
          finish();
        })();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Summarize a non-zero JVM exit for the error path. The exit code leads so the
 * UI's 200-char truncation can never drop it; both streams are kept, labelled,
 * so upstream errors never silently lose stdout when stderr is present.
 */
export function formatJavaExitError(
  result: Pick<ExecResult, "exitCode" | "stdout" | "stderr">,
): string {
  const parts = [`java exited with code ${result.exitCode}`];
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (stderr) parts.push(`stderr: ${stderr}`);
  if (stdout) parts.push(`stdout: ${stdout}`);
  return parts.join("\n");
}

function buildUnixCommand(
  command: string,
  args: string[],
  stdoutPath: string,
  stderrPath: string,
): string {
  const esc = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  // M-19: `exec` makes sh REPLACE itself with the target process, so
  // proc.pid is the JVM itself and proc.kill() cannot orphan it (previously
  // kill only hit /bin/sh, leaving java.exe running with 200-400MB).
  return `exec ${esc(command)} ${args.map((a) => esc(a)).join(" ")} > ${esc(stdoutPath)} 2> ${esc(stderrPath)}`;
}

/**
 * M-19 (Windows half): nsIProcess.kill() only terminates the immediate child
 * (cmd.exe running the .bat), orphaning the JVM. taskkill /T /F takes down the
 * whole process tree. Best-effort — falls back to a plain kill().
 */
async function killProcessTree(proc: any): Promise<void> {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  try {
    if (!proc?.isRunning) return;
    const pid: number | undefined = proc.pid;
    const isWindows = Zotero.isWin;
    if (isWindows && pid) {
      const env = Cc["@mozilla.org/process/environment;1"]?.getService(
        Ci.nsIEnvironment,
      );
      const sysRoot = env?.get("SystemRoot") || "C:\\Windows";
      const taskkillPath = `${sysRoot}\\System32\\taskkill.exe`;
      const tkFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      tkFile.initWithPath(taskkillPath);
      if (!tkFile.exists()) {
        proc.kill();
        return;
      }
      const tkProc = Cc["@mozilla.org/process/util;1"].createInstance(
        Ci.nsIProcess,
      );
      tkProc.init(tkFile);
      await new Promise<void>((resolve) => {
        const obs = {
          observe: () => resolve(),
          QueryInterface: (iid: any) => {
            if (iid.equals(Ci.nsIObserver) || iid.equals(Ci.nsISupports))
              return obs;
            throw Components.results.NS_NOINTERFACE;
          },
        };
        try {
          tkProc.runwAsync(["/T", "/F", "/PID", String(pid)], 4, obs);
        } catch (e) {
          safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
          resolve();
        }
        // Never hang the timeout path on taskkill itself.
        setTimeout(resolve, 10_000);
      });
      return;
    }
    proc.kill();
  } catch (e) {
    safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
    try {
      proc.kill();
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      /* already dead */
    }
  }
}

export function writeTempFile(content: string, ext: string): string {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;

  const tmpDir =
    (Zotero as any).getTempDirectory?.() ||
    Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsProperties)
      .get("TmpD", Ci.nsIFile);

  const file = tmpDir.clone();
  file.append(`ztransplit-odl-${Date.now()}.${ext}`);

  const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
    Ci.nsIFileOutputStream,
  );
  stream.init(file, -1, -1, 0);
  const converter = Cc[
    "@mozilla.org/intl/converter-output-stream;1"
  ].createInstance(Ci.nsIConverterOutputStream);
  converter.init(stream, "UTF-8", 0, 0);
  converter.writeString(content);
  converter.close();

  return file.path;
}

export function createTempDir(): string {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const tmpDir =
    (Zotero as any).getTempDirectory?.() ||
    Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsProperties)
      .get("TmpD", Ci.nsIFile);

  const dir = tmpDir.clone();
  dir.append(`ztransplit-odl-${Date.now()}`);
  dir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  return dir.path;
}

export function readFile(path: string): Promise<string> {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const Z = (globalThis as any).Zotero;

  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);

  if (Z?.File?.getContents) {
    return Promise.resolve(Z.File.getContents(file) || "");
  }

  return new Promise((resolve) => {
    const stream = Cc[
      "@mozilla.org/network/file-input-stream;1"
    ].createInstance(Ci.nsIFileInputStream);
    stream.init(file, -1, -1, 0);
    const converter = Cc[
      "@mozilla.org/intl/converter-input-stream;1"
    ].createInstance(Ci.nsIConverterInputStream);
    converter.init(stream, "UTF-8", 0, 0);
    const parts: string[] = [];
    let out: any;
    while (converter.readString(4096, (out = {}))) {
      parts.push(out.value);
    }
    converter.close();
    resolve(parts.join(""));
  });
}

export function removePath(path: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const Cc = (Components as any).classes;
      const Ci = (Components as any).interfaces;
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      if (file.exists()) {
        file.remove(true);
      }
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      // best-effort
    }
    resolve();
  });
}

/**
 * Extract embedded base64 images from markdown.
 * Returns a map of filename → data:image/... URI.
 */
function extractImagesFromMarkdown(markdown: string): Record<string, string> {
  const images: Record<string, string> = {};

  // L-25: images with the same alt text used to overwrite each other (map is
  // keyed by filename, so only the last duplicate survived). De-dup by
  // appending -2/-3… suffixes. The markdown itself keeps inline data URIs, so
  // no body-text reference needs rewriting.
  const uniqueName = (base: string) => {
    let name = `${base}.png`;
    let n = 2;
    while (Object.prototype.hasOwnProperty.call(images, name)) {
      name = `${base}-${n++}.png`;
    }
    return name;
  };

  // Match Markdown image syntax: ![alt](data:image/png;base64,....)
  // Also match HTML <img src="data:image/..."> as fallback.
  const mdRegex =
    /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/g;
  let match;
  while ((match = mdRegex.exec(markdown)) !== null) {
    const alt = match[1] || `image-${Object.keys(images).length + 1}`;
    const dataUri = match[2];
    images[uniqueName(alt)] = dataUri;
  }

  // HTML img fallback
  const htmlRegex = /<img[^>]+src="(data:image\/[^"]+)"[^>]*>/g;
  while ((match = htmlRegex.exec(markdown)) !== null) {
    const dataUri = match[1];
    const base = `image-${Object.keys(images).length + 1}`;
    images[uniqueName(base)] = dataUri;
  }

  return images;
}

/**
 * Shared runner: invoke the OpenDataLoader JAR and return the raw output
 * string regardless of format.
 */
async function runOpenDataLoader(
  filePath: string,
  options?: OpenDataLoaderPdfParseOptions,
): Promise<{ success: true; raw: string } | { success: false; error: string }> {
  const jarPath = await getJarPath();
  log(`[Z-Transplit ODL] runOpenDataLoader: jarPath="${jarPath}"`);
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const jarFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  try {
    jarFile.initWithPath(jarPath);
  } catch (e: any) {
    return {
      success: false,
      error: getString("err-jar-load", { path: jarPath, message: e.message }),
    };
  }
  const exists = jarFile.exists();
  log(`[Z-Transplit ODL] runOpenDataLoader: jarFile.exists() = ${exists}`);
  if (!exists) {
    // 附上下载兜底的失败细节（如有）：错误分类据此把「重新安装插件」换成
    // 「检查网络后重试」——精简版安装里 jar 缺失的真正原因通常是下载失败。
    return {
      success: false,
      error: `JAR file not found at ${jarPath}. Please ensure opendataloader-pdf-cli.jar is present.${
        lastJarProvisionFailure
          ? ` (ODL jar download failed: ${lastJarProvisionFailure})`
          : ""
      }`,
    };
  }

  const config = loadConfig();
  const outputDir = createTempDir();

  try {
    if (options?.signal?.aborted) {
      return { success: false, error: "OpenDataLoader parsing aborted" };
    }

    const format = options?.format ?? "json";
    const args: string[] = [
      "--format",
      format,
      "--output-dir",
      outputDir,
      "--reading-order",
      config.readingOrder,
      "--table-method",
      config.tableMethod,
      // Control raster image embedding. "embedded" puts base64 data URIs in the
      // JSON so the translate pipeline can composite figures back; "off" skips
      // them (the default — the heuristic engine emits no image elements).
      "--image-output",
      // Caller can override the pref-derived default (e.g. the translate
      // pipeline always wants "embedded" so figures are recovered).
      options?.imageOutput ?? config.imageOutput,
    ];

    if (config.useStructTree) {
      args.push("--use-struct-tree");
    }

    if (options?.startPage != null || options?.endPage != null) {
      const start = options?.startPage ?? 1;
      const end = options?.endPage ?? start;
      // L-26: an inverted range used to fall through silently and parse the
      // WHOLE document while the caller believed it got a page slice.
      if (end < start) {
        return {
          success: false,
          error: `Invalid page range: start (${start}) > end (${end})`,
        };
      }
      args.push("--pages", `${start}-${end}`);
    }

    args.push(filePath);

    safeDebug(
      `[Z-Transplit ODL] spawning JVM: java -jar "${jarPath}" ${args.map((a) => JSON.stringify(a)).join(" ")}`,
    );

    const result = await execJava(args, config.timeout * 1000, options?.signal); // M-20

    safeDebug(
      `[Z-Transplit ODL] JVM exited: code=${result.exitCode} timedOut=${result.timedOut} aborted=${result.aborted || false}`,
    );
    if (result.stderr) {
      log(`[Z-Transplit ODL] JVM stderr: ${result.stderr.slice(0, 2000)}`);
    }
    if (result.stdout) {
      log(`[Z-Transplit ODL] JVM stdout: ${result.stdout.slice(0, 2000)}`);
    }

    if (options?.signal?.aborted) {
      return { success: false, error: "OpenDataLoader parsing aborted" };
    }

    if (result.timedOut) {
      return { success: false, error: `Parse timed out (${config.timeout}s)` };
    }

    if (result.exitCode !== 0) {
      // C.3: lead with the real exit code (survives the UI's 200-char
      // truncation) and keep both streams labelled so the reason is never
      // dropped upstream.
      return { success: false, error: formatJavaExitError(result) };
    }

    const inputBaseName =
      filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") || "document";
    const ext = format === "markdown" ? ".md" : ".json";
    // outputDir comes from nsIFile.path (native separators on Windows); string
    // concat with "/" would produce mixed-slash paths that
    // nsIFile.initWithPath rejects. Use PathUtils.join to keep native separators.
    const outputPath = PathUtils.join(outputDir, `${inputBaseName}${ext}`);

    let raw: string;
    try {
      raw = await readFile(outputPath);
    } catch (e) {
      safeDebug("[Z-Transplit] OpenDataLoaderPdfClient: " + e);
      const dirFile = Cc["@mozilla.org/file/local;1"].createInstance(
        Ci.nsIFile,
      );
      dirFile.initWithPath(outputDir);
      const entries = dirFile.directoryEntries;
      let found = "";
      while (entries.hasMoreElements()) {
        const entry = entries.getNext().QueryInterface(Ci.nsIFile);
        if (entry.leafName.endsWith(ext)) {
          found = entry.path;
          break;
        }
      }
      if (!found) {
        // List all files in the output dir for diagnosis.
        const allFiles: string[] = [];
        while (entries.hasMoreElements()) {
          const entry = entries.getNext().QueryInterface(Ci.nsIFile);
          allFiles.push(entry.leafName);
        }
        safeDebug(
          `[Z-Transplit ODL] no ${ext} in ${outputDir}; files: ${allFiles.join(", ") || "(empty)"}`,
        );
        return {
          success: false,
          error: `No ${ext} output found in ${outputDir}`,
        };
      }
      log(`[Z-Transplit ODL] using alternate output: ${found}`);
      raw = await readFile(found);
    }

    if (!raw || !raw.trim()) {
      return { success: false, error: `Conversion produced no ${ext} output` };
    }

    log(`[Z-Transplit ODL] parse succeeded: ${raw.length} chars`);

    return { success: true, raw };
  } finally {
    await removePath(outputDir);
  }
}

/**
 * Parse a PDF to structured JSON via OpenDataLoader.
 */
export async function parsePdfToJson(
  filePath: string,
  options?: OpenDataLoaderPdfParseOptions,
): Promise<OpenDataLoaderJsonParseResult> {
  const runResult = await runOpenDataLoader(filePath, options);

  if (!runResult.success) {
    return {
      success: false,
      data: null,
      source: "opendataloader-pdf",
      error: runResult.error,
    };
  }

  try {
    return {
      success: true,
      data: JSON.parse(runResult.raw),
      source: "opendataloader-pdf",
    };
  } catch (e: any) {
    return {
      success: false,
      data: null,
      source: "opendataloader-pdf",
      error: `Failed to parse JSON output: ${e.message}`,
    };
  }
}

/**
 * Parse a PDF to Markdown via OpenDataLoader.
 */
export async function parsePdfToMarkdown(
  filePath: string,
  options?: OpenDataLoaderPdfParseOptions,
): Promise<OpenDataLoaderPdfParseResult> {
  const runResult = await runOpenDataLoader(filePath, {
    ...options,
    format: "markdown",
  });

  if (!runResult.success) {
    return {
      success: false,
      markdown: "",
      images: {},
      source: "opendataloader-pdf",
      error: runResult.error,
    };
  }

  const images = extractImagesFromMarkdown(runResult.raw);

  return {
    success: true,
    markdown: runResult.raw,
    images,
    source: "opendataloader-pdf",
  };
}