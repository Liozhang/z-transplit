/**
 * OdlJarDownloader — 按固定指纹从镜像下载 OpenDataLoader 解析组件（jar）。
 *
 * 精简版安装包不再内置 24MB 的解析组件（见 zotero-plugin.config.ts 的
 * ZTRANSPLIT_FULL_XPI 开关）；首次解析时 getJarPath 走到这里，按随包分发的
 * PROVENANCE*.json 声明的版本与 SHA-256 从镜像取件。取件地址只是“从哪拿”，
 * 不是信任边界——任何来源返回的字节只要 SHA-256 对不上指纹即被拒绝并换下一个
 * 来源，镜像被污染也无法注入不同的文件。
 *
 * “最佳镜像”的选取：并发向全部来源发 1KB 区间请求（字节 0-0），按响应耗时
 * 排序，从最快者整包下载；下载或校验失败自动降级到下一个来源。取件骨架
 * （探测/下载/指纹核对/在飞行去重）与 Python 运行时分发共用
 * artifactAcquire；本文件只保留 PyPI 来源表与 jar 条目匹配。
 *
 * PyPI 轮子的内容寻址路径（/packages/<哈希前缀>/…）无法从版本号推导，因此
 * 固定版本与固定路径成对登记；升级 jar 时与 PROVENANCE.json 一起更新该表
 * （见 PROVENANCE.json 的 howToUpdate）。
 *
 * Host-coupled (Zotero.HTTP / nsIZipReader / IOUtils) — 宿主边界在
 * tests/unit/core/pdf/odlJarDownloader.test.ts 中伪造。
 */

import { sha256Hex } from "../../utils/hash";
import { getString } from "../../utils/locale";
import { safeDebug } from "../../utils/logger";
import {
  acquireArtifact,
  rankSources,
  type AcquireProgress,
  type AcquireSource,
} from "./artifactAcquire";

/** rankSources 从取件器再导出：调用方与测试只认本模块的入口。 */
export { rankSources };

/** 随包 PROVENANCE*.json 中与本下载器相关的字段。 */
export interface PinnedJarMeta {
  file: string; // opendataloader-pdf-cli.jar
  /** Maven 风格坐标，如 org.opendataloader:opendataloader-pdf-cli:2.5.0 */
  artifact: string;
  version: string;
  sha256: string;
  bytes: number;
}

export interface DownloadProgress {
  percent: number;
  phase: "probing" | "downloading" | "verifying" | "done" | "failed";
  message?: string;
}
export type ProgressCallback = (p: DownloadProgress) => void;


/**
 * PyPI 轮子的内容寻址哈希路径，按版本登记。升级 jar 时新增一行，并在
 * PROVENANCE.json 的 howToUpdate 里同步提醒。
 */
const WHEEL_PACKAGE_HASH_PATH: Record<string, string> = {
  "2.5.0":
    "b1/78/c2e5aab0ad1076fc9f76234f021c622e2344543a6a3622152d220781f94f",
  "2.5.17":
    "89/95/5fa96eb9a599eee8734f74130c70ed1f957287ccb7ffb7fa5cb4e62f2e08",
};

/**
 * 与 PyPI 官方源保持同路径布局的镜像（基础地址 → /packages/…）。
 *
 * 收录标准（2026-10 境内直连实测）：五家国内 PyPI 镜像（阿里云 / 清华 /
 * 腾讯云 / 华为云 / 中科大）对同一轮子的区间请求都在一秒上下、整包可用，
 * 且下载字节的 SHA-256 与 PyPI 官方完全一致，因此用同一套内容寻址路径
 * 拼接。官方 files.pythonhosted.org 殿后——境内慢，但保障镜像全部失效时
 * （含境外网络）仍可取件。Maven Central 没有 opendataloader 构件
 * （search.maven.org 查询 numFound=0），上游发布渠道是 GitHub Release 与
 * PyPI 轮子；轮子内嵌 opendataloader_pdf/jar/opendataloader-pdf-cli.jar，
 * 其 SHA-256 与 PROVENANCE.json 的指纹逐字节一致（已实测核对）。GitHub
 * Release 区间可达，整包境内常超时，仅作全球兜底。
 */
const PYPI_MIRRORS = [
  { id: "aliyun-pypi", base: "https://mirrors.aliyun.com/pypi" },
  { id: "tuna-pypi", base: "https://pypi.tuna.tsinghua.edu.cn" },
  { id: "tencent-pypi", base: "https://mirrors.cloud.tencent.com/pypi" },
  { id: "huawei-pypi", base: "https://mirrors.huaweicloud.com/repository/pypi" },
  { id: "ustc-pypi", base: "https://mirrors.ustc.edu.cn/pypi" },
  { id: "pypi", base: "https://files.pythonhosted.org" },
];

/**
 * 候选来源列表。镜像在前（境内友好），规范发布渠道（GitHub Release）殿后；
 * 顺序只决定耗时打平时的优先级，实际顺序由探测延迟决定。
 * 非.opendataloader 系的构件（如自研的区域抹除组件）没有公开镜像，返回空表。
 */
export function buildSources(meta: PinnedJarMeta): AcquireSource[] {
  if (!meta.artifact.includes("opendataloader")) return [];
  const sources: AcquireSource[] = [];
  const hashPath = WHEEL_PACKAGE_HASH_PATH[meta.version];
  if (hashPath) {
    const wheelName = `opendataloader_pdf-${meta.version}-py3-none-any.whl`;
    for (const mirror of PYPI_MIRRORS) {
      sources.push({
        id: mirror.id,
        url: `${mirror.base}/packages/${hashPath}/${wheelName}`,
      });
    }
  }
  sources.push({
    id: "github-release",
    url: `https://github.com/opendataloader-project/opendataloader-pdf/releases/download/v${meta.version}/opendataloader-pdf-cli-${meta.version}.zip`,
  });
  return sources;
}

/**
 * 压缩包条目名是否指向目标 jar。GitHub Release 的 zip 内文件名可能带版本
 * 后缀（…-cli-<版本>.jar），轮子内固定为 …/jar/opendataloader-pdf-cli.jar，
 * 两种都接受。纯函数，供测试。
 */
export function jarEntryMatches(entryName: string, meta: PinnedJarMeta): boolean {
  const leaf = entryName.split("/").pop() || "";
  return (
    leaf === meta.file ||
    leaf === meta.file.replace(/\.jar$/, `-${meta.version}.jar`)
  );
}

/** nsIZipReader 只接受文件路径——压缩包先落盘再解包。 */
function joinPath(...parts: string[]): string {
  const { join } = (globalThis as any).PathUtils || {};
  if (join) return join(...parts);
  return parts.join("/");
}

/** nsIZipReader 枚举元素 → 条目名（不同 Gecko 版本元素类型不同，防御式处理）。 */
function zipEntryName(raw: any): string {
  if (typeof raw === "string") return raw;
  try {
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
 * 打开落盘的压缩包，按条目名定位 jar，解压到暂存文件并逐字节核对 SHA-256，
 * 通过后原子换名落地。任何一步失败都抛错并清理暂存，由调用方降级到下一个
 * 来源。
 *
 * Gecko 的 nsIZipReader 没有 getEntries()——条目枚举只有 findEntries()（返回
 * hasMore()/getNext() 迭代器，元素为条目名字符串），解包用 extract() 直接落
 * 盘；两者与 Zotero 自身 dictionaries.js / BackupService 的用法一致，均已真
 * 机验证。经流读取（getInputStream + nsIBinaryInputStream）的路径在本宿主上
 * 从未跑通，不再使用。
 */
async function installJarFromArchive(
  archivePath: string,
  meta: PinnedJarMeta,
  paths: { dir: string; target: string },
): Promise<string> {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const IOUtils = (globalThis as any).IOUtils;

  const archiveFile = Cc["@mozilla.org/file/local;1"].createInstance(
    Ci.nsIFile,
  );
  archiveFile.initWithPath(archivePath);
  const zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    Ci.nsIZipReader,
  );
  zipReader.open(archiveFile);
  try {
    const finder = zipReader.findEntries("*");
    let entryPath: string | null = null;
    while (finder.hasMore()) {
      const name = zipEntryName(finder.getNext());
      if (jarEntryMatches(name, meta)) {
        entryPath = name;
        break;
      }
    }
    if (!entryPath) {
      throw new Error(
        `jar entry (${meta.file} or ${meta.file.replace(/\.jar$/, `-${meta.version}.jar`)}) not found in archive`,
      );
    }

    await IOUtils.makeDirectory(paths.dir, { createAncestors: true });
    const staging = joinPath(
      paths.dir,
      `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${meta.file}`,
    );
    try {
      // extract 直接落盘到暂存文件，指纹核对通过前绝不占据目标位。压缩条目
      // 可能携带只读权限位，会让后续的覆盖与清理失败——解压后立即改回普通
      // 权限（尽力而为）。
      const stagingFile = Cc["@mozilla.org/file/local;1"].createInstance(
        Ci.nsIFile,
      );
      stagingFile.initWithPath(staging);
      zipReader.extract(entryPath, stagingFile);
      try {
        await IOUtils.setPermissions(staging, 0o644);
      } catch (e) {
        safeDebug("[Z-Transplit ODL] staging chmod skipped: " + e);
      }
      const hash = await sha256Hex(await IOUtils.read(staging));
      if (hash !== meta.sha256) {
        throw new Error(
          `jar checksum mismatch: expected ${meta.sha256}, got ${hash}`,
        );
      }
      await IOUtils.remove(paths.target, { ignoreAbsent: true });
      await IOUtils.move(staging, paths.target);
    } catch (e) {
      try {
        await IOUtils.remove(staging, { ignoreAbsent: true });
      } catch (e2) {
        safeDebug("[Z-Transplit ODL] " + e2);
      }
      throw e;
    }
    safeDebug(
      `[Z-Transplit ODL] jar installed from ${archivePath} → ${paths.target}`,
    );
    return paths.target;
  } finally {
    try {
      zipReader.close();
    } catch (e) {
      safeDebug("[Z-Transplit ODL] " + e);
    }
  }
}

/**
 * 按指纹取件并安装解析组件 jar。来源表在本文件（PyPI 镜像 + GitHub
 * Release），探测/下载/指纹核对/在飞行去重在 artifactAcquire——不同构件
 * （jar、Python 运行时）按目标路径各去重一票，互不等待。
 *
 * 进度事件链必须走到 done：调用方的进度弹窗靠终止事件自动关闭（精简版
 * 安装包的首次解析必然走到这里）。
 */
export function downloadPinnedJar(
  meta: PinnedJarMeta,
  paths: { dir: string; target: string },
  onProgress?: ProgressCallback,
): Promise<string> {
  return acquireArtifact({
    key: paths.target,
    label: "ODL jar download",
    sources: buildSources(meta),
    sha256: meta.sha256,
    paths,
    install: (archivePath) => installJarFromArchive(archivePath, meta, paths),
    onProgress: (p: AcquireProgress) => {
      switch (p.phase) {
        case "probing":
          onProgress?.({
            percent: 0,
            phase: "probing",
            message: getString("odl-jar-download-probe"),
          });
          break;
        case "downloading":
          onProgress?.({
            percent: p.percent,
            phase: "downloading",
            message:
              `${getString("odl-jar-download-downloading", { percent: p.percent })}` +
              (p.sourceId ? ` [${p.sourceId}]` : ""),
          });
          break;
        case "verifying":
          onProgress?.({
            percent: 100,
            phase: "verifying",
            message: getString("odl-jar-download-verifying"),
          });
          break;
        case "done":
          onProgress?.({
            percent: 100,
            phase: "done",
            message: getString("odl-jar-download-done"),
          });
          break;
        case "failed":
          onProgress?.({
            percent: 100,
            phase: "failed",
            message: getString("odl-error-jar-download-failed"),
          });
          break;
      }
    },
  });
}
