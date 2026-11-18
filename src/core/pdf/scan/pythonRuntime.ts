/**
 * pythonRuntime — 识别侧车用的 CPython 运行时：定位、安装、状态、清理。
 *
 * 为什么需要它：扫描识别跑在插件外的 Python 侧车里（tools/scan-sidecar/
 * sidecar.py）。让用户自己装 Python 与依赖是最常见的中途弃坑点，因此运行时
 * 本身由插件分发——按平台取 python-build-standalone 的 install_only 构件，
 * 装到数据目录，定位后交给侧车命令行使用。
 *
 * 信任链（与 jar 的 PROVENANCE、JRE 的 Adoptium API 同一套形状）：
 *   1. 随包清单 src/core/pdf/lib/PYTHON-RUNTIME.json 声明"哪个平台取哪个
 *      构件、校验和清单在哪"；
 *   2. 安装时现取上游随发行版发布的 SHA256SUMS（信任锚），取出本平台构件
 *      的指纹；
 *   3. 字节必须过 SHA-256 才解包；镜像只负责送字节，对不上就换源；
 *   4. 解到暂存区、跑一次 `python -V` 探活、通过才原子换名落地——解压中断
 *      或装出不跑的运行时都不会占据正式位置。
 *
 * 清单不存单构件指纹：一个发行版六个平台，逐个人工登记只会让人懒得更新，
 * 而"更新时漏登记一个平台"比"不登记"更危险（那会让该平台静默用旧版）。
 *
 * 已知边界：本模块只分发解释器。侧车的模型依赖（onnxruntime、rapidocr 等）
 * 体积大且与识别引擎强耦合，仍由用户在设置里配置带依赖的命令行；受管运行时
 * 落地后，那条命令行可以直接写 `<受管 python> <sidecar.py>`。
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

export interface PythonRuntimeStatus {
  /** 受管运行时可用（存在且探活通过）。 */
  ready: boolean;
  version?: string;
  path?: string;
  /** 恒为 true——本模块只管受管运行时，不认系统 Python。 */
  managed?: boolean;
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
  const candidate = await getManagedPythonPath();
  if (!candidate) return null;
  try {
    const IOUtils = (globalThis as any).IOUtils;
    if (!IOUtils?.exists || !(await IOUtils.exists(candidate))) return null;
  } catch (e) {
    safeDebug("[Z-Transplit] pythonRuntime: " + e);
    return null;
  }
  const probe = await runProcess(candidate, ["-V"], PROBE_TIMEOUT_MS);
  if (probe.exitCode !== 0 || probe.aborted) {
    safeDebug(
      `[Z-Transplit] pythonRuntime: probe failed (exit ${probe.exitCode}): ${probe.stderr}`,
    );
    return null;
  }
  return candidate;
}

/** 状态查询（面板只读行）。不触发下载。 */
export async function getPythonRuntimeStatus(): Promise<PythonRuntimeStatus> {
  const platform = pythonRuntimePlatformKey();
  if (!platform) {
    return { ready: false, error: getString("py-error-unsupported-platform") };
  }
  const path = await getManagedPythonPath();
  if (!path) {
    return { ready: false, error: getString("py-status-not-installed") };
  }
  const resolved = await resolveManagedPython();
  if (!resolved) {
    return { ready: false, error: getString("py-status-not-installed") };
  }
  const probe = await runProcess(resolved, ["-V"], PROBE_TIMEOUT_MS);
  const version = parsePythonVersion(probe.stdout || probe.stderr);
  return {
    ready: true,
    path: resolved,
    managed: true,
    ...(version ? { version } : {}),
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
  const resp = await (Zotero as any).HTTP.request("GET", manifest.sha256Sums, {
    responseType: "text",
    timeout: CHECKSUM_TIMEOUT_MS,
  } as any);
  if (signal?.aborted) throw new Error("cancelled");
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
        const probe = await runProcess(exe, ["-V"], PROBE_TIMEOUT_MS);
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
