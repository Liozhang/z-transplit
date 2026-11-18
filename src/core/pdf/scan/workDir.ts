/**
 * workDir — 扫描子系统共用的临时工作目录构造。
 *
 * 与 OpenDataLoaderPdfClient.createTempDir 同一套机制（Zotero 临时目录 +
 * createUnique + 0700），但按前缀区分族：ztransplit-scan-sidecar-* 是侧车
 * 自己的输出目录，ztransplit-scan-run-* 是管线的断点账目目录。名字不同，
 * 排障时一眼能分清哪个该留、哪个该删。
 *
 * Host-coupled（依赖 Zotero.getTempDirectory 或 XPCOM 目录服务）。
 *
 * @module core/pdf/scan/workDir
 */

/** nsIFile.DIRECTORY_TYPE 的数值。Gecko 常量；测试宿主不提供 Components
 *  接口桩时用同一数值，避免为了让单测跑起来而伪造整套 XPCOM。 */
const NS_DIRECTORY_TYPE = 1;

/** 在系统临时目录下建一个 0700 的唯一子目录，返回绝对路径。 */
export function createWorkDir(prefix: string): string {
  const Cc = (globalThis as any).Components?.classes;
  const Ci = (globalThis as any).Components?.interfaces;
  const tmpDir =
    (globalThis as any).Zotero?.getTempDirectory?.() ||
    Cc?.["@mozilla.org/file/directory_service;1"]
      ?.getService(Ci?.nsProperties)
      ?.get("TmpD", Ci?.nsIFile);
  const dir = tmpDir?.clone?.();
  dir.append(`${prefix}${Date.now()}`);
  dir.createUnique(Ci?.nsIFile?.DIRECTORY_TYPE ?? NS_DIRECTORY_TYPE, 0o700);
  return dir.path;
}

/**
 * 拼接工作目录下的文件路径。必须走 PathUtils.join：临时目录路径在 Windows
 * 下是反斜杠，手拼正斜杠会得到混合分隔符，IOUtils 直接拒收（见
 * opendataloaderSplitAdapter 里 DataDirectory.dir 的同类坑）。
 */
export function joinWorkPath(dir: string, name: string): string {
  const PathUtils = (globalThis as any).PathUtils;
  return PathUtils?.join?.(dir, name) ?? `${dir}\\${name}`;
}
