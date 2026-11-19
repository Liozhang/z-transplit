/**
 * pythonRuntime — 识别侧车用的 CPython：系统 Python 定位、受管运行时分发。
 *
 * 为什么有这一层：扫描识别跑在插件外的 Python 侧车里（addon/scan-sidecar/
 * sidecar.py）。让用户自己装 Python 与依赖是最常见的中途弃坑点，因此运行时
 * 本身可以由插件分发——按平台取 python-build-standalone 的 install_only 构件，
 * 装到数据目录，定位后交给侧车命令行使用。
 *
 * 但机器上已经有 Python 是常态，为此再下载 20–70 MB 是浪费：解释器按
 * "受管运行时 → 系统 Python"的顺序解析（resolvePython）。受管优先是因为它
 * 已装好、核对过指纹、版本已知；受管不存在时系统 Python 直接顶上，一个字节
 * 都不下载。系统候选要过三关才被采用：版本不低于 3.9、`-m pip` 可用（依赖得
 * 装进这个环境）、64 位（paddlepaddle 没有 32 位 Windows 轮子，装到一半才
 * 失败最难查）。三关不过就继续找下一个候选，全不过则装受管运行时。
 *
 * 受管运行时的信任链（与 jar 的 PROVENANCE、JRE 的 Adoptium API 同一套形状）：
 *   1. 随包清单 src/core/pdf/lib/PYTHON-RUNTIME.json 声明"哪个平台取哪个
 *      构件、校验和清单在哪"；
 *   2. 安装时现取上游随发行版发布的 SHA256SUMS（信任锚），取出本平台构件
 *      的指纹；
 *   3. 字节必须过 SHA-256 才解包；镜像只送字节，对不上就换源；
 *   4. 解到暂存区、跑一次 `python -V` 探活、通过才原子换名落地——解压中断
 *      或装出不跑的运行时都不会占据正式位置。
 *
 * 清单不存单构件指纹：一个发行版六个平台，逐个人工登记只会让人懒得更新，
 * 而"更新时漏登记一个平台"比"不登记"更危险（那会让该平台静默用旧版）。
 *
 * 边界：本模块只管解释器。侧车脚本的落地、依赖安装与命令回填由
 * scan/sidecarEnv.ts 的一键安装接着办（它复用本模块的安装与定位）。
 *
 * Host-coupled (Zotero.HTTP / IOUtils / PathUtils / runProcess /
 * extractTarGzArchive) — 宿主边界在 tests/unit/core/pdf/pythonRuntime.test.ts
 * 中伪造。
 *
 * @module core/pdf/scan/pythonRuntime
 */

import { getString } from "../../../utils/locale";
import { safeDebug } from "../../../utils/logger";
import { isMac, isWindows } from "../platform";
import { isArm64Host } from "../platformArch";
import { ZTransplitCancelledError } from "../CancelledError";
import { readBundledLibFile, runProcess } from "../OpenDataLoaderPdfClient";
import { extractTarGzArchive } from "../JavaRuntimeManager";
import { acquireArtifact, type AcquireProgress } from "../artifactAcquire";
import {
  artifactForPlatform,
  artifactSources,
  parsePythonRuntimeManifest,
  parseSha256Sums,
  pythonPlatformFor,
  type PythonPlatform,
  type PythonRuntimeManifest,
} from "./pythonRuntimeManifest";

/** 随包清单在 core/pdf/lib/ 下的文件名。 */
export const PYTHON_RUNTIME_MANIFEST_FILE = "PYTHON-RUNTIME.json";

/** 受管运行时的根目录：{DataDir}/ztransplit/python-runtime。 */
export function getPythonRuntimeDir(): string {
  const dataDir = (Zotero as any).DataDirectory?.dir || "";
  return pathJoin(dataDir, "ztransplit", "python-runtime");
}

function pathJoin(...parts: string[]): string {
  const { join } = (globalThis as any).PathUtils || {};
  if (join) return join(...parts);
  return parts.join("/");
}

/** 解释器的来源：插件分发的受管运行时，或机器上已有的系统 Python。 */
export type PythonSource = "managed" | "system";

/** 一个可用的解释器：路径、版本与来源。 */
export interface ResolvedPython {
  path: string;
  version: string;
  source: PythonSource;
}

export interface PythonRuntimeStatus {
  /** 有一个能用的解释器（受管运行时或系统 Python）。 */
  ready: boolean;
  version?: string;
  path?: string;
  /** 这个解释器从哪来。 */
  source?: PythonSource;
  /** 受管运行时已安装且探活通过（与 ready 的来源可能不同）。 */
  managedInstalled?: boolean;
  error?: string;
}

export type PythonInstallPhase =
  | "checksum"
  | "probing"
  | "downloading"
  | "verifying"
  | "extracting"
  | "done"
  | "failed";

export interface PythonInstallProgress {
  percent: number;
  phase: PythonInstallPhase;
  sourceId?: string;
}

export type PythonInstallCallback = (p: PythonInstallProgress) => void;

const CHECKSUM_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 60000;

/**
 * 系统 Python 的最低版本。与侧车 README 声明的支持面一致：引擎与依赖在
 * 3.9 以上才有对应轮子。
 */
const MIN_SYSTEM_PYTHON = "3.9";

/**
 * PATH 上的候选可执行名，顺序即优先级。
 *
 * 只收"可执行名本身就能启动"的候选：侧车命令是「"<python>" "<script>"」，
 * 带附加参数的启动器（Windows 的 `py -3`）会让命令形状变复杂，而真装了
 * Python 的机器上 `python.exe` 基本都在 PATH 上——找不到就装受管运行时，
 * 那是自足且核对过指纹的。
 */
const SYSTEM_PYTHON_CANDIDATES = ["python3", "python"];

/** 版本号比较：`a >= b`（三段数字，缺段按 0）。 */
function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return true;
}

/**
 * 探测一个候选可执行名是不是"能用来装依赖的解释器"。三条都要过：
 *
 *   1. `python -V` 起得来，且版本不低于 3.9；
 *   2. `python -m pip --version` 可用——依赖要装进这个环境，没有 pip 的
 *      解释器对一键安装没用；
 *   3. 64 位——paddlepaddle 没有 32 位 Windows 轮子，装到一半才失败最难查。
 *
 * 任何一条不过就换下一个候选；全部不过返回 null（调用方改装受管运行时）。
 */
async function probeSystemCandidate(exe: string): Promise<ResolvedPython | null> {
  const pyOpts = { jvmEncodingArgs: false } as const;
  const version = await runProcess(exe, ["-V"], PROBE_TIMEOUT_MS, undefined, pyOpts);
  if (version.exitCode !== 0 || version.aborted) return null;
  const parsed = parsePythonVersion(version.stdout || version.stderr);
  if (!parsed || !versionAtLeast(parsed, MIN_SYSTEM_PYTHON)) return null;

  const pip = await runProcess(
    exe,
    ["-m", "pip", "--version"],
    PROBE_TIMEOUT_MS,
    undefined,
    pyOpts,
  );
  if (pip.exitCode !== 0 || pip.aborted) return null;

  // 指针宽度：32 位解释器装不上主依赖，提前排除。
  const bits = await runProcess(
    exe,
    ["-c", "import struct;print(struct.calcsize('P')*8)"],
    PROBE_TIMEOUT_MS,
    undefined,
    pyOpts,
  );
  if (bits.exitCode !== 0 || bits.aborted) return null;
  if (!/(^|\D)64(\D|$)/.test((bits.stdout || "").trim())) return null;

  return { path: exe, version: parsed, source: "system" };
}

/**
 * 机器上已有的 Python（PATH 上第一个合格的候选）。
 *
 * 不缓存：状态查询每次现探。会话级缓存会让"使用期间装上的 Python"看不见，
 * 也会让"卸掉的 Python"继续显示就绪——面板每次显示都查一次，两三段短进程
 * 启动的代价可以接受（受管运行时那一侧本来也要探一次）。
 */
export async function resolveSystemPython(): Promise<ResolvedPython | null> {
  for (const candidate of SYSTEM_PYTHON_CANDIDATES) {
    const found = await probeSystemCandidate(candidate);
    if (found) return found;
  }
  return null;
}

/**
 * 识别该用哪个解释器：受管运行时优先（已装好且核对过指纹、版本已知），
 * 否则用机器上已有的 Python，两者都没有才由调用方决定安装。
 *
 * 受管优先而不是系统优先：已经装过的运行时是自足且验证过的，重复下载一份
 * 同样的东西没有意义；而"机器上有 Python 就不下载"由这里的第二条分支保证
 * ——受管运行时不存在时，系统 Python 直接顶上，一个字节都不下载。
 */
export async function resolvePython(): Promise<ResolvedPython | null> {
  const managed = await resolveManagedRuntime();
  if (managed) return managed;
  return resolveSystemPython();
}

/** 当前平台的清单键。探测失败或平台不在覆盖表内返回 null。 */
export function pythonRuntimePlatformKey(): PythonPlatform | null {
  const os = isWindows() ? "windows" : isMac() ? "mac" : "linux";
  return pythonPlatformFor(os, isArm64Host() ? "aarch64" : "x64");
}

/** 读取并校验随包清单。缺失或结构不符都返回 null。 */
export async function loadPythonRuntimeManifest(): Promise<PythonRuntimeManifest | null> {
  try {
    const text = await readBundledLibFile(PYTHON_RUNTIME_MANIFEST_FILE);
    if (!text) {
      safeDebug("[Z-Transplit] pythonRuntime: manifest not bundled");
      return null;
    }
    const manifest = parsePythonRuntimeManifest(JSON.parse(text));
    if (!manifest) {
      safeDebug("[Z-Transplit] pythonRuntime: manifest failed validation");
    }
    return manifest;
  } catch (e) {
    safeDebug("[Z-Transplit] pythonRuntime: manifest unreadable: " + e);
    return null;
  }
}

/**
 * 解释器在运行时根目录下的相对路径。清单是权威来源（换发行版不改代码）；
 * 清单读不到时按平台退回约定布局——状态查询不该因为清单缺失就全面失灵。
 */
async function managedExecutableRelPath(): Promise<string> {
  const manifest = await loadPythonRuntimeManifest();
  const platform = pythonRuntimePlatformKey();
  if (manifest && platform) {
    const artifact = artifactForPlatform(manifest, platform);
    if (artifact) return artifact.executable;
  }
  return platform?.startsWith("win-") ? "python/python.exe" : "python/bin/python3";
}

/** 受管 python 的预期路径（未安装时也返回路径，调用方自行判断存在性）。 */
export async function getManagedPythonPath(): Promise<string | null> {
  const platform = pythonRuntimePlatformKey();
  if (!platform) return null;
  // 清单里的相对路径统一用 "/" 写（跨平台数据），落地时按本平台分隔符拼。
  return pathJoin(getPythonRuntimeDir(), ...(await managedExecutableRelPath()).split("/"));
}

/**
 * 定位受管 python：文件在，还要跑一次 `python -V`——装在盘上不等于能跑
 * （解压中断、架构不符都表现为"文件在但起不来"）。探活失败返回 null，调用方
 * 据此走安装或报错，不把跑不起来的运行时当可用。
 */
export async function resolveManagedPython(): Promise<string | null> {
  return (await resolveManagedRuntime())?.path ?? null;
}

/** resolveManagedPython 带版本：识别入口要一并知道用的是哪个版本。 */
async function resolveManagedRuntime(): Promise<ResolvedPython | null> {
  const candidate = await getManagedPythonPath();
  if (!candidate) return null;
  try {
    const IOUtils = (globalThis as any).IOUtils;
    if (!IOUtils?.exists || !(await IOUtils.exists(candidate))) return null;
  } catch (e) {
    safeDebug("[Z-Transplit] pythonRuntime: " + e);
    return null;
  }
  const probe = await runProcess(candidate, ["-V"], PROBE_TIMEOUT_MS, undefined, {
    // 受管运行时是 CPython，不是 JVM（Windows 上 -D 会让它直接退出）。
    jvmEncodingArgs: false,
  });
  if (probe.exitCode !== 0 || probe.aborted) {
    safeDebug(
      `[Z-Transplit] pythonRuntime: probe failed (exit ${probe.exitCode}): ${probe.stderr}`,
    );
    return null;
  }
  return {
    path: candidate,
    version: parsePythonVersion(probe.stdout || probe.stderr) ?? "",
    source: "managed",
  };
}

/**
 * 状态查询（面板只读行）。不触发下载。
 *
 * 回答的是"识别有没有可用的解释器"：受管运行时或机器上已有的 Python 都算。
 * `managedInstalled` 单独交代受管运行时的情况——它的安装/修复按钮要知道自己
 * 面对的是已装、已坏还是没装。
 */
export async function getPythonRuntimeStatus(): Promise<PythonRuntimeStatus> {
  const platform = pythonRuntimePlatformKey();
  if (!platform) {
    return { ready: false, error: getString("py-error-unsupported-platform") };
  }
  const managed = await resolveManagedRuntime();
  const resolved = managed ?? (await resolveSystemPython());
  if (!resolved) {
    return {
      ready: false,
      managedInstalled: false,
      error: getString("py-status-not-installed"),
    };
  }
  return {
    ready: true,
    path: resolved.path,
    source: resolved.source,
    managedInstalled: Boolean(managed),
    ...(resolved.version ? { version: resolved.version } : {}),
  };
}

/** 从 `python -V` 的输出里取版本号（"Python 3.12.16" → "3.12.16"）。 */
export function parsePythonVersion(output: string): string | null {
  const m = /Python\s+(\d+\.\d+\.\d+)/i.exec(output || "");
  return m ? m[1] : null;
}

/** 清理受管运行时（设置面板的"修复"入口：下次安装从零开始）。 */
export async function discardManagedPython(): Promise<void> {
  try {
    await (globalThis as any).IOUtils.remove(getPythonRuntimeDir(), {
      recursive: true,
      ignoreAbsent: true,
    });
  } catch (e) {
    safeDebug("[Z-Transplit] pythonRuntime: discard failed: " + e);
  }
}

/** 进度阶段 → 本地化文案（面板进度行与弹窗共用一套键）。 */
export function pythonInstallMessage(p: PythonInstallProgress): string {
  switch (p.phase) {
    case "checksum":
      return getString("py-progress-checksum");
    case "probing":
      return getString("py-progress-probing");
    case "downloading":
      return (
        getString("py-progress-downloading", { percent: String(p.percent) }) +
        (p.sourceId ? ` [${p.sourceId}]` : "")
      );
    case "verifying":
      return getString("py-progress-verifying");
    case "extracting":
      return getString("py-progress-extracting");
    case "done":
      return getString("py-progress-done");
    case "failed":
      return getString("py-error-install-failed");
  }
}

/** 取上游校验和清单文本（信任锚）。 */
async function fetchSha256Sums(
  manifest: PythonRuntimeManifest,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new ZTransplitCancelledError();
  const resp = await (Zotero as any).HTTP.request("GET", manifest.sha256Sums, {
    responseType: "text",
    timeout: CHECKSUM_TIMEOUT_MS,
  } as any);
  if (signal?.aborted) throw new ZTransplitCancelledError();
  if (resp?.status !== 200 || typeof resp.response !== "string") {
    throw new Error(`SHA256SUMS request returned HTTP ${resp?.status}`);
  }
  return resp.response;
}

/**
 * 安装受管运行时，返回可执行文件路径。任何一步失败都抛错（带本地化文案），
 * 调用方（设置面板 / 进度弹窗）负责呈现。
 */
export async function installPythonRuntime(opts: {
  onProgress?: PythonInstallCallback;
  signal?: AbortSignal;
}): Promise<string> {
  const emit = (percent: number, phase: PythonInstallPhase, sourceId?: string) =>
    opts.onProgress?.({ percent, phase, ...(sourceId ? { sourceId } : {}) });

  const platform = pythonRuntimePlatformKey();
  if (!platform) {
    emit(100, "failed");
    throw new Error(getString("py-error-unsupported-platform"));
  }
  const manifest = await loadPythonRuntimeManifest();
  if (!manifest) {
    emit(100, "failed");
    throw new Error(getString("py-error-manifest-unavailable"));
  }
  const artifact = artifactForPlatform(manifest, platform);
  if (!artifact) {
    emit(100, "failed");
    throw new Error(getString("py-error-manifest-unavailable"));
  }

  // 已装好且探活通过：零网络直接返回。
  const existing = await resolveManagedPython();
  if (existing) {
    emit(100, "done");
    return existing;
  }

  emit(0, "checksum");
  const sumsText = await fetchSha256Sums(manifest, opts.signal);
  const expected = parseSha256Sums(sumsText, artifact.file);
  if (!expected) {
    emit(100, "failed");
    throw new Error(getString("py-error-checksum-unavailable"));
  }

  const runtimeDir = getPythonRuntimeDir();
  await acquireArtifact({
    key: runtimeDir,
    label: "Python runtime install",
    sources: artifactSources(manifest, artifact),
    // sha256 是"已落地产物的指纹"，用于取件器的非空守卫；这里同时传了
    // verifyExisting（目标是目录，按跑得起来复核），所以它不参与文件哈希。
    // 字节那一层的核对走 archiveSha256——上游 SHA256SUMS 给的正是归档指纹。
    sha256: expected,
    archiveSha256: expected,
    paths: {
      dir: pathJoin((Zotero as any).DataDirectory?.dir || "", "ztransplit"),
      target: runtimeDir,
    },
    signal: opts.signal,
    // 已落地副本按"跑得起来"复核（目标是目录，不能按文件哈希）。
    verifyExisting: async () => Boolean(await resolveManagedPython()),
    install: async (archivePath) => {
      emit(0, "extracting");
      const staging = `${runtimeDir}.staging-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const IOUtils = (globalThis as any).IOUtils;
      try {
        await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
        await extractTarGzArchive(archivePath, staging);
        const exe = pathJoin(staging, ...artifact.executable.split("/"));
        if (!IOUtils?.exists || !(await IOUtils.exists(exe))) {
          throw new Error(`executable ${artifact.executable} missing after extract`);
        }
        // 探活通过才原子换位：解压中断或架构不符都不占据正式位置。
        const probe = await runProcess(exe, ["-V"], PROBE_TIMEOUT_MS, undefined, {
          jvmEncodingArgs: false,
        });
        if (probe.exitCode !== 0 || probe.aborted) {
          throw new Error(`probe failed (exit ${probe.exitCode}): ${probe.stderr}`);
        }
        await IOUtils.remove(runtimeDir, { recursive: true, ignoreAbsent: true });
        await IOUtils.move(staging, runtimeDir);
        emit(100, "extracting");
        return pathJoin(runtimeDir, ...artifact.executable.split("/"));
      } catch (e) {
        try {
          await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
        } catch (e2) {
          safeDebug("[Z-Transplit] pythonRuntime: staging cleanup: " + e2);
        }
        throw e;
      }
    },
    onProgress: (p: AcquireProgress) => {
      switch (p.phase) {
        case "probing":
          emit(0, "probing");
          break;
        case "downloading":
          emit(p.percent, "downloading", p.sourceId);
          break;
        case "verifying":
          emit(100, "verifying");
          break;
        case "done":
          emit(100, "done");
          break;
        case "failed":
          emit(100, "failed");
          break;
      }
    },
  });

  // 安装回调返回的是落地路径；再解析一次，确认探活通过（verifyExisting 的
  // 快速路径与安装路径在这里汇合）。
  const resolved = await resolveManagedPython();
  if (!resolved) {
    emit(100, "failed");
    throw new Error(getString("py-error-install-failed"));
  }
  emit(100, "done");
  return resolved;
}
