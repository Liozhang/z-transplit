/**
 * pathSearch — 在 PATH 上按名字找可执行文件，返回绝对路径。
 *
 * 为什么需要：Gecko 的 Subprocess 与 nsIProcess 都不做 PATH 查找。按名字启动
 * （`Subprocess.call({ command: "python" })`）会直接失败，报
 * "File at path \"python\" does not exist, or is not executable"——真机实测
 * （Zotero 10.0.8 / Windows）：PATH 里明明有 `C:\Python313\python.exe`，按名字
 * 启动仍然起不来。因此"用机器上已有的解释器"必须自己把名字解析成绝对路径，
 * 否则这条路径永远不会触发，只会静默退回下载插件自己的运行时。
 *
 * 解析成绝对路径还有一层好处：侧车命令与安装标记里存的是具体文件，PATH 之后
 * 变化不影响已配好的环境。
 *
 * 同步是硬约束（nsIFile / nsIEnvironment 都是同步接口），调用方在同步链上也能用。
 *
 * Host-coupled (nsIFile / nsIEnvironment) — 在 tests/unit/core/pdf/pathSearch.test.ts
 * 的内存宿主上覆盖。
 *
 * @module core/pdf/pathSearch
 */

import { safeDebug } from "../../utils/logger";
import { isWindows } from "./platform";

/** 读一个环境变量；宿主不可用或读取失败时返回 undefined（绝不抛）。 */
export function readEnvVar(name: string): string | undefined {
  try {
    const Cc = (Components as any).classes;
    const Ci = (Components as any).interfaces;
    const env = Cc["@mozilla.org/process/environment;1"]?.getService?.(Ci.nsIEnvironment);
    return env?.get(name) ?? undefined;
  } catch (e) {
    safeDebug("[Z-Transplit] pathSearch: read " + name + " failed: " + e);
    return undefined;
  }
}

/**
 * PATH 上所有叫这个名字的可执行文件（绝对路径，按 PATH 顺序）。
 *
 * Windows 上补 `.exe`：PATH 条目里登记的是 `C:\Python313`，文件是
 * `python.exe`，拼接时要带上扩展名（PATHEXT 里的其他扩展名不猜——解释器与
 * java 都不靠它们启动）。
 */
export function findExecutablesOnPath(name: string): string[] {
  const pathStr = readEnvVar("PATH") || "";
  const separator = isWindows() ? ";" : ":";
  const binName = isWindows() ? `${name}.exe` : name;
  const dirSeparator = isWindows() ? "\\" : "/";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of pathStr.split(separator)) {
    // 去掉首尾空白与末尾斜杠：PATH 条目里 "C:\Java\bin\" 这种写法很常见。
    const trimmed = dir.trim().replace(/[\\/]+$/, "");
    if (!trimmed) continue;
    const candidate = `${trimmed}${dirSeparator}${binName}`;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) out.push(candidate);
  }
  return out;
}

/** PATH 上第一个叫这个名字的可执行文件；一个都没有返回 null。 */
export function findExecutableOnPath(name: string): string | null {
  return findExecutablesOnPath(name)[0] ?? null;
}

/** 存在且可执行（目录、符号链接断裂、无执行位的都算不可执行）。 */
function isExecutableFile(path: string): boolean {
  try {
    const Cc = (Components as any).classes;
    const Ci = (Components as any).interfaces;
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file.exists() && !file.isDirectory() && file.isExecutable();
  } catch (e) {
    safeDebug("[Z-Transplit] pathSearch: stat " + path + " failed: " + e);
    return false;
  }
}
