/**
 * ScanSidecarClient — 调用扫描识别侧车（独立进程），收回一批页面的识别
 * 结果。
 *
 * 为什么走侧车而不是把模型搬进插件：识别零件（版面/文字/公式/表格）都在
 * Python 生态（PaddleOCR PP-StructureV3），Zotero 插件是纯 JavaScript 环
 * 境，加载不了这些运行时。侧车以子进程方式运行，与现有 OpenDataLoader
 * jar 的调用模式同构——同样复用 runProcess（Windows Subprocess + Unix sh、
 * 超时与 AbortSignal 协同取消），同样受信号量限流。
 *
 * 协议见 sidecarProtocol：--pdf/--pages/--out/--dpi 四个参数，侧车在
 * --out 目录写 result.json。本模块只负责"调用 + 读回 + 状态归类"，不
 * 解释识别内容（那是 ocrToAnalysis 的事）。
 *
 * Host-coupled：进程启动与临时目录依赖 Gecko/Zotero 全局。配置装载是
 * 独立的纯函数，测试可整体注入 argv 与参数而不碰宿主。
 *
 * @module core/pdf/scan/ScanSidecarClient
 */

import { safeDebug } from "../../../utils/logger";
import { getPrefDynamic } from "../../../utils/prefs";
import { Semaphore } from "../../../utils/Semaphore";
import { readFile, removePath, runProcess } from "../OpenDataLoaderPdfClient";
import {
  indexPages,
  parseCommandLine,
  parseSidecarBatchOutput,
  SIDECAR_EXIT_OK,
  SIDECAR_EXIT_PARTIAL,
  type SidecarBatchRun,
  type SidecarDiagnostics,
  type SidecarPageResult,
  type SidecarRunStatus,
} from "./sidecarProtocol";
import { createWorkDir, joinWorkPath } from "./workDir";

/** 侧车并发上限：与 JVM 一样每进程吃几百兆内存，2 是安全值。 */
const SIDECAR_SEMAPHORE = new Semaphore(2);

/** result.json 在 --out 目录下的固定文件名。 */
const RESULT_FILE_NAME = "result.json";

/** 侧车自己的输出目录前缀（与管线的账目目录区分，见 workDir）。 */
const SIDECAR_WORK_DIR_PREFIX = "ztransplit-scan-sidecar-";

export interface ScanSidecarConfig {
  /** 侧车命令行拆出的 argv；空数组表示未配置。 */
  argv: string[];
  dpi: number;
  timeoutMs: number;
  /** 每批页数（管线分批用；侧车协议本身不认识批次）。 */
  batchSize: number;
}

/** 从偏好读取侧车配置。命令行为空或引号不闭合都按"未配置"处理。 */
export function loadScanSidecarConfig(): ScanSidecarConfig {
  const raw = String(getPrefDynamic("pdfParser.scan.sidecarPath") || "").trim();
  const argv = raw ? parseCommandLine(raw) : null;
  const dpi = Number(getPrefDynamic("pdfParser.scan.dpi"));
  const timeout = Number(getPrefDynamic("pdfParser.scan.timeout"));
  const batch = Number(getPrefDynamic("pdfParser.scan.batchSize"));
  return {
    argv: argv ?? [],
    dpi: Number.isFinite(dpi) && dpi >= 72 && dpi <= 600 ? Math.trunc(dpi) : 200,
    timeoutMs:
      Number.isFinite(timeout) && timeout >= 30 && timeout <= 3600
        ? Math.trunc(timeout) * 1000
        : 600_000,
    batchSize:
      Number.isFinite(batch) && batch >= 1 && batch <= 200 ? Math.trunc(batch) : 10,
  };
}

export interface RunSidecarBatchParams {
  pdfPath: string;
  /** 1 基页码，按升序；空数组直接返回未配置态。 */
  pages: number[];
  dpi?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 测试注入；缺省读偏好。 */
  argv?: string[];
}

/** 识别工作目录：ztransplit-scan-sidecar-<时间戳>（见 workDir 的分族约定）。 */
function createScanWorkDir(): string {
  return createWorkDir(SIDECAR_WORK_DIR_PREFIX);
}

/**
 * 跑一批页面。任何单一失败模式都不抛异常——超时、进程崩溃、JSON 畸形
 * 都归类进 status，由上层账目决定重试或记账；唯一的例外是调用方取消
 * （signal 已中止），此时返回 aborted 态，上层按取消处理。
 */
export async function runSidecarBatch(
  params: RunSidecarBatchParams,
): Promise<SidecarBatchRun> {
  // 测试整体注入 argv 时完全不碰偏好系统（无 Zotero 全局也能跑）。
  const injected = params.argv !== undefined;
  const config: ScanSidecarConfig = injected
    ? {
        argv: params.argv as string[],
        dpi: params.dpi ?? 200,
        timeoutMs: params.timeoutMs ?? 600_000,
        batchSize: 10,
      }
    : loadScanSidecarConfig();
  const dpi = params.dpi ?? config.dpi;
  const timeoutMs = params.timeoutMs ?? config.timeoutMs;

  if (config.argv.length === 0) {
    return { status: "unconfigured", pages: new Map(), stderr: "" };
  }
  // 没有要识别的页：不启动进程，直接回报空结果（上层按空批处理）。
  if (params.pages.length === 0) {
    return { status: "ok", pages: new Map(), stderr: "" };
  }

  // 先建工作目录再取信号量：建目录失败不能拖着已占用的槽位（泄漏会让
  // 后续批次永久排队）。
  const outDir = createScanWorkDir();
  const release = await SIDECAR_SEMAPHORE.acquire();
  let status: SidecarRunStatus = "failed";
  try {
    const args = [
      ...config.argv.slice(1),
      "--pdf",
      params.pdfPath,
      "--pages",
      // 升序：管线按页序散回结果，侧车按页码回报，顺序确定性让批 manifest
      // 可重放、可对账。
      [...params.pages].sort((a, b) => a - b).join(","),
      "--out",
      outDir,
      "--dpi",
      String(dpi),
    ];
    const result = await runProcess(
      config.argv[0],
      args,
      timeoutMs,
      params.signal,
    );

    if (result.aborted) {
      status = "aborted";
      return { status, pages: new Map(), stderr: result.stderr };
    }
    if (result.timedOut) {
      status = "timeout";
      return { status, pages: new Map(), stderr: result.stderr, workDir: outDir };
    }

    // 读 result.json。读不到或解析失败都按 failed，但保留目录供排障。
    let raw: string;
    try {
      raw = await readFile(joinWorkPath(outDir, RESULT_FILE_NAME));
    } catch (e) {
      safeDebug("[Z-Transplit] ScanSidecarClient: result.json unreadable: " + e);
      status = "failed";
      return {
        status,
        pages: new Map(),
        stderr: `result.json unreadable: ${result.stderr}`.trim(),
        workDir: outDir,
      };
    }
    let parsed: ReturnType<typeof parseSidecarBatchOutput> = null;
    try {
      parsed = parseSidecarBatchOutput(JSON.parse(raw));
    } catch (e) {
      safeDebug("[Z-Transplit] ScanSidecarClient: result.json malformed: " + e);
      status = "failed";
      return {
        status,
        pages: new Map(),
        stderr: `result.json malformed: ${result.stderr}`.trim(),
        workDir: outDir,
      };
    }
    if (!parsed) {
      status = "failed";
      return { status, pages: new Map(), stderr: result.stderr, workDir: outDir };
    }

    status =
      result.exitCode === SIDECAR_EXIT_OK
        ? "ok"
        : result.exitCode === SIDECAR_EXIT_PARTIAL
          ? "partial"
          : "failed";
    return {
      status,
      pages: indexPages(parsed.pages),
      diagnostics: parsed.diagnostics,
      stderr: result.stderr,
      ...(status === "failed" ? { workDir: outDir } : {}),
    };
  } finally {
    release();
    // 成功、部分成功与取消的批都清掉临时目录：前两者的成果已在内存里，
    // 取消意味着用户不要中间产物。失败与超时的批保留（result.workDir
    // 指向它），临时目录由操作系统回收。
    if (status === "ok" || status === "partial" || status === "aborted") {
      await cleanupScanWorkDir(outDir);
    }
  }
}

/** 清理侧车临时目录（成功/部分成功/取消的批在 finally 里调用；失败与
 *  超时的批保留供排障，由操作系统回收临时目录）。 */
export async function cleanupScanWorkDir(outDir: string): Promise<void> {
  try {
    await removePath(outDir);
  } catch (e) {
    safeDebug("[Z-Transplit] ScanSidecarClient: cleanup failed: " + e);
  }
}

/** 测试与调试用：侧车信号量当前占用数。 */
export function sidecarConcurrencyInUse(): number {
  return (SIDECAR_SEMAPHORE as any).running as number;
}

export type { SidecarDiagnostics, SidecarPageResult };
