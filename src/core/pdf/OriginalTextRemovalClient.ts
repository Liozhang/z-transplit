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
 * 对磁盘上的源 PDF 执行原文删除。
 *
 * @param sourcePath 源 PDF 的磁盘路径（只读，不修改原文件）
 * @param rectsContent 删除器区域文件内容（removalRects.serializeRemovalRects 的输出）
 * @param signal 用户取消信号
 * @returns 删除后的 PDF 字节（保证以 %PDF 开头）
 * @throws Error 任何失败——调用方必须回退到遮罩路径
 */
export async function removeOriginalText(
  sourcePath: string,
  rectsContent: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
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
    safeDebug(
      `[Z-Transplit] OriginalTextRemovalClient: cleaned PDF ${bytes.length} bytes`,
    );
    return bytes;
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
