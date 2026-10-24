/**
 * javaLocator — 跨平台定位可用的 `java` 可执行文件（同步）。
 *
 * WHY THIS EXISTS: 插件用 `java -jar` 子进程驱动两个 jar（PDF 解析与原文
 * 抹除），"找到 java" 是整条链路的入口。这逻辑原先后存两份——
 * OpenDataLoaderPdfClient.resolveJavaExecutable 与
 * JavaRuntimeManager.findSystemJava——且都只查 PATH 加三五个硬编码路径，
 * 留下三类真实失败（用户侧表现为"无法调用 java"）：
 *
 *   1. Windows：Temurin 的 MSI / winget 安装目录带补丁版本号（
 *      C:\Program Files\Eclipse Adoptium\jdk-17.0.20.1-hotspot），硬编码的
 *      无版本号 jdk-17 永远匹配不上。PATH 里没有 java 时（安装时取消勾选
 *      "Add to PATH"、便携版解压即用）就彻底找不到。
 *   2. macOS：/usr/bin/java 是个存根——没装 JDK 时它照样存在且可执行，旧
 *      逻辑把它当"找到 java"返回，真正的报错是一句看不懂的 "No Java
 *      runtime present"。同时 /Library/Java/JavaVirtualMachines、Android
 *      Studio 内置 jbr、Homebrew openjdk 这些最常见位置全都没查。
 *   3. JAVA_HOME 设了却不被读取：用户装好 JDK 并按惯例设了 JAVA_HOME，
 *      插件依旧说找不到。
 *
 * 统一到这里：一份按优先级排序的候选清单——JAVA_HOME → 各平台真实安装
 * 位置（含目录枚举，不猜版本号）→ PATH，macOS 的 /usr/bin/java 存根排在
 * 所有真实位置之后。同步是硬约束：execJar 的调用链上是同步解析，不能
 * 引入 await；目录枚举因此走 nsIFile.directoryEntries（chrome 权限域可用）。
 *
 * 与 platform.ts 的分工：OS 判断复用那边的 isWindows/isMac（三重回退，
 * 不用 process.platform——chrome 权限域里它不可靠）。
 *
 * Host-coupled (nsIFile / nsIEnvironment) — 目录枚举与 PATH 拆分在
 * tests/unit/core/pdf/javaLocator.test.ts 的内存宿主上覆盖。
 *
 * @module core/pdf/javaLocator
 */

import { safeDebug } from "../../utils/logger";
import { isMac, isWindows } from "./platform";

/** 已存在且可执行的 java 候选路径，按优先级排序。 */
export function findJavaCandidates(): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const createFile = (p: string) => {
    try {
      const file = (Components as any).classes[
        "@mozilla.org/file/local;1"
      ].createInstance((Components as any).interfaces.nsIFile);
      file.initWithPath(p);
      return file;
    } catch (e) {
      safeDebug("[Z-Transplit] javaLocator: " + e);
      return null;
    }
  };

  const push = (p: string) => {
    if (!p || seen.has(p)) return;
    const file = createFile(p);
    if (file && file.exists() && file.isExecutable()) {
      seen.add(p);
      found.push(p);
    }
  };

  for (const candidate of absoluteCandidates()) push(candidate);
  for (const candidate of pathCandidates()) push(candidate);
  return found;
}

/** 优先级最高的可用 java；一个都没有时返回 null。 */
export function resolveJavaExecutable(): string | null {
  const candidates = findJavaCandidates();
  return candidates.length > 0 ? candidates[0] : null;
}

// ─── 绝对位置候选 ────────────────────────────────────────────────

function absoluteCandidates(): string[] {
  const out: string[] = [];

  // JAVA_HOME 优先：用户/安装器显式声明的位置可信度最高。
  const javaHome = readEnv("JAVA_HOME")?.trim();
  if (javaHome) {
    out.push(joinBin(javaHome));
  }

  if (isWindows()) {
    out.push(...windowsCandidates());
  } else if (isMac()) {
    out.push(...macCandidates());
  } else {
    out.push("/usr/bin/java", "/usr/local/bin/java");
  }
  return out;
}

/**
 * Windows 候选：枚举各家 JDK 安装根目录下的版本化子目录（Temurin 的
 * jdk-17.0.20.1-hotspot、Microsoft 的 jdk-17.0.5.11-hotspot、Corretto 的
 * jdk17.0.5_8、Zulu 的 zulu-17 等），加上 Android Studio 内置 jbr。
 * 版本号不可预测，只能枚举，不能硬编码。
 */
function windowsCandidates(): string[] {
  const out: string[] = [];
  const programFiles =
    readEnv("ProgramFiles")?.trim() || "C:\\Program Files";
  const localAppData = readEnv("LOCALAPPDATA")?.trim();

  const versionedRoots: Array<{ dir: string; pattern: RegExp }> = [
    { dir: `${programFiles}\\Eclipse Adoptium`, pattern: /^jdk-/i },
    { dir: `${programFiles}\\Java`, pattern: /^jdk/i },
    { dir: `${programFiles}\\Microsoft`, pattern: /^jdk-/i },
    { dir: `${programFiles}\\Amazon Corretto`, pattern: /^jdk/i },
    { dir: `${programFiles}\\Zulu`, pattern: /^zulu-/i },
  ];
  for (const root of versionedRoots) {
    for (const child of childDirs(root.dir)) {
      if (root.pattern.test(child)) {
        out.push(`${root.dir}\\${child}\\bin\\java.exe`);
      }
    }
  }

  // Android Studio 内置 JetBrains Runtime（完整 JDK，含 javac）。机器级与
  // 用户级两种安装布局都覆盖。
  const studioJbrs = [
    `${programFiles}\\Android\\Android Studio\\jbr`,
  ];
  if (localAppData) {
    studioJbrs.push(`${localAppData}\\Programs\\Android Studio\\jbr`);
  }
  for (const jbr of studioJbrs) {
    out.push(`${jbr}\\bin\\java.exe`);
  }
  return out;
}

/**
 * macOS 候选：/Library/Java/JavaVirtualMachines 下各厂商 JDK（Temurin 的
 * temurin-17.jdk、Microsoft 的 microsoft-17.jdk、Corretto 的
 * corretto-17.jdk 等，目录名不可预测，枚举）、Android Studio 内置 jbr、
 * Homebrew openjdk（Apple Silicon 与 Intel 两个前缀）。
 *
 * /usr/bin/java 排在最后：它是系统存根，没装 JDK 时也"存在且可执行"，
 * 必须在所有真实位置之后才轮得到它——真实 JDK 缺失时调用方对存根的探测
 * 失败会落到"未找到 Java"的可操作错误，而不是一句看不懂的 stub 报错。
 */
function macCandidates(): string[] {
  const out: string[] = [];

  for (const jdk of childDirs("/Library/Java/JavaVirtualMachines")) {
    if (/\.jdk$/i.test(jdk)) {
      out.push(`/Library/Java/JavaVirtualMachines/${jdk}/Contents/Home/bin/java`);
    }
  }

  const home = readEnv("HOME")?.trim();
  for (const studioApp of [
    "/Applications/Android Studio.app",
    home ? `${home}/Applications/Android Studio.app` : "",
  ]) {
    if (studioApp) out.push(`${studioApp}/Contents/jbr/Contents/Home/bin/java`);
  }

  for (const optRoot of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    for (const formula of childDirs(optRoot)) {
      if (/^openjdk(@\d+)?$/i.test(formula)) {
        out.push(`${optRoot}/${formula}/libexec/openjdk.jdk/Contents/Home/bin/java`);
      }
    }
    out.push(`${optRoot}/openjdk/bin/java`);
  }

  out.push("/usr/bin/java", "/usr/local/bin/java", "/opt/homebrew/bin/java");
  return out;
}

// ─── PATH 候选 ───────────────────────────────────────────────────

function pathCandidates(): string[] {
  const pathStr = readEnv("PATH") || "";
  const separator = isWindows() ? ";" : ":";
  const binName = isWindows() ? "java.exe" : "java";
  const dirSeparator = isWindows() ? "\\" : "/";
  const out: string[] = [];
  for (const dir of pathStr.split(separator)) {
    // 去掉首尾空白与末尾斜杠：PATH 条目里 "C:\Java\bin\" 这种写法很常见，
    // 直接拼接会产出双斜杠，nsIFile 虽能容忍但没必要。
    const trimmed = dir.trim().replace(/[\\/]+$/, "");
    if (!trimmed) continue;
    out.push(`${trimmed}${dirSeparator}${binName}`);
  }
  return out;
}

// ─── 宿主小工具 ──────────────────────────────────────────────────

/** nsIFile 同步枚举子目录名（只返回目录，跳过文件与不可读项）。 */
function childDirs(dir: string): string[] {
  if (!dir) return [];
  try {
    const Cc = (Components as any).classes;
    const Ci = (Components as any).interfaces;
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(dir);
    if (!file.exists() || !file.isDirectory()) return [];
    const names: string[] = [];
    const entries = file.directoryEntries;
    while (entries.hasMoreElements()) {
      const child = entries.getNext();
      try {
        child.QueryInterface(Ci.nsIFile);
        if (child.isDirectory()) names.push(child.leafName);
      } catch (e) {
        safeDebug("[Z-Transplit] javaLocator: " + e);
        /* 单条目失败不影响其余 */
      }
    }
    return names;
  } catch (e) {
    safeDebug("[Z-Transplit] javaLocator: " + e);
    return [];
  }
}

function readEnv(name: string): string | undefined {
  try {
    const Cc = (Components as any).classes;
    const Ci = (Components as any).interfaces;
    const env = Cc["@mozilla.org/process/environment;1"]?.getService?.(
      Ci.nsIEnvironment,
    );
    return env?.get(name) ?? undefined;
  } catch (e) {
    safeDebug("[Z-Transplit] javaLocator: " + e);
    return undefined;
  }
}

/** JAVA_HOME → <home>/bin/java(.exe)，容忍末尾斜杠与缺失的 bin。 */
function joinBin(javaHome: string): string {
  const cleaned = javaHome.trim().replace(/[\\/]+$/, "");
  return isWindows() ? `${cleaned}\\bin\\java.exe` : `${cleaned}/bin/java`;
}
