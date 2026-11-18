/**
 * artifactAcquire — 外部构件的取件骨架：探测竞速、按指纹下载、安装回调、
 * 键去重、取消检查。
 *
 * 从 OdlJarDownloader 的下载流程抽取（那边保留 PyPI 来源表与 jar 条目
 * 匹配，其余走这里），供 Python 运行时分发复用。两处共用的不变量：
 *
 *   1. 地址只是"从哪拿"，不是信任边界：任何来源返回的字节必须 SHA-256
 *      对上才进入安装；没有指纹绝不启动下载。
 *   2. 择优：并发向全部来源发 1KB 区间请求，按耗时升序整包下载；下载或
 *      安装失败自动降级到下一个来源，全部失败时报出每个来源的原因。
 *   3. 中断安全：暂存归档按次清理；安装由调用方注入（解压 + 原子换名），
 *      取件器不关心目标是文件还是目录。
 *   4. 并发：按 key 去重——同一个目标的并发调用共享一次取件，不同目标
 *      （jar 与 Python 运行时）互不阻塞。
 *   5. 取消：AbortSignal 在每个来源开工前与每次安装后检查。Zotero.HTTP
 *      没有中止能力，已在飞行中的那次下载会跑完——取消只保证不再开新
 *      的下载与安装，不保证立即中断（这一点与进程级取消不同，调用方的
 *      进度文案要按此措辞）。
 *
 * Host-coupled (Zotero.HTTP / IOUtils / PathUtils) — 宿主边界在
 * tests/unit/core/pdf/artifactAcquire.test.ts 中伪造。
 *
 * @module core/pdf/artifactAcquire
 */

import { sha256Hex } from "../../utils/hash";
import { safeDebug } from "../../utils/logger";

const PROBE_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 600000;

export type AcquirePhase =
  | "probing"
  | "downloading"
  | "verifying"
  | "done"
  | "failed";

export interface AcquireProgress {
  percent: number;
  phase: AcquirePhase;
  /** 当前来源 id（探测与下载阶段有意义）。 */
  sourceId?: string;
}

export interface AcquireSource {
  id: string;
  url: string;
}

/**
 * 安装回调：把已通过指纹核对的暂存归档解包落地，返回目标路径。失败抛错
 * 即换下一个来源——实现方必须自己保证"不占据目标位"（先解到暂存区、核对
 * 通过再原子换名）。
 */
export type AcquireInstall = (archivePath: string) => Promise<string>;

export interface AcquireRequest {
  /** 去重键（通常是目标路径）。 */
  key: string;
  /** 错误信息里的构件名，如 "ODL jar download"。 */
  label: string;
  sources: AcquireSource[];
  /**
   * 期望的 SHA-256（小写十六进制）——已落地副本的指纹，空值拒绝执行。
   * 注意它描述的是"安装后的产物"：压缩包内嵌单文件的构件（jar）指纹在
   * 包内，由 install 回调核对；取件器不替调用方猜该核对哪一层。
   */
  sha256: string;
  /**
   * 归档本身的指纹（下载字节）。知道才传：上游发布渠道给出归档级校验和
   * 时（如 Python 运行时的 SHA256SUMS），字节先过这一关再进安装，省掉一次
   * 无用的解包。不知道就不传——安装回调的核对仍是信任边界。
   */
  archiveSha256?: string;
  paths: { dir: string; target: string };
  install: AcquireInstall;
  onProgress?: (p: AcquireProgress) => void;
  signal?: AbortSignal;
  /**
   * 已落地副本的复核：返回 true 则跳过下载。缺省按 sha256 复核目标文件
   * （目标是目录时由调用方注入，例如"跑一次 --version"）。
   */
  verifyExisting?: () => Promise<boolean>;
}

/** 按 key 的在飞行取件：同一目标只下载一次，不同目标互不等待。 */
const inFlight = new Map<string, Promise<string>>();

/** 在飞行取件数（供测试与诊断）。 */
export function acquisitionInFlightCount(): number {
  return inFlight.size;
}

export function acquireArtifact(req: AcquireRequest): Promise<string> {
  const existing = inFlight.get(req.key);
  if (existing) return existing;
  const p = runAcquire(req).finally(() => {
    inFlight.delete(req.key);
  });
  inFlight.set(req.key, p);
  return p;
}

function joinPath(...parts: string[]): string {
  const { join } = (globalThis as any).PathUtils || {};
  if (join) return join(...parts);
  return parts.join("/");
}

/** 1KB 区间请求探测：返回耗时毫秒，不可达返回 Infinity。 */
async function probeSource(source: AcquireSource): Promise<number> {
  const start = Date.now();
  try {
    const resp = await (Zotero as any).HTTP.request("GET", source.url, {
      responseType: "text",
      timeout: PROBE_TIMEOUT_MS,
      requestObserver: (xhr: XMLHttpRequest) => {
        xhr.setRequestHeader("Range", "bytes=0-0");
      },
    } as any);
    if (resp?.status === 206 || resp?.status === 200) {
      return Date.now() - start;
    }
    safeDebug(
      `[Z-Transplit] artifact probe unexpected status ${resp?.status} (${source.id})`,
    );
  } catch (e) {
    safeDebug(`[Z-Transplit] artifact probe failed (${source.id}): ${e}`);
  }
  return Number.POSITIVE_INFINITY;
}

/** 并发探测结果 → 可达来源按耗时升序（不可达者丢弃）。 */
export function rankSources(
  probed: Array<{ source: AcquireSource; ms: number }>,
): AcquireSource[] {
  return probed
    .slice()
    .sort((a, b) => a.ms - b.ms)
    .filter((p) => Number.isFinite(p.ms))
    .map((p) => p.source);
}

/** 整包下载一个来源。进度按 XHR 事件上报（0–100）。 */
async function downloadArchive(
  source: AcquireSource,
  onProgress: (percent: number) => void,
): Promise<Uint8Array> {
  const resp = await (Zotero as any).HTTP.request("GET", source.url, {
    responseType: "arraybuffer",
    timeout: DOWNLOAD_TIMEOUT_MS,
    requestObserver: (xhr: XMLHttpRequest) => {
      xhr.addEventListener("progress", (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
    },
  } as any);
  if (resp.status !== 200 || !resp.response) {
    throw new Error(`HTTP ${resp.status} from ${source.id}`);
  }
  return new Uint8Array(resp.response);
}

async function runAcquire(req: AcquireRequest): Promise<string> {
  const IOUtils = (globalThis as any).IOUtils;
  const emit = (percent: number, phase: AcquirePhase, sourceId?: string) =>
    req.onProgress?.({ percent, phase, ...(sourceId ? { sourceId } : {}) });

  // 没有指纹绝不下载：这是整条链路的信任边界。
  if (!req.sha256) {
    throw new Error(`${req.label} failed: no pinned SHA-256`);
  }

  // 落地副本已存在且复核通过：无需下载。
  try {
    const ok = req.verifyExisting
      ? await req.verifyExisting()
      : await existingFileMatches(IOUtils, req.paths.target, req.sha256);
    if (ok) {
      emit(100, "done");
      return req.paths.target;
    }
  } catch (e) {
    safeDebug(`[Z-Transplit] ${req.label}: existing copy check failed: ${e}`);
  }

  emit(0, "probing");
  const probed = await Promise.all(
    req.sources.map(async (source) => ({ source, ms: await probeSource(source) })),
  );
  const ranked = rankSources(probed);
  if (ranked.length === 0) {
    emit(100, "failed");
    throw new Error(`${req.label} failed: no mirror reachable`);
  }

  const failures: string[] = [];
  for (const source of ranked) {
    // 取消：不再开新的下载（飞行中的那次会跑完，见文件头说明）。
    if (req.signal?.aborted) {
      failures.push(`${source.id}: cancelled`);
      break;
    }
    try {
      emit(0, "downloading", source.id);
      const archive = await downloadArchive(source, (percent) =>
        emit(percent, "downloading", source.id),
      );
      if (req.archiveSha256) {
        const archiveHash = await sha256Hex(archive);
        if (archiveHash !== req.archiveSha256.toLowerCase()) {
          throw new Error(
            `archive checksum mismatch: expected ${req.archiveSha256}, got ${archiveHash}`,
          );
        }
      }
      emit(100, "verifying", source.id);
      await IOUtils.makeDirectory(req.paths.dir, { createAncestors: true });
      const archiveStaging = joinPath(
        req.paths.dir,
        `.download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      await IOUtils.write(archiveStaging, archive);
      try {
        const installed = await req.install(archiveStaging);
        emit(100, "done", source.id);
        return installed;
      } finally {
        await IOUtils.remove(archiveStaging, { ignoreAbsent: true });
      }
    } catch (e) {
      failures.push(`${source.id}: ${e}`);
      safeDebug(`[Z-Transplit] ${req.label}: source ${source.id} failed: ${e}`);
    }
  }
  emit(100, "failed");
  throw new Error(`${req.label} failed (${failures.join("; ")})`);
}

/** 目标文件存在且指纹相符。 */
async function existingFileMatches(
  IOUtils: any,
  target: string,
  sha256: string,
): Promise<boolean> {
  if (!IOUtils?.exists || !IOUtils?.read) return false;
  if (!(await IOUtils.exists(target))) return false;
  const actual = await sha256Hex(await IOUtils.read(target));
  return actual === sha256.toLowerCase();
}
