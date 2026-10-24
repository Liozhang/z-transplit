/**
 * JRE 托管安装的中断安全测试（src/core/pdf/JavaRuntimeManager.ts）。
 *
 * 该模块与 Zotero 宿主深度耦合（Zotero.HTTP / IOUtils / nsIProcess），历史上
 * 被标注为「Node 下不可单测」。本套件只伪造宿主边界——内存文件系统、假
 * IOUtils、假 nsIProcess（按 bat/sh 命令行派发）、假 HTTP 路由——被测的是
 * 真实源码。覆盖契约：
 *
 *   1. 全新安装：下载 → 校验 → 暂存解压 → 探测 → 原子改名 → 清理安装包。
 *   2. 解压中断后重试：校验通过的安装包被保留，重试不再下载（中断继续）。
 *   3. 下载内容与官方 SHA-256 不符：报错并丢弃，不进入解压。
 *   4. 上游发布新补丁：旧安装包哈希不再匹配，作废并重新下载。
 *   5. 元数据接口不可达（断网）但本地包完好：复用本地包完成安装。
 *   6. 自愈：已存在的托管 JRE 探测失败时删除重装。
 *   7. getJavaStatus：坏 JRE 被清掉后才回退系统 Java。
 *   8. macOS 布局：Contents/Home/bin/java 也能被找到并完成安装。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  downloadJRE,
  getJavaStatus,
  getManagedJavaExe,
} from "../../../../src/core/pdf/JavaRuntimeManager";

// ─── 内存文件系统（IOUtils 语义子集）─────────────────────────────

class FakeFS {
  files = new Map<string, Uint8Array | string>();
  dirs = new Set<string>();

  /** write/writeUTF8 自动补全祖先目录，等价于真实磁盘语义。 */
  private registerAncestors(p: string): void {
    let idx = p.length;
    while ((idx = p.lastIndexOf("\\", idx - 1)) > 0) {
      this.dirs.add(p.slice(0, idx));
    }
  }

  exists(p: string): boolean {
    return this.files.has(p) || this.dirs.has(p);
  }

  read(p: string): Uint8Array {
    const v = this.files.get(p);
    if (v === undefined) throw new Error("NoSuchFile: " + p);
    return typeof v === "string" ? new TextEncoder().encode(v) : v;
  }

  readUTF8(p: string): string {
    const v = this.files.get(p);
    if (v === undefined) throw new Error("NoSuchFile: " + p);
    return typeof v === "string" ? v : new TextDecoder().decode(v);
  }

  write(p: string, data: Uint8Array): void {
    this.files.set(p, data);
    this.registerAncestors(p);
  }

  writeUTF8(p: string, text: string): void {
    this.files.set(p, text);
    this.registerAncestors(p);
  }

  getChildren(dir: string): string[] {
    const names = new Set<string>();
    const prefix = dir.endsWith("\\") ? dir : dir + "\\";
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest) continue;
      const first = rest.split("\\")[0];
      names.add(prefix + first);
    }
    return [...names];
  }

  remove(p: string, opts: { recursive?: boolean; ignoreAbsent?: boolean } = {}): void {
    if (this.files.has(p)) {
      this.files.delete(p);
      return;
    }
    if (this.dirs.has(p)) {
      const prefix = p + "\\";
      const kids = [...this.files.keys(), ...this.dirs].some((q) => q.startsWith(prefix));
      if (kids && !opts.recursive) throw new Error("NotEmpty: " + p);
      for (const q of [...this.files.keys()]) if (q.startsWith(prefix)) this.files.delete(q);
      for (const q of [...this.dirs]) if (q.startsWith(prefix)) this.dirs.delete(q);
      this.dirs.delete(p);
      return;
    }
    if (!opts.ignoreAbsent) throw new Error("NoSuchFile: " + p);
  }

  makeDirectory(p: string, opts: { createAncestors?: boolean } = {}): void {
    if (this.dirs.has(p)) return;
    if (this.files.has(p)) throw new Error("FileExists: " + p);
    this.dirs.add(p);
    if (opts.createAncestors) this.registerAncestors(p);
  }

  move(src: string, dest: string): void {
    if (!this.exists(src)) throw new Error("NoSuchFile: " + src);
    if (this.exists(dest)) throw new Error("DestinationExists: " + dest);
    if (this.files.has(src)) {
      this.files.set(dest, this.files.get(src)!);
      this.files.delete(src);
      this.registerAncestors(dest);
      return;
    }
    // 目录：改写全部前缀
    const prefix = src + "\\";
    for (const p of [...this.files.keys()]) {
      if (p.startsWith(prefix)) {
        this.files.set(dest + p.slice(src.length), this.files.get(p)!);
        this.files.delete(p);
      }
    }
    for (const p of [...this.dirs]) {
      if (p === src || p.startsWith(prefix)) {
        this.dirs.add(dest + p.slice(src.length));
        this.dirs.delete(p);
      }
    }
    this.registerAncestors(dest);
  }
}

// ─── 宿主桩：进程派发 / HTTP 路由 / nsIXPCOM ─────────────────────

const SEP = "\\";
const DATA_DIR = "D:\\ZoteroData";
const ZTSPLIT = DATA_DIR + SEP + "ztransplit";
const RUNTIME_DIR = ZTSPLIT + SEP + "java-runtime";
const STAGING_DIR = ZTSPLIT + SEP + "java-runtime.staging";
const ARCHIVE_ZIP = ZTSPLIT + SEP + "java-runtime.download.zip";
const META_JSON = ZTSPLIT + SEP + "java-runtime.download.json";

/** 与 JavaRuntimeManager 的 JRE_MIRRORS 一致：南京大学在前（实测最快）。 */
const MIRROR_BASES = [
  "https://mirrors.nju.edu.cn/adoptium",
  "https://mirrors.tuna.tsinghua.edu.cn/Adoptium",
];
const MIRROR_BASE = MIRROR_BASES[0];
const RELEASE_1 = {
  link: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip",
  name: "OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip",
};
const RELEASE_2 = {
  link: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B7/OpenJDK17U-jre_x64_windows_hotspot_17.0.21_7.zip",
  name: "OpenJDK17U-jre_x64_windows_hotspot_17.0.21_7.zip",
};
const ARCHIVE_1_BYTES = new Uint8Array([0x50, 0x4b, 1, 2, 3, 4, 5, 6, 7, 8]);
const ARCHIVE_2_BYTES = new Uint8Array([0x50, 0x4b, 9, 8, 7, 6, 5, 4, 3, 2]);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface HostState {
  fs: FakeFS;
  /** 平台模式：驱动 isWindows/isMac 与假解压产物布局。 */
  mode: "win" | "mac";
  /** 元数据接口是否不可达（断网场景）。 */
  assetsUnreachable: boolean;
  /** 国内镜像状态：不可达时探测返回 502；bytes 是镜像实际服务的字节。 */
  mirror: { reachable: boolean; bytes: Uint8Array };
  /** 按 URL 子串注入的响应延迟（毫秒），用于模拟「谁快谁胜出」的排序。 */
  latencyMs: Record<string, number>;
  /** URL 含其中任一子串时直接连接失败（模拟某个源整体不可达）。 */
  down: string[];
  /** 官方二进制地址是否连接失败（模拟 GitHub 完全不可达）。 */
  officialDown: boolean;
  /** 整包下载（responseType=arraybuffer）的 URL——探测是 text，不计入。 */
  downloads: string[];
  /** 当前「上游最新版本」的下载地址与官方校验和。 */
  remote: { link: string; name: string; checksum: string };
  /** java -version 退出码队列（每次探测消耗一个，空则取 0）。 */
  versionExits: number[];
  /** 解压退出码队列（每次解压消耗一个，空则取 0）。 */
  tarExits: number[];
  /** 派发过的完整命令行（bat 内容 / sh -c 字符串）。 */
  dispatched: string[];
  /** HTTP 请求过的 URL。 */
  httpCalls: string[];
}

let host: HostState;

function takeNext(queue: number[]): number {
  return queue.length > 0 ? (queue.shift() as number) : 0;
}

/** 把「解压」落实为内存文件系统上的目录结构（win 与 macOS 两种布局）。 */
function fakeExtract(dest: string): void {
  const root = dest + SEP + "jdk-17.0.20.1+1-jre";
  if (host.mode === "mac") {
    host.fs.makeDirectory(root + "\\Contents\\Home\\bin", { createAncestors: true });
    host.fs.write(root + "\\Contents\\Home\\bin\\java", new Uint8Array([1]));
  } else {
    host.fs.makeDirectory(root + "\\bin", { createAncestors: true });
    host.fs.write(root + "\\bin\\java.exe", new Uint8Array([1]));
  }
  host.fs.writeUTF8(root + "\\release", "JAVA_VERSION=17.0.20.1");
}

function winJavaPath(): string {
  return RUNTIME_DIR + SEP + "jdk-17.0.20.1+1-jre" + SEP + "bin" + SEP + "java.exe";
}

/** 按命令行内容派发假进程行为：java -version / tar·Expand-Archive / taskkill。 */
function dispatchCommand(cmdline: string): { exit: number; stderr: string } {
  const redirectWin = /> "([^"]+)" 2> "([^"]+)"/.exec(cmdline);
  const redirectUnix = /> '([^']+)' 2> '([^']+)'/.exec(cmdline);
  const redirect = redirectWin || redirectUnix;
  const writeBack = (stdout: string, stderr: string) => {
    if (redirect) {
      host.fs.writeUTF8(redirect[1], stdout);
      host.fs.writeUTF8(redirect[2], stderr);
    }
  };

  const isVersion = cmdline.includes("-version");
  const isExtract =
    /-x[zf]/.test(cmdline) || cmdline.includes("Expand-Archive");
  const isTaskkill = cmdline.includes("taskkill");

  if (isVersion) {
    const exit = takeNext(host.versionExits);
    const stderr =
      exit === 0
        ? 'openjdk version "17.0.20.1" 2025-10-21'
        : "Error occurred during initialization of VM";
    writeBack("", stderr);
    return { exit, stderr };
  }
  if (isExtract) {
    const exit = takeNext(host.tarExits);
    // execCommand 对每个参数独立加引号：win 批处理是 "-C" "dest"，
    // unix sh 是 '-C' 'dest'，PowerShell 兜底是 -DestinationPath 'dest'。
    const dest =
      /-C" "([^"]+)"/.exec(cmdline)?.[1] ??
      /-C' '([^']+)'/.exec(cmdline)?.[1] ??
      /-DestinationPath '([^']+)'/.exec(cmdline)?.[1];
    if (exit === 0 && dest) fakeExtract(dest);
    const stderr = exit === 0 ? "" : "tar: Unexpected EOF in archive";
    writeBack("", stderr);
    return { exit, stderr };
  }
  if (isTaskkill) {
    writeBack("", "");
    return { exit: 0, stderr: "" };
  }
  writeBack("", "unrecognized command: " + cmdline.slice(0, 80));
  return { exit: 127, stderr: "unrecognized command" };
}

function makeFakeFile() {
  return {
    path: "",
    initWithPath(this: any, p: string) {
      this.path = p;
    },
    exists(this: any) {
      return host.fs.exists(this.path);
    },
    isExecutable(this: any) {
      return host.fs.exists(this.path) && /\.exe$/i.test(this.path);
    },
  };
}

function makeFakeProcess() {
  return {
    _file: null as any,
    pid: 4242,
    isRunning: false,
    exitValue: 0,
    init(this: any, f: any) {
      this._file = f;
    },
    kill() {},
    runwAsync(this: any, args: unknown[], _len: number, obs: any) {
      const isBat = String(this._file?.path ?? "").toLowerCase().endsWith(".bat");
      const cmdline = isBat
        ? host.fs.readUTF8(this._file.path)
        : String(args[1] ?? "");
      host.dispatched.push(cmdline);
      const { exit } = dispatchCommand(cmdline);
      this.exitValue = exit;
      setTimeout(() => obs.observe(null, "process-finished"), 0);
    },
  };
}

function buildGlobals(): void {
  const h = host;

  const ZoteroStub: any = {
    isWin: h.mode === "win",
    isMac: h.mode === "mac",
    platform: h.mode === "win" ? "win32" : "macosx",
    DataDirectory: { dir: DATA_DIR },
    getTempDirectory: () => ({
      path: DATA_DIR + "\\tmp",
      clone() {
        return { path: DATA_DIR + "\\tmp", clone: this.clone, append: this.append };
      },
      append(this: any, n: string) {
        this.path += "\\" + n;
      },
    }),
    HTTP: {
      async request(_method: string, url: string, options?: { responseType?: string }) {
        h.httpCalls.push(url);
        const latency = Object.entries(h.latencyMs).reduce(
          (acc, [needle, ms]) => (url.includes(needle) ? Math.max(acc, ms) : acc),
          0,
        );
        if (latency > 0) await new Promise((r) => setTimeout(r, latency));
        if (h.down.some((needle) => url.includes(needle))) {
          throw new Error("NetworkError: cannot connect");
        }
        if (options?.responseType === "arraybuffer") h.downloads.push(url);
        if (url.includes("/v3/assets/latest/")) {
          if (h.assetsUnreachable) throw new Error("NetworkError: offline");
          return {
            status: 200,
            response: [
              {
                binary: {
                  package: {
                    link: h.remote.link,
                    name: h.remote.name,
                    checksum: h.remote.checksum,
                    size: 43780109,
                  },
                },
              },
            ],
          };
        }
        // 国内镜像（多个）：路径由官方 API 返回的包名推导，与 buildJreSources
        // 一致；任一基址命中都走同一套可达性/字节控制。
        if (MIRROR_BASES.some((base) => url.startsWith(base))) {
          if (!h.mirror.reachable) return { status: 502, response: null };
          return {
            status: 200,
            response: Uint8Array.from(h.mirror.bytes).buffer,
          };
        }
        if (url === RELEASE_1.link || url === RELEASE_2.link) {
          if (h.officialDown) throw new Error("NetworkError: cannot connect");
          const bytes = url === RELEASE_1.link ? ARCHIVE_1_BYTES : ARCHIVE_2_BYTES;
          return { status: 200, response: Uint8Array.from(bytes).buffer };
        }
        if (url.includes("/v3/binary/latest/")) {
          if (h.officialDown) throw new Error("NetworkError: cannot connect");
          return { status: 200, response: Uint8Array.from(ARCHIVE_1_BYTES).buffer };
        }
        return { status: 404, response: null };
      },
    },
  };

  const ids: Record<string, { name: string; equals(o: unknown): boolean }> = {};
  for (const name of [
    "nsIObserver",
    "nsISupports",
    "nsIFile",
    "nsIProcess",
    "nsIEnvironment",
    "nsITimer",
    "nsIXULRuntime",
    "nsIPropertyBag2",
  ]) {
    ids[name] = { name, equals: (o) => o === ids[name] };
  }

  const ComponentsStub: any = {
    classes: {
      "@mozilla.org/file/local;1": { createInstance: () => makeFakeFile() },
      "@mozilla.org/process/util;1": { createInstance: () => makeFakeProcess() },
      "@mozilla.org/process/environment;1": {
        getService: () => ({ get: () => "" }),
      },
      "@mozilla.org/timer;1": {
        createInstance: () => ({ initWithCallback: () => {}, cancel: () => {} }),
      },
      "@mozilla.org/xre/app-info;1": {
        getService: () => ({ OS: h.mode === "win" ? "WINNT" : "Darwin" }),
      },
      "@mozilla.org/system-info;1": {
        getService: () => ({ get: (k: string) => (k === "arch" ? "x86-64" : "") }),
      },
    },
    interfaces: ids,
    results: { NS_NOINTERFACE: {} },
  };

  // 真实 IOUtils 的每个方法都返回 Promise；被测代码会对返回值链 .catch()，
  // 桩必须保持异步，否则观察者回调同步抛错导致进程 Promise 永不落定。
  const IOUtilsStub: any = {
    exists: async (p: string) => h.fs.exists(p),
    read: async (p: string) => h.fs.read(p),
    readUTF8: async (p: string) => h.fs.readUTF8(p),
    write: async (p: string, d: Uint8Array) => h.fs.write(p, d),
    writeUTF8: async (p: string, s: string) => h.fs.writeUTF8(p, s),
    getChildren: async (d: string) => h.fs.getChildren(d),
    remove: async (p: string, o?: any) => h.fs.remove(p, o),
    makeDirectory: async (p: string, o?: any) => h.fs.makeDirectory(p, o),
    move: async (s: string, d: string) => h.fs.move(s, d),
  };

  (globalThis as any).Zotero = ZoteroStub;
  (globalThis as any).Components = ComponentsStub;
  (globalThis as any).Services = {
    appinfo: { OS: h.mode === "win" ? "WINNT" : "Darwin" },
  };
  (globalThis as any).IOUtils = IOUtilsStub;
  (globalThis as any).PathUtils = { join: (...p: string[]) => p.join(SEP) };
}

// ─── 场景测试 ────────────────────────────────────────────────────

describe("JavaRuntimeManager：JRE 托管安装的中断安全", () => {
  let saved: Record<string, unknown> = {};

  beforeEach(() => {
    host = {
      fs: new FakeFS(),
      mode: "win",
      assetsUnreachable: false,
      mirror: { reachable: false, bytes: ARCHIVE_1_BYTES },
      latencyMs: {},
      down: [],
      officialDown: false,
      downloads: [],
      remote: { link: RELEASE_1.link, name: RELEASE_1.name, checksum: sha256(ARCHIVE_1_BYTES) },
      versionExits: [],
      tarExits: [],
      dispatched: [],
      httpCalls: [],
    };
    for (const k of ["Zotero", "Components", "Services", "IOUtils", "PathUtils"]) {
      saved[k] = (globalThis as any)[k];
    }
    buildGlobals();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete (globalThis as any)[k];
      else (globalThis as any)[k] = v;
    }
    saved = {};
  });

  it("全新安装：下载 → 校验 → 暂存 → 探测 → 原子改名，成功后清理安装包", async () => {
    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(winJavaPath());
    expect(host.fs.exists(winJavaPath())).toBe(true);
    // 暂存目录与安装包缓存都被清掉
    expect(host.fs.exists(STAGING_DIR)).toBe(false);
    expect(host.fs.exists(ARCHIVE_ZIP)).toBe(false);
    expect(host.fs.exists(META_JSON)).toBe(false);
    // 安装包只下载了一次（探测是区间请求，不计入下载）
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(1);
  });

  it("解压中断后重试：校验通过的安装包被保留，重试不再下载（中断继续）", async () => {
    // 第一次：下载成功、解压失败（tar 与 PowerShell 兜底都失败，模拟中断）
    host.tarExits = [1, 1];
    await expect(downloadJRE(17)).rejects.toThrow(/java-error-extract-failed/);

    // 安装包与校验记录保留，暂存目录被清理，正式目录未产生
    expect(host.fs.exists(ARCHIVE_ZIP)).toBe(true);
    expect(host.fs.exists(META_JSON)).toBe(true);
    expect(host.fs.exists(STAGING_DIR)).toBe(false);
    expect(host.fs.exists(RUNTIME_DIR)).toBe(false);

    // 第二次：解压成功，直接复用本地安装包
    host.tarExits = [0];
    const progressPhases: string[] = [];
    const javaPath = await downloadJRE(17, (p) =>
      progressPhases.push(p.phase + ":" + (p.message ?? "")),
    );

    expect(javaPath).toBe(winJavaPath());
    // GitHub 安装包自始至终只下载过一次
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(1);
    expect(
      progressPhases.some((s) => s.includes("java-progress-reuse-archive")),
    ).toBe(true);
    // 成功后缓存清掉
    expect(host.fs.exists(ARCHIVE_ZIP)).toBe(false);
  });

  it("校验和不匹配：报错并丢弃安装包，不进入解压", async () => {
    host.remote = {
      link: RELEASE_1.link,
      name: RELEASE_1.name,
      checksum: "deadbeef".repeat(8), // 与实际内容不符
    };

    await expect(downloadJRE(17)).rejects.toThrow(/java-error-checksum-mismatch/);

    expect(host.fs.exists(ARCHIVE_ZIP)).toBe(false);
    expect(host.fs.exists(META_JSON)).toBe(false);
    expect(host.dispatched.some((c) => c.includes("-xf") || c.includes("Expand-Archive"))).toBe(
      false,
    );
  });

  it("上游发布新补丁：本地旧包哈希不再匹配上游，作废并重新下载", async () => {
    // 先制造一次「下载成功、解压失败」的缓存（对应 17.0.20.1）
    host.tarExits = [1, 1];
    await expect(downloadJRE(17)).rejects.toThrow(/java-error-extract-failed/);
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(1);

    // 上游滚动到 17.0.21+7（校验和变了）
    host.remote = {
      link: RELEASE_2.link,
      name: RELEASE_2.name,
      checksum: sha256(ARCHIVE_2_BYTES),
    };
    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(winJavaPath());
    // 旧包作废重下：两个版本的包各下载一次
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(1);
    expect(host.downloads.filter((u) => u === RELEASE_2.link)).toHaveLength(1);
    expect(host.fs.exists(ARCHIVE_ZIP)).toBe(false);
  });

  it("断网（元数据接口不可达）但本地包完好：复用本地包完成安装", async () => {
    // 制造「下载成功、解压失败」的缓存
    host.tarExits = [1, 1];
    await expect(downloadJRE(17)).rejects.toThrow(/java-error-extract-failed/);

    // 断网：assets 接口失败；此时应信任本地记录的校验和
    host.assetsUnreachable = true;
    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(winJavaPath());
    // 没有再次下载安装包，也没有走 binary 兜底接口
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(1);
    expect(host.httpCalls.some((u) => u.includes("/v3/binary/"))).toBe(false);
  });

  it("自愈：已存在的托管 JRE 探测失败时删除重装", async () => {
    // 预置一个「文件存在但跑不起来」的坏 JRE（模拟历史中断残留）
    const broken = RUNTIME_DIR + SEP + "jdk-17.0.9+9-jre" + SEP + "bin" + SEP + "java.exe";
    host.fs.makeDirectory(RUNTIME_DIR + SEP + "jdk-17.0.9+9-jre" + SEP + "bin", {
      createAncestors: true,
    });
    host.fs.write(broken, new Uint8Array([1]));
    expect(await getManagedJavaExe()).toBe(broken);

    // 第一次 -version 失败（坏 JRE），随后暂存目录里的探测成功
    host.versionExits = [1, 0];
    const progressPhases: string[] = [];
    const javaPath = await downloadJRE(17, (p) =>
      progressPhases.push(p.phase + ":" + (p.message ?? "")),
    );

    expect(javaPath).toBe(winJavaPath());
    expect(progressPhases.some((s) => s.includes("java-progress-self-heal"))).toBe(true);
    // 旧目录（含坏 JRE）已被整体替换
    expect(host.fs.exists(broken)).toBe(false);
  });

  it("getJavaStatus：坏 JRE 被清理后才回退系统 Java，缓存不再指向死路径", async () => {
    const broken = RUNTIME_DIR + SEP + "jdk-17.0.9+9-jre" + SEP + "bin" + SEP + "java.exe";
    host.fs.makeDirectory(RUNTIME_DIR + SEP + "jdk-17.0.9+9-jre" + SEP + "bin", {
      createAncestors: true,
    });
    host.fs.write(broken, new Uint8Array([1]));

    host.versionExits = [1]; // 托管 JRE 探测失败
    const status = await getJavaStatus();

    // 本机没有系统 Java（PATH 环境桩返回空）
    expect(status.ready).toBe(false);
    // 坏目录已删除，缓存已清空
    expect(host.fs.exists(RUNTIME_DIR)).toBe(false);
    expect(await getManagedJavaExe()).toBeNull();
  });

  // ─── 国内镜像取件（大陆网络）──────────────────────────────────

  /** 镜像 URL 与 buildJreSources 的推导规则一致：{base}/{feature}/jre/{arch}/{os}/{包名} */
  function mirrorUrl(name: string): string {
    return `${MIRROR_BASES[0]}/17/jre/x64/windows/${name}`;
  }
  function tunaMirrorUrl(name: string): string {
    return `${MIRROR_BASES[1]}/17/jre/x64/windows/${name}`;
  }

  it("大陆网络：多个镜像可达时从最快的取件，官方地址不被整包下载", async () => {
    host.mirror = { reachable: true, bytes: ARCHIVE_1_BYTES };
    // 南京大学探测更快 → 排序胜出（耗时打平时按源表顺序，南京大学在前）
    host.latencyMs = {
      "mirrors.nju.edu.cn": 10,
      "mirrors.tuna.tsinghua.edu.cn": 900,
      "github.com": 900,
    };

    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(winJavaPath());
    // 整包来自最快的那个镜像；官方地址最多被探测，没有被整包下载
    expect(host.downloads).toContain(mirrorUrl(RELEASE_1.name));
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(0);
    // 两个镜像都被探测过（并发探测择优），去重后恰为两个镜像地址
    const mirrorCalls = new Set(
      host.httpCalls.filter((u) => MIRROR_BASES.some((b) => u.startsWith(b))),
    );
    expect(mirrorCalls.size).toBe(2);
    expect(host.fs.exists(winJavaPath())).toBe(true);
  });

  it("最快的镜像不可达：自动降级到下一个国内镜像", async () => {
    host.mirror = { reachable: true, bytes: ARCHIVE_1_BYTES };
    host.down = ["mirrors.nju.edu.cn"]; // 首选镜像探测失败
    host.latencyMs = { "github.com": 500 }; // 官方地址也慢，清华镜像胜出

    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(winJavaPath());
    expect(host.downloads).toContain(tunaMirrorUrl(RELEASE_1.name));
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(0);
  });

  it("镜像字节与官方校验和不符：自动换源到官方地址", async () => {
    // 镜像被污染/同步错版本：服务的是另一个发布的字节
    host.mirror = { reachable: true, bytes: ARCHIVE_2_BYTES };

    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(winJavaPath());
    // 官方兜底整包下载成功，安装完成
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(1);
  });

  it("镜像不可达：回落到官方地址（境外网络不受影响）", async () => {
    host.mirror = { reachable: false, bytes: ARCHIVE_1_BYTES };

    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(winJavaPath());
    expect(host.downloads.filter((u) => u === RELEASE_1.link)).toHaveLength(1);
  });

  it("镜像与官方都连接失败：报错列出全部来源，不进入解压", async () => {
    host.mirror = { reachable: false, bytes: ARCHIVE_1_BYTES };
    host.officialDown = true;

    await expect(downloadJRE(17)).rejects.toThrow(/java-error-download-failed/);
    expect(host.fs.exists(STAGING_DIR)).toBe(false);
    expect(host.fs.exists(RUNTIME_DIR)).toBe(false);
  });

  it("镜像与官方都可达但字节全部不符：报校验和错误，污染任一来源都装不进来", async () => {
    host.mirror = { reachable: true, bytes: ARCHIVE_1_BYTES };
    host.remote = {
      link: RELEASE_1.link,
      name: RELEASE_1.name,
      checksum: "deadbeef".repeat(8), // 与实际内容不符
    };

    await expect(downloadJRE(17)).rejects.toThrow(/java-error-checksum-mismatch/);
    expect(host.fs.exists(STAGING_DIR)).toBe(false);
  });

  it("元数据接口不可达（无官方校验和）时不走镜像：无法验真的字节宁可不要", async () => {
    host.assetsUnreachable = true;
    host.mirror = { reachable: true, bytes: ARCHIVE_1_BYTES };

    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(winJavaPath());
    // 只有官方 binary 重定向地址被整包下载，镜像一次都没碰
    expect(host.downloads.some((u) => u.startsWith(MIRROR_BASE))).toBe(false);
    expect(host.downloads.some((u) => u.includes("/v3/binary/latest/"))).toBe(true);
  });

  it("Windows 批处理首行切 UTF-8 代码页：中文路径不被 CP936 误解码", async () => {
    host.mirror = { reachable: true, bytes: ARCHIVE_1_BYTES };

    await downloadJRE(17);

    // 每个派发出去的批处理都以 chcp 65001 开头（实测矩阵：UTF-8 批处理只有
    // 切了代码页，中文路径才能被 cmd 正确解码；UTF-16LE 在该调用方式下根本
    // 不被执行）。
    const bats = host.dispatched.filter((c) => c.includes("ztransplit-jre-"));
    expect(bats.length).toBeGreaterThan(0);
    for (const bat of bats) {
      expect(bat.startsWith("@chcp 65001")).toBe(true);
    }
    // 命令行本身完整往返：探测批处理里带 java.exe 全路径与重定向。
    const probeBat = host.dispatched.find((c) => c.includes("-version"));
    expect(probeBat).toBeTruthy();
    expect(probeBat).toContain("java.exe");
    expect(probeBat).toContain('> "');
  });

  it("macOS 布局：Contents/Home/bin/java 也能完成安装（unix 派发分支）", async () => {
    host.mode = "mac";
    buildGlobals();

    const javaPath = await downloadJRE(17);

    expect(javaPath).toBe(
      RUNTIME_DIR + SEP + "jdk-17.0.20.1+1-jre" + SEP + "Contents" + SEP + "Home" + SEP + "bin" + SEP + "java",
    );
    expect(host.fs.exists(javaPath)).toBe(true);
    // 走的是 /bin/sh -c 包装
    expect(host.dispatched.some((c) => c.includes("/usr/bin/tar"))).toBe(true);
  });
});
