/**
 * JavaRuntimeManager — Manages a bundled Java JRE for OpenDataLoader.
 *
 * When the user's machine has no Java 11+, this downloads an Eclipse Temurin
 * **portable JRE** (not an installer — a .zip on Windows, .tar.gz on
 * macOS/Linux) from Adoptium, extracts it under {DataDir}/ztransplit/java-runtime/,
 * and exposes the absolute path to its `java` executable. Because it's a
 * portable package extracted into the user's own data directory, it needs no
 * administrator privileges, no UAC elevation, and no system PATH modification —
 * and crucially no Zotero restart: the caller resolves `java` afresh on each
 * invocation, so a freshly-extracted JRE is picked up immediately.
 *
 * Cross-platform (Win + macOS + Linux). Adoptium API (verified):
 *   GET https://api.adoptium.net/v3/binary/latest/{feature}/ga/{os}/{arch}/jre/hotspot/normal/eclipse
 *   → 307 → GitHub release asset (e.g. OpenJDK17U-jre_x64_windows_hotspot_17.0.x_x.zip)
 *   GET https://api.adoptium.net/v3/assets/latest/{feature}/hotspot?os=&architecture=&image_type=jre&vendor=eclipse
 *   → metadata incl. binary.package.checksum (SHA-256), the anchor for
 *     detecting and reusing a previously completed download.
 *
 * 大陆网络下的取件策略（2026-10 实测）：官方 API 本身境内可达，但它返回的
 * 下载地址指向 GitHub release asset，境内直连基本拉不动。因此校验和仍从
 * 官方 API 取（信任锚），安装包优先从国内镜像取——镜像路径可由 API 返回的
 * 包名直接推导（{base}/{feature}/jre/{arch}/{os}/{packageName}），字节经
 * SHA-256 核对与官方一致才落盘（镜像不是信任边界，对不上即换源）。多个镜
 * 像并发探测、按延迟取最快者；镜像不可达时（含境外网络）自动回落到官方二
 * 进制地址，全球可用。实测数据：南京大学镜像 1MB 区间请求 0.30s、清华
 * 0.53s，两者安装包均与官方校验和逐字节一致。
 *
 * The install is interruption-safe: archives are kept across failed installs
 * and reused by SHA-256 on retry, extraction happens in a staging directory
 * that must pass `java -version` before atomically moving into place, and a
 * cached-but-broken runtime is detected by probe and discarded (self-heal).
 *
 * Ported from leadero's src/core/pdf/JavaRuntimeManager.ts. Changes: the managed
 * runtime directory and every temp-file prefix now carry the z-transplit
 * addon name, and log prefixes are renamed. Host-coupled (Zotero.HTTP /
 * nsIProcess / taskkill) — unit-tested against a faked host boundary in
 * tests/unit/core/pdf/javaRuntimeManager.test.ts.
 *
 * @module core/pdf/JavaRuntimeManager
 */


import { getString } from "../../utils/locale";
import { safeDebug } from "../../utils/logger";
import { sha256Hex } from "../../utils/hash";
import { resolveJavaExecutable } from "./javaLocator";

export interface JavaStatus {
  /** A usable java executable path was resolved (managed JRE or system). */
  ready: boolean;
  version?: string;
  path?: string;
  /** True when the resolved java is the plugin-managed JRE. */
  managed?: boolean;
  error?: string;
}

export interface DownloadProgress {
  /** 0–100 during download; indeterminate phases leave percent unchanged. */
  percent: number;
  phase: "querying" | "downloading" | "extracting" | "verifying" | "done";
  message?: string;
}
export type ProgressCallback = (p: DownloadProgress) => void;


function isWindows(): boolean {
  if (Zotero.isWin) return true;
  if (Zotero.platform === "win32" || Zotero.platform === "win") return true;
  try {
    const appinfo = (Components as any).classes[
      "@mozilla.org/xre/app-info;1"
    ]?.getService?.((Components as any).interfaces?.nsIXULRuntime);
    if (appinfo?.OS === "WINNT") return true;
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
    /* ignore */
  }
  return false;
}

function isMac(): boolean {
  if (Zotero.isMac) return true;
  if (Zotero.platform === "macosx" || Zotero.platform === "mac") return true;
  return false;
}

/** Apple Silicon (arm64) vs Intel (x64) on macOS. */
function isMacArm64(): boolean {
  return isArm64();
}

/**
 * ARM64（含 Apple Silicon 与 aarch64 Linux）vs x64。
 * Adoptium 在 Linux 上同样发布 aarch64 的 JRE——固定下载 x64 会让 ARM 设备
 * （能跑 Zotero 的 ARM 笔记本、开发板等）装出跑不起来的运行时。
 * 探测顺序：系统信息服务 → XPCOM ABI（Linux 上最可靠的来源，形如
 * "aarch64-gnueabi-linux"）→ navigator.platform → Zotero.isARM。
 */
function isArm64(): boolean {
  try {
    const sysinfo = (Components as any).classes[
      "@mozilla.org/system-info;1"
    ]?.getService?.((Components as any).interfaces?.nsIPropertyBag2);
    // macOS machine model / arch hints
    const arch = (sysinfo?.get?.("arch") as string) || "";
    if (/aarch64|arm64/i.test(arch)) return true;
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
    /* ignore */
  }
  try {
    const appinfo = (Components as any).classes[
      "@mozilla.org/xre/app-info;1"
    ]?.getService?.((Components as any).interfaces?.nsIXULRuntime);
    const abi = ((appinfo as any)?.XPCOMABI as string) || "";
    if (/aarch64|arm64/i.test(abi)) return true;
    if (/x86_64|amd64/i.test(abi)) return false;
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
    /* ignore */
  }
  try {
    if (/aarch64|arm64/i.test(navigator?.platform || "")) return true;
  } catch (e) {
    /* ignore */
  }
  // Fallback: Zotero 7+ may expose isARM
  if ((Zotero as any).isARM) return true;
  return false;
}


function getDataDir(): string {
  return (Zotero as any).DataDirectory?.dir as string;
}

function pathJoin(...parts: string[]): string {
  const { join } = (globalThis as any).PathUtils || {};
  if (join) return join(...parts);
  return parts.join(isWindows() ? "\\" : "/").replace(/[/\\]+/g, (_m) =>
    isWindows() ? "\\" : "/",
  );
}

/** Managed JRE root: {DataDir}/ztransplit/java-runtime/ */
export function getJavaRuntimeDir(): string {
  return pathJoin(getDataDir(), "ztransplit", "java-runtime");
}

/**
 * Resolve the `java` executable inside the managed JRE dir.
 *
 * Adoptium extracts to a versioned subdir (e.g. `jdk-17.0.19+10-jre/`), so the
 * actual java lives at {runtime-dir}/{jdk-*-jre}/bin/java(.exe). We scan
 * children rather than hard-coding the version. Returns null if not found.
 *
 * A successful resolution is cached in `managedExeCache` so the synchronous
 * resolver in OpenDataLoaderPdfClient can use it without async IO.
 */
let managedExeCache: string | null = null;

/**
 * Synchronous peek at the cached managed-JRE path. Returns null if no managed
 * JRE has been resolved yet (call getManagedJavaExe() async first to populate).
 * Exists so OpenDataLoaderPdfClient.resolveJavaExecutable (which must stay
 * sync) can prefer the managed JRE without async IO.
 */
export function getCachedManagedJavaExe(): string | null {
  return managedExeCache;
}

export async function getManagedJavaExe(): Promise<string | null> {
  if (managedExeCache && (await pathExists(managedExeCache))) {
    return managedExeCache;
  }
  managedExeCache = null;
  const javaExe = await findJavaInDir(getJavaRuntimeDir());
  managedExeCache = javaExe;
  return javaExe;
}

/**
 * Scan a directory for an extracted Temurin JRE and return the absolute path
 * to its `java` executable. Handles both the Windows/Linux layout
 * ({dir}/jdk-xxx/bin/java) and the macOS bundle layout
 * ({dir}/jdk-xxx/Contents/Home/bin/java).
 */
async function findJavaInDir(dir: string): Promise<string | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!(await pathExists(dir))) return null;

  const binName = isWindows() ? "java.exe" : "java";
  try {
    const children = await IOUtils.getChildren(dir);
    // Look for a jdk-* (or jre-*) top-level folder containing bin/java.
    for (const child of children) {
      const name = basename(child);
      if (!/^jdk-/i.test(name) && !/^jre-/i.test(name)) continue;
      for (const tail of [
        ["bin", binName],
        ["Contents", "Home", "bin", binName],
      ]) {
        const candidate = pathJoin(child, ...tail);
        if (await pathExists(candidate)) return candidate;
      }
    }
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
    /* ignore — fall through */
  }
  return null;
}

/**
 * Drop the managed JRE: clear the sync cache and delete the runtime directory
 * (best-effort). Called when a cached managed JRE fails its `java -version`
 * probe — e.g. a truncated extraction — so callers fall back to system Java
 * and a later downloadJRE() starts clean instead of resurrecting the broken
 * tree. Cache clearing matters: resolveJavaExecutable() serves the cached
 * path synchronously and would keep handing out the dead executable.
 */
export async function discardManagedRuntime(): Promise<void> {
  managedExeCache = null;
  try {
    await (globalThis as any).IOUtils.remove(getJavaRuntimeDir(), {
      recursive: true,
      ignoreAbsent: true,
    });
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: discard failed: " + e);
  }
}


async function pathExists(p: string): Promise<boolean> {
  try {
    return await (globalThis as any).IOUtils.exists(p);
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
    return false;
  }
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

// ─── nsIProcess execution ──

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command capturing stdout/stderr via temp-file redirection.
 * nsIProcess has no pipes, so we redirect to files and read them back.
 */
async function execCommand(
  exePath: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<ExecResult> {
  const isWin = isWindows();
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const timeout = opts.timeout ?? 120000;
  const IOUtils = (globalThis as any).IOUtils;

  const tmpDir = (Zotero as any).getTempDirectory();
  const ts = Date.now();
  const stdoutFile = tmpDir.clone();
  stdoutFile.append(`ztransplit-jre-${ts}-out.txt`);
  const stderrFile = tmpDir.clone();
  stderrFile.append(`ztransplit-jre-${ts}-err.txt`);

  let wrapperExe: string;
  let wrapperArgs: string[];

  if (isWin) {
    // 命令与重定向必须留在同一行（批处理里独占一行是语法错误）；chcp 单独
    // 一行打头。
    const commandLine = [
      `@"${exePath}" ${args.map((a) => `"${a}"`).join(" ")}`,
      `> "${stdoutFile.path}" 2> "${stderrFile.path}"`,
    ].join(" ");
    // chcp 65001 把本 cmd 会话的控制台代码页切成 UTF-8——批处理文件本身按
    // UTF-8 落盘（IOUtils.writeUTF8），不切代码页时 cmd 按系统 ANSI 代码页
    // （简体中文 Windows 是 CP936）解码文件里的中文路径，解压与探测直接
    // "找不到路径"。Zotero 数据目录在中文用户名下正是这种路径。实测矩阵
    // （2026-10，Windows）：UTF-8+chcp 在 ASCII 与中文路径下均退出码 0；
    // UTF-8 无 chcp 时中文路径失败；UTF-16LE 批处理在该调用方式下根本不
    // 被执行。代码页只作用于本 cmd 会话，子进程（tar/java）经
    // CreateProcessW 收 Unicode 参数，不受影响。
    const batLines = ["@chcp 65001 >nul", commandLine].join("\r\n");
    const batFile = tmpDir.clone();
    batFile.append(`ztransplit-jre-${ts}.bat`);
    await IOUtils.writeUTF8(batFile.path, batLines);
    wrapperExe = batFile.path;
    wrapperArgs = [];
    try {
      const batNs = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      batNs.initWithPath(wrapperExe);
      const proc0 = Cc["@mozilla.org/process/util;1"].createInstance(
        Ci.nsIProcess,
      );
      proc0.init(batNs);
      // Run bat synchronously-blocking isn't needed; we hand the bat path to
      // the unified promise runner below. But nsIProcess can run .bat directly.
      return runProcessWithObserver(proc0, wrapperArgs, {
        timeout,
        stdoutFile,
        stderrFile,
        cleanupPaths: [batFile.path],
      });
    } catch (e) {
      throw new Error(`Failed to launch extraction: ${e}`, { cause: e });
    }
  } else {
    const cmd = `"${exePath}" ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} > '${stdoutFile.path}' 2> '${stderrFile.path}'`;
    wrapperExe = "/bin/sh";
    wrapperArgs = ["-c", cmd];
    const shFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    shFile.initWithPath(wrapperExe);
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(
      Ci.nsIProcess,
    );
    proc.init(shFile);
    return runProcessWithObserver(proc, wrapperArgs, {
      timeout,
      stdoutFile,
      stderrFile,
    });
  }
}

// M-19: nsIProcess.kill() only terminates the direct child (.bat host on
// Windows, /bin/sh on Unix). The real JVM becomes an orphan and keeps
// running. Use taskkill /T /F on Windows to take down the whole tree;
// on other platforms fall back to plain kill().
async function killProcessTree(proc: any): Promise<void> {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  try {
    if (!proc?.isRunning) return;
    const pid: number | undefined = proc.pid;
    const isWin = isWindows();
    if (isWin && pid) {
      const env = Cc["@mozilla.org/process/environment;1"]?.getService(
        Ci.nsIEnvironment,
      );
      const sysRoot = env?.get("SystemRoot") || "C:\\Windows";
      const taskkillPath = `${sysRoot}\\System32\\taskkill.exe`;
      const tkFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      tkFile.initWithPath(taskkillPath);
      if (!tkFile.exists()) {
        proc.kill();
        return;
      }
      const tkProc = Cc["@mozilla.org/process/util;1"].createInstance(
        Ci.nsIProcess,
      );
      tkProc.init(tkFile);
      await new Promise<void>((resolve) => {
        const obs = {
          observe: () => resolve(),
          QueryInterface: (iid: any) => {
            if (iid.equals(Ci.nsIObserver) || iid.equals(Ci.nsISupports))
              return obs;
            throw (Components as any).results.NS_NOINTERFACE;
          },
        };
        try {
          tkProc.runwAsync(["/T", "/F", "/PID", String(pid)], 4, obs);
        } catch (e) {
          safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
          resolve();
        }
        setTimeout(resolve, 10_000);
      });
      return;
    }
    proc.kill();
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
    try { proc.kill(); } catch (e) {       safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);  /* already dead */ }
  }
}

/** Shared promise runner for an already-init'd nsIProcess. */
function runProcessWithObserver(
  proc: any,
  args: string[],
  ctx: {
    timeout: number;
    stdoutFile: any;
    stderrFile: any;
    cleanupPaths?: string[];
  },
): Promise<ExecResult> {
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const IOUtils = (globalThis as any).IOUtils;
  const { timeout, stdoutFile, stderrFile, cleanupPaths } = ctx;

  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    const finish = (result: Partial<ExecResult>) => {
      if (settled) return;
      settled = true;
      Promise.all([
        IOUtils.readUTF8(stdoutFile.path).catch(() => ""),
        IOUtils.readUTF8(stderrFile.path).catch(() => ""),
      ]).then(([stdout, stderr]) => {
        for (const p of cleanupPaths || []) {
          IOUtils.remove(p).catch((e: any) => { safeDebug("[Z-Transplit] JavaRuntimeManager: temp cleanup failed: " + e); });
        }
        IOUtils.remove(stdoutFile.path).catch((e: any) => { safeDebug("[Z-Transplit] JavaRuntimeManager: temp cleanup failed: " + e); });
        IOUtils.remove(stderrFile.path).catch((e: any) => { safeDebug("[Z-Transplit] JavaRuntimeManager: temp cleanup failed: " + e); });
        resolve({
          exitCode: result.exitCode ?? -1,
          stdout: stdout || "",
          stderr: stderr || "",
          timedOut: result.timedOut ?? false,
        });
      });
    };

    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback(
      {
        notify: () => {
          if (proc.isRunning) {
            // M-19: nsIProcess.kill() only terminates the direct child (.bat
            // host on Windows, /bin/sh on Unix). Use tree-kill so the real
            // JVM doesn't survive as an orphan.
            void (async () => {
              await killProcessTree(proc);
              finish({ exitCode: -1, timedOut: true });
            })();
          }
        },
      },
      timeout,
      Ci.nsITimer.TYPE_ONE_SHOT,
    );

    const observer = {
      observe: (_subject: any, topic: string) => {
        if (topic === "process-finished" || topic === "process-failed") {
          timer.cancel();
          finish({ exitCode: proc.exitValue });
        }
      },
      QueryInterface: (iid: any) => {
        if (iid.equals(Ci.nsIObserver) || iid.equals(Ci.nsISupports))
          return observer;
        throw (Components as any).results.NS_NOINTERFACE;
      },
    };
    proc.runwAsync(args, args.length, observer);
  });
}


interface AdoptiumAsset {
  url: string;
  filename: string;
  /** "zip" or "tar.gz" — drives the extraction command. */
  archive: "zip" | "tar.gz";
  /** SHA-256 of the archive, when the assets API was reachable. */
  sha256?: string;
}

/** Adoptium os/arch/archive triple for the current machine. */
/**
 * 当前平台的 Adoptium 取件描述符。导出仅供测试（javaRuntimeManager.test.ts
 * 在假宿主上覆盖 win/mac/linux × x64/aarch64 的判定分支）。
 */
export function platformDescriptor(): {
  os: string;
  arch: string;
  archive: "zip" | "tar.gz";
} {
  if (isWindows()) return { os: "windows", arch: "x64", archive: "zip" };
  if (isMac()) {
    return { os: "mac", arch: isMacArm64() ? "aarch64" : "x64", archive: "tar.gz" };
  }
  // Linux：Adoptium 同样发布 aarch64 的 JRE，按机器实际架构取件。
  return { os: "linux", arch: isArm64() ? "aarch64" : "x64", archive: "tar.gz" };
}

/**
 * Build the Adoptium binary download URL for the current platform/arch.
 * The API responds 307 → the actual GitHub release asset. No checksum is
 * known on this path — it is the fallback when the assets API is unreachable.
 */
function resolveAdoptiumAsset(featureVersion: number): AdoptiumAsset {
  const { os, arch, archive } = platformDescriptor();
  const url = `https://api.adoptium.net/v3/binary/latest/${featureVersion}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
  // Filename is best-effort (only used for logging); the server sets it.
  const filename = `temurin-${featureVersion}-jre-${os}-${arch}.${archive}`;
  return { url, filename, archive };
}

/**
 * Ask the Adoptium assets API for the latest GA JRE. Unlike the binary
 * endpoint this returns metadata — most importantly the archive's SHA-256,
 * the anchor for detecting and reusing a previously completed download.
 * Endpoint shape (verified): GET /v3/assets/latest/{feature}/hotspot
 * ?os=&architecture=&image_type=jre&vendor=eclipse → [{binary.package:
 * {name, link, size, checksum}}]. Returns null on any failure.
 */
async function queryAdoptiumLatestAsset(
  featureVersion: number,
): Promise<AdoptiumAsset | null> {
  const { os, arch, archive } = platformDescriptor();
  const url = `https://api.adoptium.net/v3/assets/latest/${featureVersion}/hotspot?os=${os}&architecture=${arch}&image_type=jre&vendor=eclipse`;
  try {
    const resp = await (Zotero as any).HTTP.request("GET", url, {
      responseType: "json",
      timeout: 30000,
    });
    const pkg = Array.isArray(resp?.response)
      ? resp.response[0]?.binary?.package
      : null;
    if (resp.status === 200 && pkg?.link && pkg?.checksum) {
      return {
        url: pkg.link,
        filename: pkg.name || `temurin-${featureVersion}-jre-${os}-${arch}.${archive}`,
        archive,
        sha256: String(pkg.checksum).toLowerCase(),
      };
    }
    safeDebug(
      `[Z-Transplit] JavaRuntimeManager: assets API unexpected response status=${resp.status}`,
    );
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: assets API failed: " + e);
  }
  return null;
}


// ─── 下载来源：国内镜像 + 官方兜底 ────────────────────────────────

interface JreSource {
  id: string;
  url: string;
}

/**
 * 国内镜像基础地址。收录标准（2026-10 实测，全部逐字节核对过官方校验和）：
 *
 *   - 南京大学：Windows x64 zip 与 macOS x64 tar.gz 均与官方 SHA-256 一致，
 *     实测 1MB 区间请求 0.30s，快于清华；Apple Silicon 的 aarch64/mac 目录
 *     为空，该平台探测自然落选，不影响使用。
 *   - 清华：Windows x64 zip 与 macOS x64/aarch64 tar.gz 均一致（0.53s）。
 *
 * 路径规则两者相同（{base}/{feature}/jre/{arch}/{os}/{packageName}）。
 *
 * 已排查且不收录：中科大镜像的 Adoptium 停在 17.0.9（当前版本 404，陈旧）；
 * 华为云 /adoptium/ 返回门户页而非文件；腾讯云、阿里云没有 Adoptium 镜像。
 * 收录前必须实测——镜像被污染或路径不存在时，探测阶段就会淘汰它。
 */
const JRE_MIRRORS = [
  { id: "nju-adoptium", base: "https://mirrors.nju.edu.cn/adoptium" },
  { id: "tuna-adoptium", base: "https://mirrors.tuna.tsinghua.edu.cn/Adoptium" },
];

const PROBE_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 600000; // 10 min for ~40-50MB

/**
 * 候选来源：镜像在前（境内友好），Adoptium 官方二进制地址殿后（全球兜底）。
 *
 * 镜像路径由官方 API 返回的包名推导——{base}/{feature}/jre/{arch}/{os}/
 * {packageName}——因此不需要随版本号硬编码，上游发新补丁后镜像同步即用。
 * 只有在官方 API 给出了 SHA-256 时才允许走镜像：没有信任锚的镜像字节无法
 * 验真，宁可只走官方重定向地址。顺序只决定耗时打平时的优先级，实际顺序
 * 由探测延迟决定。
 */
function buildJreSources(
  featureVersion: number,
  asset: AdoptiumAsset,
): JreSource[] {
  const sources: JreSource[] = [];
  if (asset.sha256 && asset.filename) {
    const { os, arch } = platformDescriptor();
    for (const mirror of JRE_MIRRORS) {
      sources.push({
        id: mirror.id,
        url: `${mirror.base}/${featureVersion}/jre/${arch}/${os}/${asset.filename}`,
      });
    }
  }
  sources.push({ id: "adoptium", url: asset.url });
  return sources;
}

/** 1KB 区间请求探测：返回耗时毫秒，不可达返回 Infinity。 */
async function probeJreSource(source: JreSource): Promise<number> {
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
      `[Z-Transplit] JavaRuntimeManager: probe unexpected status ${resp?.status} (${source.id})`,
    );
  } catch (e) {
    safeDebug(
      `[Z-Transplit] JavaRuntimeManager: probe failed (${source.id}): ${e}`,
    );
  }
  return Number.POSITIVE_INFINITY;
}

/** 探测结果 → 可达来源按耗时升序（不可达者丢弃）。 */
function rankJreSources(
  probed: Array<{ source: JreSource; ms: number }>,
): JreSource[] {
  return probed
    .slice()
    .sort((a, b) => a.ms - b.ms)
    .filter((p) => Number.isFinite(p.ms))
    .map((p) => p.source);
}

/** 整包下载一个来源的安装包。 */
async function downloadJreArchive(
  source: JreSource,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  const resp = await (Zotero as any).HTTP.request("GET", source.url, {
    responseType: "arraybuffer",
    timeout: DOWNLOAD_TIMEOUT_MS,
    requestObserver: (xhr: XMLHttpRequest) => {
      xhr.addEventListener("progress", (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress?.({
            percent,
            phase: "downloading",
            message: getString("java-progress-downloading", { percent }),
          });
        }
      });
    },
  } as any);
  if (resp.status !== 200 || !resp.response) {
    throw new Error(`HTTP ${resp.status} from ${source.id}`);
  }
  return new Uint8Array(resp.response);
}


/**
 * Extract a downloaded JRE archive into the managed runtime dir.
 * Windows zip → tar.exe (Win10 1803+), fallback PowerShell Expand-Archive.
 * Unix tar.gz → /usr/bin/tar -xzf.
 */
async function extractArchive(
  archivePath: string,
  destDir: string,
  archive: "zip" | "tar.gz",
): Promise<void> {
  const isWin = isWindows();

  // Ensure dest exists. IOUtils' MakeDirectoryOptions only knows
  // `createAncestors`; `recursive`/`createParents` are OS.File-era names that
  // the WebIDL dictionary conversion silently drops, so ancestors were never
  // actually created.
  await (globalThis as any).IOUtils.makeDirectory(destDir, {
    createAncestors: true,
  });

  if (isWin) {
    // tar handles .zip on Windows 10 1803+.
    const tarResult = await execCommand(
      "C:\\Windows\\System32\\tar.exe",
      ["-xf", archivePath, "-C", destDir],
      { timeout: 300000 },
    );
    if (tarResult.exitCode === 0) return;

    // Fallback: PowerShell Expand-Archive.
    const psResult = await execCommand(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ],
      { timeout: 300000 },
    );
    if (psResult.exitCode !== 0) {
      throw new Error(
        getString("java-error-extract-failed", {
          detail: psResult.stderr || tarResult.stderr || "unknown error",
        }),
      );
    }
    return;
  }

  // Unix: tar -xzf works for .tar.gz (and -xf auto-detects on modern tar).
  const flag = archive === "tar.gz" ? "-xzf" : "-xf";
  const result = await execCommand("/usr/bin/tar", [flag, archivePath, "-C", destDir], {
    timeout: 300000,
  });
  if (result.exitCode !== 0) {
    throw new Error(getString("java-error-extract-failed", {
      detail: result.stderr || "unknown error",
    }));
  }
}


/**
 * Sibling staging dir: archives are extracted and probed here first, then
 * atomically moved into the runtime dir — a kill mid-extract can never leave
 * a half-written runtime that later gets cached as valid.
 */
function getStagingDir(): string {
  return pathJoin(getDataDir(), "ztransplit", "java-runtime.staging");
}

/**
 * Persistent download cache next to the runtime dir. The archive is KEPT
 * across failed installs; a retry whose checksum still matches skips the
 * ~45MB download entirely. Removed only on verified success or mismatch.
 */
function getArchivePath(archive: "zip" | "tar.gz"): string {
  return pathJoin(getDataDir(), "ztransplit", `java-runtime.download.${archive}`);
}

interface ArchiveMeta {
  sha256: string;
  bytes: number;
}

function getArchiveMetaPath(): string {
  return pathJoin(getDataDir(), "ztransplit", "java-runtime.download.json");
}

async function readArchiveMeta(): Promise<ArchiveMeta | null> {
  try {
    const raw = await (globalThis as any).IOUtils.readUTF8(getArchiveMetaPath());
    const meta = JSON.parse(raw);
    if (typeof meta?.sha256 === "string" && typeof meta?.bytes === "number") {
      return meta;
    }
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
  }
  return null;
}

async function writeArchiveMeta(meta: ArchiveMeta): Promise<void> {
  try {
    await (globalThis as any).IOUtils.writeUTF8(
      getArchiveMetaPath(),
      JSON.stringify(meta, null, 2) + "\n",
    );
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
  }
}

async function removeCachedArchive(): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  for (const p of [
    getArchivePath("zip"),
    getArchivePath("tar.gz"),
    getArchiveMetaPath(),
  ]) {
    try {
      await IOUtils.remove(p, { ignoreAbsent: true });
    } catch (e) {
      safeDebug("[Z-Transplit] JavaRuntimeManager: archive cleanup failed: " + e);
    }
  }
}

/** Concurrent downloadJRE() calls share one in-flight install. */
let installInFlight: Promise<string> | null = null;

/**
 * Download (or reuse) and install a portable Temurin JRE. Returns the
 * absolute path to the extracted `java` executable.
 *
 * Interruption-safe by design:
 *  - The archive survives a failed install; a retry whose SHA-256 still
 *    matches (recorded locally at download time, compared against the latest
 *    release when the assets API is reachable) skips the download entirely.
 *  - Extraction goes to a staging dir that must pass `java -version` before
 *    being atomically moved into place, so a truncated runtime is never
 *    served.
 *  - A cached managed JRE that fails its probe is discarded and reinstalled
 *    (self-heal).
 */
export async function downloadJRE(
  featureVersion: number = 17,
  onProgress?: ProgressCallback,
): Promise<string> {
  if (installInFlight) return installInFlight;
  installInFlight = installJRE(featureVersion, onProgress).finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

async function installJRE(
  featureVersion: number,
  onProgress?: ProgressCallback,
): Promise<string> {
  const IOUtils = (globalThis as any).IOUtils;

  // IOUtils.write does not create parent directories — make sure the plugin's
  // data subdir exists before we cache the archive and metadata in it.
  try {
    await IOUtils.makeDirectory(pathJoin(getDataDir(), "ztransplit"), {
      createAncestors: true,
    });
  } catch (e) {
    safeDebug("[Z-Transplit] JavaRuntimeManager: " + e);
  }

  // Fast path with self-heal. findJavaInDir only checks file existence, so a
  // truncated extraction would otherwise be served forever with cryptic JVM
  // crashes — an existing managed JRE counts only when it actually runs.
  const existing = await getManagedJavaExe();
  if (existing) {
    const existingProbe = await execCommand(existing, ["-version"], {
      timeout: 15000,
    });
    if (existingProbe.exitCode === 0) {
      onProgress?.({
        percent: 100,
        phase: "done",
        message: getString("java-progress-already-installed"),
      });
      return existing;
    }
    safeDebug(
      `[Z-Transplit] JavaRuntimeManager: managed JRE broken (exit=${existingProbe.exitCode}), reinstalling: ${(existingProbe.stderr || "").slice(0, 200)}`,
    );
    onProgress?.({
      percent: 0,
      phase: "querying",
      message: getString("java-progress-self-heal"),
    });
    await discardManagedRuntime();
  }

  // Assets API first (provides the checksum anchor); the redirect-only
  // binary URL is the fallback when metadata is unreachable.
  const asset =
    (await queryAdoptiumLatestAsset(featureVersion)) ||
    resolveAdoptiumAsset(featureVersion);
  const runtimeDir = getJavaRuntimeDir();
  const stagingDir = getStagingDir();
  const archivePath = getArchivePath(asset.archive);

  // Reuse a previously downloaded archive when it still hashes to what was
  // recorded after the original download AND — when known — to the latest
  // release upstream. Covers "download OK, extract killed" retries and
  // offline retries, while still refreshing on new upstream patch releases.
  let archiveVerified = false;
  const meta = await readArchiveMeta();
  if (meta && (await pathExists(archivePath))) {
    let fileHash: string | null = null;
    try {
      fileHash = await sha256Hex(await IOUtils.read(archivePath));
    } catch (e) {
      safeDebug("[Z-Transplit] JavaRuntimeManager: archive read failed: " + e);
    }
    if (
      fileHash &&
      fileHash === meta.sha256 &&
      (!asset.sha256 || asset.sha256 === fileHash)
    ) {
      archiveVerified = true;
      onProgress?.({
        percent: 100,
        phase: "downloading",
        message: getString("java-progress-reuse-archive"),
      });
    } else {
      await removeCachedArchive();
    }
  }

  if (!archiveVerified) {
    onProgress?.({
      percent: 0,
      phase: "downloading",
      message: getString("java-progress-download-start", {
        version: featureVersion,
        archive: asset.archive,
      }),
    });

    // 镜像在前、官方地址殿后；实际顺序由并发探测延迟决定（与
    // OdlJarDownloader 同策略）。没有官方校验和时只剩官方地址——无法验真
    // 的镜像字节宁可不要。
    const sources = buildJreSources(featureVersion, asset);
    onProgress?.({
      percent: 0,
      phase: "downloading",
      message: getString("java-progress-probe"),
    });
    const ranked = rankJreSources(
      await Promise.all(
        sources.map(async (source) => ({
          source,
          ms: await probeJreSource(source),
        })),
      ),
    );
    if (ranked.length === 0) {
      throw new Error(
        getString("java-error-download-failed", {
          detail: `no reachable source (${sources.map((s) => s.id).join(", ")})`,
        }),
      );
    }

    const failures: Array<{ id: string; checksum: boolean; message: string }> =
      [];
    let downloaded: { bytes: Uint8Array; hash: string } | null = null;
    for (const source of ranked) {
      try {
        onProgress?.({
          percent: 0,
          phase: "downloading",
          message: `${getString("java-progress-downloading", { percent: 0 })} [${source.id}]`,
        });
        const bytes = await downloadJreArchive(source, onProgress);
        if (asset.sha256) {
          // 镜像同样要过官方校验和这一关：对不上即换源，绝不进入解压。
          const hash = await sha256Hex(bytes);
          if (!hash || hash !== asset.sha256) {
            failures.push({
              id: source.id,
              checksum: true,
              message: "checksum mismatch",
            });
            safeDebug(
              `[Z-Transplit] JavaRuntimeManager: ${source.id} checksum mismatch, trying next source`,
            );
            continue;
          }
          downloaded = { bytes, hash };
        } else {
          downloaded = { bytes, hash: "" };
        }
        break;
      } catch (e: any) {
        failures.push({
          id: source.id,
          checksum: false,
          message: e?.message || String(e),
        });
        safeDebug(
          `[Z-Transplit] JavaRuntimeManager: source ${source.id} failed: ${e}`,
        );
      }
    }
    if (!downloaded) {
      // 全部来源都栽在校验和上时给出精确报错（镜像或官方任一被污染都会走到
      // 这）；其余情况汇总各来源的失败原因。
      if (failures.length > 0 && failures.every((f) => f.checksum)) {
        throw new Error(getString("java-error-checksum-mismatch"));
      }
      throw new Error(
        getString("java-error-download-failed", {
          detail: failures.map((f) => `${f.id}: ${f.message}`).join("; "),
        }),
      );
    }

    await IOUtils.write(archivePath, downloaded.bytes);
    if (asset.sha256) {
      await writeArchiveMeta({
        sha256: downloaded.hash,
        bytes: downloaded.bytes.byteLength,
      });
      // The archive now on disk is checksum-verified — keep it across a
      // failed extraction so the retry skips the download.
      archiveVerified = true;
    }
    // No reference checksum (assets API unreachable): one-shot semantics —
    // extract now, never reuse across attempts, so an undetected partial
    // write is not re-extracted forever.
  }

  // Staged extract → probe → atomic swap into the runtime dir.
  onProgress?.({
    percent: 100,
    phase: "extracting",
    message: getString("java-progress-extracting"),
  });
  try {
    try {
      await IOUtils.remove(stagingDir, { recursive: true, ignoreAbsent: true });
    } catch (e) {
      safeDebug("[Z-Transplit] JavaRuntimeManager: staging cleanup failed: " + e);
    }
    await extractArchive(archivePath, stagingDir, asset.archive);

    const stagedJava = await findJavaInDir(stagingDir);
    if (!stagedJava) {
      throw new Error(getString("java-error-exe-not-found", { dir: stagingDir }));
    }
    const stagedProbe = await execCommand(stagedJava, ["-version"], {
      timeout: 30000,
    });
    if (stagedProbe.exitCode !== 0) {
      throw new Error(
        getString("java-error-probe-failed", {
          detail: stagedProbe.stderr || "java -version failed",
        }),
      );
    }

    // Verified — swap in. discardManagedRuntime() clears the cache and any
    // remains of a previous runtime dir (IOUtils.move onto an existing
    // directory fails).
    await discardManagedRuntime();
    await IOUtils.move(stagingDir, runtimeDir);
  } catch (e) {
    try {
      await IOUtils.remove(stagingDir, { recursive: true, ignoreAbsent: true });
    } catch (e2) {
      safeDebug("[Z-Transplit] JavaRuntimeManager: staging cleanup failed: " + e2);
    }
    // Keep a checksum-verified archive for the retry; drop an unverifiable one.
    if (!archiveVerified) await removeCachedArchive();
    throw e;
  }

  // Final verification from the installed location.
  onProgress?.({
    percent: 100,
    phase: "verifying",
    message: getString("java-progress-verifying"),
  });
  const javaExe = await getManagedJavaExe();
  if (!javaExe) {
    throw new Error(getString("java-error-exe-not-found", { dir: runtimeDir }));
  }
  const probe = await execCommand(javaExe, ["-version"], { timeout: 30000 });
  if (probe.exitCode !== 0) {
    await discardManagedRuntime();
    await removeCachedArchive();
    throw new Error(
      getString("java-error-probe-failed", {
        detail: probe.stderr || "java -version failed",
      }),
    );
  }

  // Success — the cached archive has served its purpose.
  await removeCachedArchive();
  onProgress?.({
    percent: 100,
    phase: "done",
    message: getString("java-progress-done"),
  });
  return javaExe;
}

/**
 * 系统 java 定位委托给 javaLocator（JAVA_HOME → 各平台真实安装位置 → PATH）。
 * 这里不再自带一份 PATH 搜索——两份实现曾经各自漂移，"设了 JAVA_HOME 却
 * 找不到 java"这类漏判正源于此。返回的候选仍需调用方探测（见
 * getJavaStatus）：macOS 的 /usr/bin/java 存根"存在且可执行"，但没装 JDK
 * 时跑不起来。
 */
function findSystemJava(): string | null {
  return resolveJavaExecutable();
}


/**
 * Resolve a usable java, preferring the managed JRE. Returns a status object
 * suitable for UI display.
 */
export async function getJavaStatus(): Promise<JavaStatus> {
  const managed = await getManagedJavaExe();
  if (managed) {
    const probe = await execCommand(managed, ["-version"], { timeout: 15000 });
    if (probe.exitCode === 0) {
      const vMatch = probe.stderr.match(/version "([^"]+)"/);
      return {
        ready: true,
        version: vMatch ? vMatch[1] : undefined,
        path: managed,
        managed: true,
      };
    }
    // Broken managed JRE (e.g. truncated extraction): drop it before falling
    // back so the sync resolver in OpenDataLoaderPdfClient stops serving the
    // dead path and a later downloadJRE() starts clean.
    await discardManagedRuntime();
  }
  // System PATH fallback (avoids circular import of OpenDataLoaderPdfClient).
  const systemJava = findSystemJava();
  if (systemJava) {
    const probe = await execCommand(systemJava, ["-version"], { timeout: 10000 });
    if (probe.exitCode === 0) {
      const vMatch =
        probe.stderr.match(/version "([^"]+)"/) ||
        probe.stderr.match(/Java\(TM\) SE Runtime Environment.*"([^"]+)"/);
      return {
        ready: true,
        version: vMatch ? vMatch[1] : undefined,
        path: systemJava,
        managed: false,
      };
    }
  }

  return { ready: false, error: getString("err-java-not-found") };
}

const JavaRuntimeManager = {
  getJavaRuntimeDir,
  getManagedJavaExe,
  discardManagedRuntime,
  downloadJRE,
  getJavaStatus,
};
export default JavaRuntimeManager;
