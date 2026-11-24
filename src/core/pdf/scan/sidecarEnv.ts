/**
 * sidecarEnv — 扫描识别环境的一键安装：解释器、依赖、命令回填、自检。
 *
 * 为什么有这一层：识别跑在插件外的 Python 侧车里，用户此前的路径是「自己装
 * Python → 自己 pip install → 自己抄一条命令进设置」，三步任何一步卡住，扫描
 * 识别就用不上。本模块把三步合成一次点击，并且每一步失败都给出可行动的原因。
 *
 * 一次安装按依赖顺序做五步：
 *   1. 把随包的 sidecar.py 与 requirements.txt 落到数据目录——打包安装时脚本
 *      在 XPI 里，不能直接当命令执行；这一步每次都做（几 KB、不联网），插件
 *      升级带来新版侧车时不能沿用盘上的旧脚本；
 *   2. 解释器：机器上已有合格的 Python（版本 ≥ 3.9、带 pip、64 位）或已装好的
 *      受管运行时就直接用，一个字节都不下载；两者都没有才装受管运行时；
 *   3. pip install 依赖：并发探测 PyPI 索引取最快的一个，用 pip 的
 *      --index-url 传入（进程运行器不传环境变量，也不需要）；
 *   4. 跑一次 `sidecar.py --selftest`：构建识别引擎，这一步会把模型权重下载
 *      到位——在安装阶段做，而不是等用户翻译到一半才卡住；
 *   5. 把「"<python>" "<sidecar.py>"」写进 pdfParser.scan.sidecarPath，用户不
 *      需要手动填任何命令。
 * 依赖与脚本都已就绪、只差命令时，第 2–4 步整段跳过，直接补写命令。
 *
 * 用系统 Python 意味着依赖装进用户自己的那个环境（pip 的常规行为），这一点
 * 在 UI 文案里说明，不悄悄改用户的全局环境。
 *
 * 失败语义：任一步失败都抛带本地化文案的错误，且不写安装标记、不回填命令——
 * 半成品环境不会被当成装好了。取消与超时单独归类（取消按名字识别，文案与
 * 翻译管线的取消一致），不混进"安装失败"。
 *
 * 体积与耗时要如实告知：首次安装下载几百兆（paddlepaddle 一个包就有 100–
 * 186 MB，模型权重另算），可能持续几分钟到十几分钟。这不是可以悄悄优化的
 * 部分——UI 文案必须说清楚。
 *
 * 已知边界：状态查询核对的是"安装标记 + 脚本在盘上 + 解释器探活通过 + 命令
 * 偏好对得上"，不重新 import 依赖包。用户在装好之后又卸载了 paddleocr 的
 * 情况，面板仍显示就绪——自检（--selftest）才是依赖是否真的可用的判据，
 * 修复入口会重跑它。
 *
 * Host-coupled (Zotero.HTTP / IOUtils / runProcess / 偏好写入) — 宿主边界在
 * tests/unit/core/pdf/scan/sidecarEnv.test.ts 中伪造。
 *
 * @module core/pdf/scan/sidecarEnv
 */

import { getString } from "../../../utils/locale";
import { safeDebug } from "../../../utils/logger";
import { setPref, getPref } from "../../../utils/prefs";
import { ZTransplitCancelledError } from "../CancelledError";
import { readBundledFile, runProcess } from "../OpenDataLoaderPdfClient";
import { pypiIndexUrls } from "../OdlJarDownloader";
import {
  installPythonRuntime,
  resolvePython,
  type PythonInstallProgress,
  type PythonSource,
} from "./pythonRuntime";
import { SCAN_MODEL_TIERS } from "./ScanSidecarClient";

/** 侧车命令偏好键（addon/prefs.js 声明）。 */
const SIDECAR_PATH_PREF = "pdfParser.scan.sidecarPath";
/** 模型档位偏好键（addon/prefs.js 声明）。 */
const SIDECAR_MODELS_PREF = "pdfParser.scan.models";

/**
 * 当前模型档位。安装阶段的自检按它预热模型，运行阶段由 ScanSidecarClient
 * 拼进侧车 argv——两处读同一个偏好，档位才不会割裂。
 */
function scanModelTier(): string {
  const raw = String(getPref(SIDECAR_MODELS_PREF) || "").trim();
  return (SCAN_MODEL_TIERS as readonly string[]).includes(raw) ? raw : "accurate";
}

/** 数据目录下的侧车安装目录（脚本与安装标记都在这）。 */
const SCAN_SIDECAR_DIR = "scan-sidecar";

/** 安装标记：记录用的解释器、脚本路径与索引源，状态查询据此判断依赖是否装好。 */
const ENV_MARKER_FILE = "env.json";

/** pip install 超时：几百兆下载加依赖求解，弱网下可能很久。 */
const PIP_TIMEOUT_MS = 1800000;
/** 自检超时：模型权重在第一次构建引擎时下载。 */
const SELFTEST_TIMEOUT_MS = 1800000;
/** 镜像探测超时（与 jar 取件的区间探测同量级）。 */
const PROBE_TIMEOUT_MS = 8000;

export type SidecarEnvPhase =
  | "runtime"
  | "script"
  | "dependencies"
  | "selftest"
  | "done"
  | "failed";

export interface SidecarEnvProgress {
  percent: number;
  phase: SidecarEnvPhase;
}

export type SidecarEnvCallback = (p: SidecarEnvProgress) => void;

export interface SidecarEnvStatus {
  /** 四步全部就绪（解释器 + 脚本 + 依赖 + 命令已回填）。 */
  ready: boolean;
  /** 受管解释器已安装且探活通过。 */
  interpreter: boolean;
  /** 识别引擎版本（paddleocr），不是解释器版本——名字按内容起。 */
  engineVersion?: string;
  /**
   * 推理模式（自检时探测）："default" 走 mkldnn 加速；"no-mkldnn" 是兼容
   * 模式——本机 CPU 的 oneDNN 融合指令有缺陷，关掉加速后识别才跑得动
   * （见 sidecar.py 的 INFERENCE_*）。侧车按它建引擎，设置面板据此说明
   * 为什么识别可能略慢。
   */
  inferenceMode?: string;
  /** 依赖已装好（安装标记存在且解释器对得上）。 */
  dependencies: boolean;
  /** 侧车命令偏好已回填且指向当前脚本。 */
  commandConfigured: boolean;
  /** 侧车脚本在数据目录里的路径（已落地时给出）。 */
  sidecarPath?: string;
  pythonPath?: string;
  /** 解释器从哪来：插件分发的受管运行时，或机器上已有的 Python。 */
  pythonSource?: PythonSource;
  /** 不就绪时的原因（已本地化）。 */
  error?: string;
}

interface SidecarEnvMarker {
  pythonPath: string;
  sidecarPath: string;
  /** 这个解释器是受管运行时还是机器上已有的 Python。 */
  pythonSource: PythonSource;
  /** 识别引擎版本（paddleocr），不是解释器版本——名字按内容起。 */
  engineVersion?: string;
  /**
   * 自检探到的推理模式。侧车进程启动时读它决定计算路径，不必每批都先
   * 失败一次再切换；缺失按默认模式（运行时兜底会补上）。
   */
  inference?: string;
  pipIndex: string;
  installedAt: number;
}

function pathJoin(...parts: string[]): string {
  const { join } = (globalThis as any).PathUtils || {};
  if (join) return join(...parts);
  return parts.join("/");
}

/** 数据目录下的侧车安装目录。 */
export function getSidecarDir(): string {
  const dataDir = (Zotero as any).DataDirectory?.dir || "";
  return pathJoin(dataDir, "ztransplit", SCAN_SIDECAR_DIR);
}

export function getSidecarScriptPath(): string {
  return pathJoin(getSidecarDir(), "sidecar.py");
}

function getMarkerPath(): string {
  return pathJoin(getSidecarDir(), ENV_MARKER_FILE);
}

async function readMarker(): Promise<SidecarEnvMarker | null> {
  try {
    const IOUtils = (globalThis as any).IOUtils;
    if (!IOUtils?.exists || !(await IOUtils.exists(getMarkerPath()))) return null;
    const raw = new TextDecoder().decode(await IOUtils.read(getMarkerPath()));
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.pythonPath === "string" &&
      typeof parsed?.sidecarPath === "string" &&
      typeof parsed?.pipIndex === "string"
    ) {
      return parsed as SidecarEnvMarker;
    }
  } catch (e) {
    safeDebug("[Z-Transplit] sidecarEnv: marker unreadable: " + e);
  }
  return null;
}

async function writeMarker(marker: SidecarEnvMarker): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  await IOUtils.makeDirectory(getSidecarDir(), { createAncestors: true });
  await IOUtils.write(
    getMarkerPath(),
    new TextEncoder().encode(JSON.stringify(marker, null, 2)),
  );
}

/**
 * 从随包 XPI 里读一个文本文件并落到数据目录。
 *
 * 随包读不到时分两种情况：盘上还没有这个文件 → 报缺件（装不了）；盘上已有
 * → 保留原文件。后者让"安装包缺件但环境已装好"的用户仍能补写命令，而不是
 * 被一次本可避免的刷新卡住。
 */
async function materializeBundledFile(bundledPath: string, targetPath: string): Promise<void> {
  const text = await readBundledFile(bundledPath);
  const IOUtils = (globalThis as any).IOUtils;
  if (!text) {
    const landed = IOUtils?.exists ? await IOUtils.exists(targetPath) : false;
    if (landed) {
      safeDebug(`[Z-Transplit] sidecarEnv: bundled ${bundledPath} absent, keeping ${targetPath}`);
      return;
    }
    throw new Error(getString("sidecar-error-bundle-missing", { file: bundledPath }));
  }
  await IOUtils.makeDirectory(getSidecarDir(), { createAncestors: true });
  await IOUtils.write(targetPath, new TextEncoder().encode(text));
}

/**
 * 并发探测 PyPI 简单索引，取最快的一个当 pip 的 --index-url。字节对不上
 * 指纹就换源的那套探测逻辑在 artifactAcquire 里，这里只需要"谁最快"——
 * pip 会自己做重试与校验。
 *
 * 索引地址表与 jar 取件共用（OdlJarDownloader.pypiIndexUrls）：官方源的
 * 文件主机与索引主机不是同一个域名，用文件主机当索引会永远探测失败。
 */
export async function fastestPypiIndex(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throwIfCancelled();
  const indexes = pypiIndexUrls();
  const probed = await Promise.all(
    indexes.map(async (index) => {
      const start = Date.now();
      try {
        const resp = await (Zotero as any).HTTP.request("GET", `${index}/pip/`, {
          responseType: "text",
          timeout: PROBE_TIMEOUT_MS,
        } as any);
        if (resp?.status === 200) return { index, ms: Date.now() - start };
      } catch (e) {
        safeDebug(`[Z-Transplit] sidecarEnv: index probe failed (${index}): ${e}`);
      }
      return { index, ms: Number.POSITIVE_INFINITY };
    }),
  );
  if (signal?.aborted) throwIfCancelled();
  const reachable = probed
    .filter((p) => Number.isFinite(p.ms))
    .sort((a, b) => a.ms - b.ms);
  if (reachable.length === 0) {
    throw new Error(getString("sidecar-error-no-mirror"));
  }
  return reachable[0].index;
}

/** 侧车命令行：解释器与脚本都加引号（路径带空格是常态）。 */
export function buildSidecarCommand(pythonPath: string, sidecarPath: string): string {
  return `"${pythonPath}" "${sidecarPath}"`;
}

/**
 * 状态查询（面板只读行）。不触发下载；解释器要跑一次 `python -V` 探活
 * （装在盘上不等于能跑），因此不是纯磁盘检查。
 */
export async function getSidecarEnvStatus(): Promise<SidecarEnvStatus> {
  const marker = await readMarker();
  const sidecarPath = getSidecarScriptPath();
  const scriptLanded = await (async () => {
    try {
      const IOUtils = (globalThis as any).IOUtils;
      return IOUtils?.exists ? await IOUtils.exists(sidecarPath) : false;
    } catch {
      return false;
    }
  })();
  // 一次解析，两处使用：解释器是否可用、以及标记里的解释器路径是否仍然对。
  // 受管运行时或机器上已有的 Python 都算就绪。
  const resolved = await resolvePython();
  const interpreter = Boolean(resolved);
  const pythonPath = marker?.pythonPath ?? resolved?.path;
  const pythonSource = resolved?.source ?? marker?.pythonSource;
  const dependencies = Boolean(marker) && scriptLanded && marker?.pythonPath === pythonPath;
  // 命令偏好必须走 getPref：Zotero.Prefs.get 的第二个参数是分支，漏掉它读的是
  // 另一个分支，拿回来恒为 undefined。真机实测（2026-11-19）：安装五步全部
  // 成功、偏好也确实写进去了，可状态查询因为漏了这个参数一直报"命令未回填"，
  // ready 永远是 false——设置面板上装好了也显示没装好。
  const configured = await (async () => {
    const current = getPref(SIDECAR_PATH_PREF);
    return (
      typeof current === "string" &&
      current.includes(sidecarPath) &&
      Boolean(marker)
    );
  })();

  if (!interpreter) {
    return {
      ready: false,
      interpreter: false,
      dependencies: false,
      commandConfigured: false,
      error: getString("py-status-not-installed"),
    };
  }
  if (!dependencies) {
    return {
      ready: false,
      interpreter: true,
      dependencies: false,
      commandConfigured: false,
      ...(pythonPath ? { pythonPath } : {}),
      ...(pythonSource ? { pythonSource } : {}),
      error: getString("sidecar-status-deps-missing"),
    };
  }
  if (!configured) {
    return {
      ready: false,
      interpreter: true,
      dependencies: true,
      commandConfigured: false,
      sidecarPath,
      ...(pythonPath ? { pythonPath } : {}),
      ...(pythonSource ? { pythonSource } : {}),
      error: getString("sidecar-status-command-missing"),
    };
  }
  return {
    ready: true,
    interpreter: true,
    engineVersion: marker?.engineVersion,
    inferenceMode: marker?.inference,
    dependencies: true,
    commandConfigured: true,
    sidecarPath,
    ...(pythonPath ? { pythonPath } : {}),
    ...(pythonSource ? { pythonSource } : {}),
  };
}

/**
 * 一键安装。任一步失败都抛错（带本地化文案），调用方呈现；已就绪时零网络
 * 直接返回（但会刷新随包脚本，见下）。
 */
export async function installSidecarEnv(opts: {
  onProgress?: SidecarEnvCallback;
  signal?: AbortSignal;
}): Promise<{ pythonPath: string; sidecarPath: string }> {
  const emit = (percent: number, phase: SidecarEnvPhase) =>
    opts.onProgress?.({ percent, phase });
  const sidecarPath = getSidecarScriptPath();

  // 0) 脚本先落地：随包脚本只有几 KB、不联网。插件升级带来新版侧车时，已就绪
  //    的短路不能沿用盘上的旧脚本——否则用户一直在跑旧识别链而不自知。
  emit(0, "script");
  await materializeBundledFile("scan-sidecar/sidecar.py", sidecarPath);
  await materializeBundledFile(
    "scan-sidecar/requirements.txt",
    pathJoin(getSidecarDir(), "requirements.txt"),
  );

  // 1) 已就绪：不重复下载几百兆。
  const status = await getSidecarEnvStatus();
  if (status.ready && status.pythonPath) {
    emit(100, "done");
    return { pythonPath: status.pythonPath, sidecarPath };
  }

  // 2) 只差命令回填：依赖与脚本都在，写一行偏好就完事，不重跑 pip 与自检
  //    （那可能是几分钟到十几分钟）。
  if (status.interpreter && status.dependencies && status.pythonPath) {
    await fillCommand(status.pythonPath, sidecarPath);
    emit(100, "done");
    return { pythonPath: status.pythonPath, sidecarPath };
  }

  // 3) 解释器。机器上已有合格的 Python（或已装好的受管运行时）就直接用——
  //    为此再下载 20–70 MB 是浪费；只有两者都没有时才装受管运行时。
  let pythonPath: string;
  let pythonSource: PythonSource;
  const existing = await resolvePython();
  if (existing) {
    pythonPath = existing.path;
    pythonSource = existing.source;
  } else {
    emit(5, "runtime");
    pythonPath = await installPythonRuntime({
      onProgress: (p: PythonInstallProgress) => {
        // 解释器阶段占前 40%：依赖与自检才是耗时大头，但解释器是它们的前提。
        // 百分比只增不减——下载到一半又跳回 0 会让用户以为重新开始。
        switch (p.phase) {
          case "checksum":
            emit(2, "runtime");
            break;
          case "probing":
            emit(5, "runtime");
            break;
          case "downloading":
            emit(5 + Math.round(p.percent * 0.35), "runtime");
            break;
          case "verifying":
          case "extracting":
            emit(40, "runtime");
            break;
          default:
            emit(40, "runtime");
        }
      },
      signal: opts.signal,
    });
    pythonSource = "managed";
  }

  // 4) 依赖。
  emit(45, "dependencies");
  const index = await fastestPypiIndex(opts.signal);
  const pip = await runProcess(
    pythonPath,
    [
      "-m",
      "pip",
      "install",
      "--no-input",
      "--disable-pip-version-check",
      "--progress-bar",
      "off",
      "--index-url",
      index,
      "-r",
      pathJoin(getSidecarDir(), "requirements.txt"),
    ],
    PIP_TIMEOUT_MS,
    opts.signal,
    // pip 也是 Python 进程：Windows 上不注入 JVM 的 -D 参数。
    { jvmEncodingArgs: false },
  );
  if (pip.aborted) throwIfCancelled();
  if (pip.timedOut) {
    throw new Error(
      getString("sidecar-error-timeout", { minutes: minutesOf(PIP_TIMEOUT_MS) }),
    );
  }
  if (pip.exitCode !== 0) {
    // pip 的错误在 stderr 末尾（通常是版本冲突或镜像缺件），带出去用户才
    // 知道该改什么。
    const detail = tailOf(pip.stderr || pip.stdout, 400);
    throw new Error(getString("sidecar-error-pip", { detail }));
  }

  // 5) 自检：构建引擎并预热模型。失败说明环境装好了但跑不起来（架构不符、
  //    模型下载被拦），必须在这一步暴露，而不是等翻译到一半。
  //    按当前模型档位预热：轻量档只该下 53 MB 的模型，让完整档的 1.3 GB
  //    白下一遍再让用户切档，是最没必要的一笔下载。
  emit(70, "selftest");
  const probe = await runProcess(
    pythonPath,
    [sidecarPath, "--selftest", "--models", scanModelTier()],
    SELFTEST_TIMEOUT_MS,
    opts.signal,
    { jvmEncodingArgs: false },
  );
  if (probe.aborted) throwIfCancelled();
  if (probe.timedOut) {
    throw new Error(
      getString("sidecar-error-timeout", { minutes: minutesOf(SELFTEST_TIMEOUT_MS) }),
    );
  }
  if (probe.exitCode !== 0) {
    const detail = tailOf(probe.stderr || probe.stdout, 400);
    throw new Error(getString("sidecar-error-selftest", { detail }));
  }

  // 6) 命令回填：用户不需要手抄任何命令行。自检报出的推理模式一并写进
  //    标记：侧车进程启动时读它决定计算路径（默认模式在这台机器上跑不通
  //    时，自检已经换成兼容模式探通过，见 sidecar.py 的 selftest）。
  const selftest = parseSelftestOutput(probe.stdout);
  await writeMarker({
    pythonPath,
    sidecarPath,
    pythonSource,
    engineVersion: selftest.engineVersion,
    inference: selftest.inference,
    pipIndex: index,
    installedAt: Date.now(),
  });
  await fillCommand(pythonPath, sidecarPath);
  emit(100, "done");
  return { pythonPath, sidecarPath };
}

/**
 * 把「"<python>" "<script>"」写进侧车命令偏好。写入失败（设置存储异常）必须
 * 让用户知道，而不是让进度窗报「已完成」而命令那一栏空着。
 */
async function fillCommand(pythonPath: string, sidecarPath: string): Promise<void> {
  const command = buildSidecarCommand(pythonPath, sidecarPath);
  if (!setPref(SIDECAR_PATH_PREF, command)) {
    throw new Error(getString("sidecar-error-pref-write", { command }));
  }
}

/** 毫秒 → 分钟数（超时文案用，向上取整，30 分钟不说成 29）。 */
function minutesOf(ms: number): string {
  return String(Math.max(1, Math.round(ms / 60000)));
}

/**
 * 取消归类：安装中途取消不是安装失败，不该报成「依赖安装失败：aborted」。
 * 类与约定见 core/pdf/CancelledError.ts——调用方按 name 识别。
 */
function throwIfCancelled(): never {
  throw new ZTransplitCancelledError();
}

/** 清理侧车环境（「修复」入口：删脚本与标记，命令偏好一并清掉以免指向失效路径）。 */
export async function discardSidecarEnv(): Promise<void> {
  try {
    const IOUtils = (globalThis as any).IOUtils;
    await IOUtils.remove(getSidecarDir(), { recursive: true, ignoreAbsent: true });
  } catch (e) {
    safeDebug("[Z-Transplit] sidecarEnv: discard failed: " + e);
  }
  setPref(SIDECAR_PATH_PREF, "");
}

/**
 * 从 `--selftest` 的 stdout 里取识别引擎版本与推理模式（都是同一个 JSON
 * 行的字段，取不到就算了）。推理模式是侧车自检时探测出来的计算路径：
 * 默认模式在本机撞 oneDNN 缺陷时，自检会换成兼容模式重新探通，这里读到的
 * 就是实际生效的那个。
 */
function parseSelftestOutput(
  stdout: string,
): { engineVersion?: string; inference?: string } {
  const lines = (stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.includes("selftest"));
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const engineVersion =
        typeof parsed?.engineVersion === "string" && parsed.engineVersion
          ? parsed.engineVersion
          : undefined;
      const inference =
        typeof parsed?.inference === "string" && parsed.inference
          ? parsed.inference
          : undefined;
      if (engineVersion || inference) return { engineVersion, inference };
    } catch {
      // 下一行再试：stdout 上出现别的 JSON 行不该让版本信息静默丢失
    }
  }
  return {};
}

/** 取一段输出的末尾（错误信息总在最后几行）。 */
function tailOf(text: string, maxChars: number): string {
  const trimmed = (text || "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return "…" + trimmed.slice(trimmed.length - maxChars);
}
