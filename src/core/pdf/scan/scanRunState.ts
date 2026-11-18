/**
 * scanRunState — 扫描识别的跨会话断点状态。
 *
 * 解决的问题：一本 300 页的扫描件识别到第 250 页被取消或失败，重跑时
 * 不该从第一页开始。状态按附件落在数据目录（不是临时目录——临时目录
 * 活不过会话），每页一份识别结果，加一份清单。
 *
 * 防过期：源 PDF 换版（修改时间或字节数变化）时整套状态作废重来——
 * 拿旧文件的识别结果配新文件的页面坐标，比不识别更糟。
 *
 * 存的是侧车的原始单页结果（SidecarPageResult），不是转换后的 IR：
 * 续跑的页与新鲜识别的页走同一条装配路径，计数与坐标换算只有一份实现。
 *
 * Host-coupled：目录解析与文件读写依赖 Zotero 数据目录与 IOUtils；
 * 纯函数（指纹、清单序列化与校验、单页校验）单独导出供单测。
 *
 * @module core/pdf/scan/scanRunState
 */

import { safeDebug } from "../../../utils/logger";
import { parseSidecarPageResult, type SidecarPageResult } from "./sidecarProtocol";

/** 清单格式版本。 */
const RUN_MANIFEST_VERSION = 1;

/** 单页结果文件名：page-0001.json。 */
export function pageStateFileName(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(4, "0")}.json`;
}

/** 清单文件名。 */
export const RUN_MANIFEST_FILE = "manifest.json";

export interface ScanRunManifest {
  version: number;
  /** 源文件指纹（runStateFingerprint 的产出）；不匹配即作废。 */
  fingerprint: string;
  /** 已识别页的 1 基页码，升序。 */
  pages: number[];
  /** 最近一次写入的时间戳（毫秒）。 */
  updatedAt: number;
}

/**
 * 源文件指纹：修改时间加字节数。两者都取——只取时间，拷贝会保留时间；
 * 只取大小，同大小的改版漏得掉。
 */
export function runStateFingerprint(mtimeMs: number, bytes: number): string {
  return `${Math.trunc(mtimeMs)}:${Math.trunc(bytes)}`;
}

export function serializeRunManifest(manifest: ScanRunManifest): string {
  return JSON.stringify(manifest);
}

/** 解析清单。任何不符（版本、类型、页序）都返回 null，按"无状态"处理。 */
export function parseRunManifest(raw: string): ScanRunManifest | null {
  try {
    const parsed = JSON.parse(raw) as ScanRunManifest;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== RUN_MANIFEST_VERSION) return null;
    if (typeof parsed.fingerprint !== "string" || !parsed.fingerprint) return null;
    if (!Array.isArray(parsed.pages)) return null;
    const pages = parsed.pages.filter(
      (p): p is number => Number.isInteger(p) && p >= 1,
    );
    if (pages.length !== parsed.pages.length) return null;
    return {
      version: RUN_MANIFEST_VERSION,
      fingerprint: parsed.fingerprint,
      pages: [...pages].sort((a, b) => a - b),
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/** 解析存档的单页结果（复用侧车协议的校验，畸形页按不存在处理）。 */
export function parseStoredPage(raw: string): SidecarPageResult | null {
  try {
    return parseSidecarPageResult(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface ScanRunState {
  /** 状态目录（{DataDir}/ztransplit/scan-state/<附件 id>）。 */
  dir: string;
  /** 打开时生效的源文件指纹。 */
  fingerprint: string;
  /** 清单里登记已识别、且磁盘上读得回来的页码。 */
  completed: number[];
  /** 读取全部已完成页的识别结果。缺页/坏页跳过（按未完成处理）。 */
  load(): Promise<Map<number, SidecarPageResult>>;
  /** 落一盘识别结果并更新清单。失败只记日志——持久化是优化，不是正确性前提。 */
  save(page: SidecarPageResult): Promise<void>;
  /** 清空整套状态（译文产出后调用，避免无限增长）。 */
  clear(): Promise<void>;
}

/** 数据目录下的状态根目录。 */
function scanStateRoot(): string {
  const dataDir = (globalThis as any).Zotero?.DataDirectory?.dir || "";
  const PathUtils = (globalThis as any).PathUtils;
  return (
    PathUtils?.join?.(dataDir, "ztransplit", "scan-state") ??
    `${dataDir}\\ztransplit\\scan-state`
  );
}

function joinPath(dir: string, name: string): string {
  const PathUtils = (globalThis as any).PathUtils;
  return PathUtils?.join?.(dir, name) ?? `${dir}\\${name}`;
}

async function readTextFile(path: string): Promise<string | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils) return null;
  try {
    const bytes = await IOUtils.read(path);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function writeTextFile(path: string, content: string): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils) return;
  await IOUtils.write(path, new TextEncoder().encode(content));
}

async function removeTree(path: string): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils) return;
  try {
    await IOUtils.remove(path, { recursive: true });
  } catch (e) {
    safeDebug("[Z-Transplit] scanRunState: clear failed: " + e);
  }
}

async function ensureDir(path: string): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils) return;
  try {
    await IOUtils.makeDirectory(path, { ignoreExisting: true });
  } catch (e) {
    safeDebug("[Z-Transplit] scanRunState: makeDirectory failed: " + e);
  }
}

/**
 * 打开（或新建）某个附件的识别状态。指纹不匹配时先清空旧状态再开始——
 * 旧结果是另一个文件的，留着比没有更危险。
 */
export async function openScanRunState(
  attachmentId: number,
  fingerprint: string,
): Promise<ScanRunState> {
  const dir = joinPath(scanStateRoot(), String(attachmentId));
  const manifestPath = joinPath(dir, RUN_MANIFEST_FILE);
  const rawManifest = await readTextFile(manifestPath);
  const manifest = rawManifest ? parseRunManifest(rawManifest) : null;
  if (manifest && manifest.fingerprint !== fingerprint) {
    safeDebug(
      "[Z-Transplit] scanRunState: source changed, discarding stale recognition state",
    );
    await removeTree(dir);
  }
  const effective = manifest && manifest.fingerprint === fingerprint ? manifest : null;
  const completed = effective ? [...effective.pages] : [];

  const state: ScanRunState = {
    dir,
    fingerprint,
    completed,
    async load() {
      const out = new Map<number, SidecarPageResult>();
      for (const pageNumber of state.completed) {
        const raw = await readTextFile(joinPath(dir, pageStateFileName(pageNumber)));
        const page = raw ? parseStoredPage(raw) : null;
        // 只收得回页码与文件都自洽的结果；对不上说明状态损坏，当未完成。
        if (page && page.pageNumber === pageNumber) out.set(pageNumber, page);
      }
      return out;
    },
    async save(page) {
      await ensureDir(dir);
      await writeTextFile(joinPath(dir, pageStateFileName(page.pageNumber)), JSON.stringify(page));
      const pages = new Set(state.completed);
      pages.add(page.pageNumber);
      state.completed = [...pages].sort((a, b) => a - b);
      await writeTextFile(
        manifestPath,
        serializeRunManifest({
          version: RUN_MANIFEST_VERSION,
          fingerprint: state.fingerprint,
          pages: state.completed,
          updatedAt: Date.now(),
        }),
      );
    },
    async clear() {
      state.completed = [];
      await removeTree(dir);
    },
  };
  return state;
}
