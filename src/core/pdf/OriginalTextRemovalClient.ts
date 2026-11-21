/**
 * OriginalTextRemovalClient — 调用 ztransplit-region-text-remover.jar，
 * 在叠加译文之前把已翻译段落的原文从 PDF 页面内容流中真正删除
 * （替代白色遮罩；搜索与复制不再命中被遮住的原文）。
 *
 * 只处理页面内容流（第 0 层）文字；表单与透明组内部的文字由删除器
 * 自行保留，交由现有遮罩路径兜底（详见 java/region-text-remover/）。
 *
 * 另提供检查模式（inspectFormTextRegions）：翻译开始前报告含文字表单
 * 对象（矢量图区域）的边界框，管线据此实现图片区域完全不翻译。
 *
 * 失败语义：任何一步失败（jar 缺失、Java 缺失、超时、输出缺失或格式
 * 无效）都向上抛出，由调用方（opendataloaderSplitAdapter）整体回退到
 * 原有遮罩路径。Host 耦合（nsIProcess / IOUtils）— 不可在 Node 单测。
 */

import {
  createTempDir,
  execJar,
  getJarPath,
  readFile,
  removePath,
} from "./OpenDataLoaderPdfClient";
import { getPref } from "../../utils/prefs";
import { safeDebug } from "../../utils/logger";

const REMOVER_JAR_NAME = "ztransplit-region-text-remover.jar";
const OUTPUT_FILE_NAME = "cleaned.pdf";
const RECTS_FILE_NAME = "rects.txt";
const FORMS_FILE_NAME = "forms.txt";

/** 偏好开关（默认开启；任何失败由管线自动回退到遮罩路径）。 */
export function isOriginalTextRemovalEnabled(): boolean {
  return getPref("pdfParser.originalTextRemoval.enabled") !== false;
}

/**
 * 删除器回传的处理统计。
 *
 * 数字全部来自 jar 打在 stderr 上的那行
 * `[ztransplit-remover] done pagesTouched=… opsRemoved=… opsKept=… opsRewritten=… streamsSkippedInlineImage=…`。
 * 此前这一行被丢弃（只有失败路径才把 stderr 拼进错误消息），于是调用方无法
 * 区分"删掉了"与"什么都没删"——而这两种情形退出码都是 0、产出的都是合法 PDF。
 */
export interface RemovalStats {
  /** 被改写过的页面数。 */
  pagesTouched: number;
  /** 删掉的文字绘制算子数。 */
  opsRemoved: number;
  /** 保留的文字绘制算子数。 */
  opsKept: number;
  /** 重写（而非整条删除）的算子数。 */
  opsRewritten: number;
  /**
   * 因含内联图像而整条跳过的内容流数。这些流里的文字一条都没删——按设计
   * 内联图像与文字的交错关系改不动，但调用方必须知道有多少文字因此留下。
   */
  streamsSkippedInlineImage: number;
}

/** 删除器的产出：PDF 字节加处理统计。 */
export interface RemovalResult {
  bytes: Uint8Array;
  stats: RemovalStats;
}

/**
 * 解析删除器打在 stderr 上的统计行。
 *
 * 解析不出来时返回全 0 而不是抛错：统计只是让调用方判断"该不该信任这次删除"
 * 的旁证，为它把一次本来成功的删除判成失败是反的。全 0 会被
 * `isRemovalEffective` 判成"没删掉东西"，走遮罩兜底——那是安全的方向。
 *
 * 导出是为了单测：这段解析是纯字符串处理，而被它守护的决策（信任删除结果还是
 * 回落遮罩）值得单独钉住。
 */
export function parseRemovalStats(stderr: string): RemovalStats {
  const line = (stderr || "")
    .split("\n")
    .find((l) => l.includes("[ztransplit-remover] done"));
  const empty: RemovalStats = {
    pagesTouched: 0,
    opsRemoved: 0,
    opsKept: 0,
    opsRewritten: 0,
    streamsSkippedInlineImage: 0,
  };
  if (!line) return empty;
  const num = (key: string): number => {
    const m = new RegExp(`${key}=(-?\\d+)`).exec(line);
    return m ? Number(m[1]) : 0;
  };
  return {
    pagesTouched: num("pagesTouched"),
    opsRemoved: num("opsRemoved"),
    opsKept: num("opsKept"),
    opsRewritten: num("opsRewritten"),
    streamsSkippedInlineImage: num("streamsSkippedInlineImage"),
  };
}

/**
 * 这次删除是否真的删掉了东西。
 *
 * 判据只有一个：opsRemoved > 0。删除器按边界框逐字形判定并删除绘制算子，
 * 一个算子都没删意味着它一个字都没碰。
 *
 * 为什么需要这个判断：删除器在"什么都没删"时**照样退出码 0、照样产出合法
 * PDF**。实测两种情形——
 *
 *   文字全在表单（Form XObject）里：页面内容流只有一个 Do，删除器按设计
 *     只处理第 0 层，报 pagesTouched=0 opsRemoved=0，而删完的 PDF 文本层
 *     与原文逐字节相同；
 *   区域文件为空（没有段落被翻译）：同样 exit 0、opsRemoved=0。
 *
 * 此前的管线拿到退出码 0 就信，随即把 maskOriginalText 关掉。于是上述第一种
 * 情形下读者看到的是：原文完整保留、译文叠在原文字上、**没有任何遮罩盖住
 * 原文**。删除器的设计边界（表单与透明组内的文字一律保留）是写进 Java 注释
 * 的，但管线无从知道它被触发了。
 */
export function isRemovalEffective(stats: RemovalStats): boolean {
  return stats.opsRemoved > 0;
}

/**
 * 对磁盘上的源 PDF 执行原文删除。
 *
 * @param sourcePath 源 PDF 的磁盘路径（只读，不修改原文件）
 * @param rectsContent 删除器区域文件内容（removalRects.serializeRemovalRects 的输出）
 * @param signal 用户取消信号
 * @returns 删除后的 PDF 字节与处理统计
 * @throws Error 任何失败——调用方必须回退到遮罩路径
 */
export async function removeOriginalText(
  sourcePath: string,
  rectsContent: string,
  signal?: AbortSignal,
): Promise<RemovalResult> {
  const jarPath = await getJarPath(REMOVER_JAR_NAME);
  // 超时口径与 ODL 解析一致（秒 → 毫秒）；删除比解析快得多，但保守取同值
  const timeoutSec = Number(getPref("pdfParser.opendataloader.timeout")) || 300;
  const timeoutMs = timeoutSec * 1000;

  const tmpDir = createTempDir();
  try {
    const rectsPath = joinPath(tmpDir, RECTS_FILE_NAME);
    const outPath = joinPath(tmpDir, OUTPUT_FILE_NAME);
    writeTextFile(rectsPath, rectsContent);

    const result = await execJar(
      jarPath,
      [sourcePath, rectsPath, outPath],
      timeoutMs,
      signal,
    );
    if (result.timedOut) {
      throw new Error(`original-text removal timed out after ${timeoutSec}s`);
    }
    if (result.aborted) {
      throw new Error("original-text removal aborted");
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `original-text removal failed (exit ${result.exitCode}): ${
          (result.stderr || result.stdout || "").slice(0, 400)
        }`,
      );
    }

    const exists = await (globalThis as any).IOUtils?.exists?.(outPath);
    if (!exists) {
      throw new Error("original-text removal produced no output file");
    }
    const bytes = (await (globalThis as any).IOUtils.read(outPath)) as Uint8Array;
    if (!isPdfBytes(bytes)) {
      throw new Error("original-text removal produced an invalid PDF");
    }
    // 统计从 stderr 解析。解析不出来会是全 0，被 isRemovalEffective 判成
    // "没删掉东西"——调用方据此回落遮罩，是安全的方向。
    const stats = parseRemovalStats(result.stderr);
    safeDebug(
      `[Z-Transplit] OriginalTextRemovalClient: cleaned PDF ${bytes.length} bytes, ` +
        `pagesTouched=${stats.pagesTouched} opsRemoved=${stats.opsRemoved} ` +
        `opsKept=${stats.opsKept} streamsSkippedInlineImage=${stats.streamsSkippedInlineImage}`,
    );
    return { bytes, stats };
  } finally {
    await removePath(tmpDir);
  }
}

/**
 * 检查模式：报告源 PDF 中含文字表单对象（矢量图区域）的边界框列表。
 *
 * 翻译管线在翻译开始前调用，把落在边界框内的段落整体排除（figureTextFilter），
 * 实现图片区域完全不翻译。失败语义与删除一致：向上抛出，由调用方决定
 * 跳过过滤（管线其余部分不受影响）。
 *
 * @returns 删除器 --inspect 的原始输出文本（每行 page x0 y0 x1 y1）
 * @throws Error 任何失败
 */
export async function inspectFormTextRegions(
  sourcePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const jarPath = await getJarPath(REMOVER_JAR_NAME);
  const timeoutSec = Number(getPref("pdfParser.opendataloader.timeout")) || 300;
  const timeoutMs = timeoutSec * 1000;

  const tmpDir = createTempDir();
  try {
    const outPath = joinPath(tmpDir, FORMS_FILE_NAME);
    const result = await execJar(
      jarPath,
      ["--inspect", sourcePath, outPath],
      timeoutMs,
      signal,
    );
    if (result.timedOut) {
      throw new Error(`figure-region inspection timed out after ${timeoutSec}s`);
    }
    if (result.aborted) {
      throw new Error("figure-region inspection aborted");
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `figure-region inspection failed (exit ${result.exitCode}): ${
          (result.stderr || result.stdout || "").slice(0, 400)
        }`,
      );
    }
    const exists = await (globalThis as any).IOUtils?.exists?.(outPath);
    if (!exists) {
      throw new Error("figure-region inspection produced no output file");
    }
    const text = await readFile(outPath);
    safeDebug(
      `[Z-Transplit] OriginalTextRemovalClient: inspect regions=${
        text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).length
      }`,
    );
    return text || "";
  } finally {
    await removePath(tmpDir);
  }
}

function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46; // F
}

function joinPath(dir: string, name: string): string {
  const join = (globalThis as any).PathUtils?.join;
  if (join) return join(dir, name);
  const sep = (Zotero as any).isWin ? "\\" : "/";
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`;
}

function writeTextFile(path: string, content: string): void {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
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
}
