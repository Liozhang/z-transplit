/**
 * JRE 托管安装的端到端验证（真实网络 + 真实文件系统 + 真实子进程）。
 *
 * 默认跳过：设 ZT_E2E_NETWORK=1 才运行（CI 与离线开发不应依赖外网）。
 * 与 javaRuntimeManager.test.ts 的分工：那套用内存宿主覆盖中断安全与换源
 * 逻辑的每一个分支；本文件只验证一件事——整条链路在真实机器上真的能跑通：
 *
 *   1. 官方 API 取元数据与 SHA-256 → 国内镜像取安装包 → 校验 → tar 解压 →
 *      java -version 探测 → 原子落位。镜像字节必须逐字节通过官方校验和。
 *   2. Windows 批处理按 UTF-8 落盘且首行切换控制台代码页（chcp 65001）：数据
 *      目录故意用中文路径，cmd.exe 若按默认代码页（简体中文系统为 CP936）
 *      误解码，解压与探测会直接失败——这条路径正是简体中文 Windows 用户的
 *      真实环境。
 *
 * 宿主边界全部桩掉，但桩的背后是真实实现：fetch（Node 内置）、node:fs、
 * node:child_process。被测代码是未经修改的 src/core/pdf/JavaRuntimeManager.ts。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NETWORK = process.env.ZT_E2E_NETWORK === "1";

// 中文路径：模拟简体中文 Windows 用户名下的 Zotero 数据目录。
const DATA_DIR = path.join(
  os.tmpdir(),
  "ztransplit-e2e-中文测试",
);
const RUNTIME_DIR = path.join(DATA_DIR, "ztransplit", "java-runtime");

/** 与 JavaRuntimeManager 的 JRE_MIRRORS 一致：两家国内镜像。 */
const DOMESTIC_MIRROR_BASES = [
  "https://mirrors.nju.edu.cn/adoptium",
  "https://mirrors.tuna.tsinghua.edu.cn/Adoptium",
];

/** 本次运行实际发起过整包下载的 URL（探测是区间请求，不计入）。 */
const downloadedUrls: string[] = [];
/** 本次运行请求过的全部 URL（含探测与元数据接口）。 */
const requestedUrls: string[] = [];

// ─── nsIFile 桩（同步，真实 fs）──────────────────────────────────

class NsFile {
  path: string;
  constructor(p = "") {
    this.path = p;
  }
  initWithPath(p: string) {
    this.path = p;
  }
  clone() {
    return new NsFile(this.path);
  }
  append(name: string) {
    this.path = this.path.replace(/[\\/]+$/, "") + path.sep + name;
  }
  exists() {
    return fs.existsSync(this.path);
  }
  isDirectory() {
    try {
      return fs.statSync(this.path).isDirectory();
    } catch {
      return false;
    }
  }
  isExecutable() {
    if (!fs.existsSync(this.path)) return false;
    if (process.platform !== "win32") {
      try {
        fs.accessSync(this.path, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    return /\.(exe|bat|cmd)$/i.test(this.path);
  }
  get leafName() {
    return path.basename(this.path);
  }
  QueryInterface() {
    return this;
  }
  get directoryEntries() {
    const self = this;
    let names: string[] = [];
    try {
      names = fs.readdirSync(self.path);
    } catch {
      /* 不存在或不可读：空枚举 */
    }
    let index = 0;
    return {
      hasMoreElements: () => index < names.length,
      getNext: () => new NsFile(path.join(self.path, names[index++])),
    };
  }
}

// ─── 宿主桩 ──────────────────────────────────────────────────────

const ids: Record<string, { name: string; equals(o: unknown): boolean }> = {};
for (const name of [
  "nsIFile",
  "nsIProcess",
  "nsIEnvironment",
  "nsITimer",
  "nsIObserver",
  "nsISupports",
  "nsIXULRuntime",
  "nsIPropertyBag2",
]) {
  ids[name] = { name, equals: (o) => o === ids[name] };
}

function installHostStubs(): void {
  const httpStub = {
    async request(method: string, url: string, options: any = {}) {
      requestedUrls.push(url);
      const headers: Record<string, string> = {};
      const progressListeners: Array<(e: any) => void> = [];
      options.requestObserver?.({
        setRequestHeader: (k: string, v: string) => {
          headers[k] = v;
        },
        addEventListener: (type: string, cb: (e: any) => void) => {
          if (type === "progress") progressListeners.push(cb);
        },
      });
      const response = await fetch(url, {
        method,
        headers,
        redirect: "follow",
        signal: options.timeout
          ? AbortSignal.timeout(options.timeout)
          : undefined,
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (options.responseType === "arraybuffer") downloadedUrls.push(url);
      // fetch 没有进度事件：整包到手后补发一次，让调用方的进度回调有终值。
      for (const cb of progressListeners) {
        cb({ lengthComputable: true, loaded: buffer.length, total: buffer.length });
      }
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
      if (options.responseType === "json") {
        return { status: response.status, response: JSON.parse(buffer.toString("utf8")) };
      }
      return { status: response.status, response: arrayBuffer };
    },
  };

  const makeProcess = () => ({
    _file: null as NsFile | null,
    _child: null as any,
    pid: 0,
    isRunning: false,
    exitValue: 0,
    init(this: any, f: NsFile) {
      this._file = f;
    },
    kill(this: any) {
      try {
        this._child?.kill();
      } catch {
        /* 已经退出 */
      }
    },
    runwAsync(this: any, args: string[], _len: number, observer: any) {
      const exe = this._file?.path ?? "";
      const isBat = /\.bat$/i.test(exe);
      if (process.env.ZT_E2E_DEBUG) {
        console.log("[e2e-debug] 启动:", exe, isBat ? "(bat)" : JSON.stringify(args));
        if (isBat) console.log("[e2e-debug] bat 内容:", JSON.stringify(fs.readFileSync(exe, "utf8")));
      }
      // cmd.exe /c 忠实还原"批处理被 shell 解释执行"的语义——UTF-16LE 编码
      // 是否正确，正是由这条解释路径暴露的。
      const child = isBat
        ? spawn(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", exe], {
            windowsHide: true,
          })
        : spawn(exe, args, { windowsHide: true });
      this._child = child;
      this.pid = child.pid ?? 0;
      this.isRunning = true;
      child.on("exit", (code) => {
        this.isRunning = false;
        this.exitValue = code ?? 1;
        if (process.env.ZT_E2E_DEBUG) {
          console.log("[e2e-debug] 退出码:", code);
        }
        setTimeout(() => observer.observe(null, "process-finished"), 0);
      });
      child.on("error", () => {
        this.isRunning = false;
        setTimeout(() => observer.observe(null, "process-failed"), 0);
      });
    },
  });

  (globalThis as any).Zotero = {
    isWin: process.platform === "win32",
    isMac: process.platform === "darwin",
    platform: process.platform,
    DataDirectory: { dir: DATA_DIR },
    getTempDirectory: () => {
      // 真实 Zotero 的 getTempDirectory() 保证目录已存在；桩要复现这一前提，
      // 否则 execCommand 写 .bat 时会 ENOENT（真实宿主上不会发生）。
      const tmp = path.join(DATA_DIR, "tmp");
      fs.mkdirSync(tmp, { recursive: true });
      return new NsFile(tmp);
    },
    HTTP: httpStub,
  };
  (globalThis as any).Components = {
    classes: {
      "@mozilla.org/file/local;1": {
        createInstance: () => new NsFile(),
      },
      "@mozilla.org/process/util;1": { createInstance: () => makeProcess() },
      "@mozilla.org/process/environment;1": {
        getService: () => ({
          get: (name: string) =>
            name === "PATH" ? (process.env.PATH ?? "") : (process.env[name] ?? ""),
        }),
      },
      "@mozilla.org/timer;1": {
        createInstance: () => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          return {
            initWithCallback: (cb: { notify: () => void }, ms: number) => {
              timer = setTimeout(() => cb.notify(), ms);
            },
            cancel: () => {
              if (timer) clearTimeout(timer);
            },
          };
        },
      },
      "@mozilla.org/xre/app-info;1": {
        getService: () => ({
          OS: process.platform === "win32" ? "WINNT" : "Darwin",
        }),
      },
      "@mozilla.org/system-info;1": {
        getService: () => ({ get: () => "" }),
      },
    },
    interfaces: ids,
    results: { NS_NOINTERFACE: {} },
  };
  (globalThis as any).Services = {
    appinfo: { OS: process.platform === "win32" ? "WINNT" : "Darwin" },
  };
  (globalThis as any).IOUtils = {
    exists: async (p: string) => fs.existsSync(p),
    read: async (p: string) => new Uint8Array(fs.readFileSync(p)),
    readUTF8: async (p: string) => fs.readFileSync(p, "utf8"),
    write: async (p: string, data: Uint8Array) => {
      // 与真实 IOUtils 一致：不创建父目录（调用方负责 makeDirectory）。
      fs.writeFileSync(p, data);
    },
    writeUTF8: async (p: string, text: string) => {
      fs.writeFileSync(p, text, "utf8");
    },
    getChildren: async (dir: string) => {
      try {
        return fs.readdirSync(dir).map((name) => path.join(dir, name));
      } catch {
        return [];
      }
    },
    remove: async (p: string, opts: any = {}) => {
      try {
        fs.rmSync(p, { recursive: !!opts.recursive, force: !!opts.ignoreAbsent });
      } catch {
        /* best-effort */
      }
    },
    makeDirectory: async (p: string, opts: any = {}) => {
      fs.mkdirSync(p, { recursive: !!opts.createAncestors });
    },
    move: async (src: string, dest: string) => {
      fs.renameSync(src, dest);
    },
    setPermissions: async (p: string, mode: number) => {
      try {
        fs.chmodSync(p, mode);
      } catch {
        /* Windows 上无意义 */
      }
    },
  };
  (globalThis as any).PathUtils = { join: (...parts: string[]) => path.join(...parts) };
}

// ─── 场景 ────────────────────────────────────────────────────────

describe.skipIf(!NETWORK)("JRE 镜像端到端（ZT_E2E_NETWORK=1 才运行）", () => {
  const saved: Record<string, unknown> = {};

  beforeAll(() => {
    for (const k of ["Zotero", "Components", "Services", "IOUtils", "PathUtils"]) {
      saved[k] = (globalThis as any)[k];
    }
    installHostStubs();
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete (globalThis as any)[k];
      else (globalThis as any)[k] = v;
    }
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("真实网络：官方校验和 + 国内镜像取件 + 中文路径下解压探测全部通过", async () => {
    const { downloadJRE } = await import("../../../../src/core/pdf/JavaRuntimeManager");

    const phases: string[] = [];
    const javaExe = await downloadJRE(17, (p) =>
      phases.push(`${p.phase}:${p.message ?? ""}`),
    );

    // 1. 装到了数据目录下，路径带中文
    expect(javaExe.startsWith(RUNTIME_DIR)).toBe(true);
    expect(fs.existsSync(javaExe)).toBe(true);

    // 2. 官方 API 被调用过（校验和的来源）
    expect(requestedUrls.some((u) => u.includes("/v3/assets/latest/"))).toBe(true);

    // 3. 整包来自国内镜像（境内网络下官方 GitHub 地址根本拉不动）。
    //    具体哪一家由并发探测的实时延迟决定，两家都算通过。
    const mirrorDownloads = downloadedUrls.filter((u) =>
      DOMESTIC_MIRROR_BASES.some((base) => u.startsWith(base)),
    );
    expect(mirrorDownloads.length).toBeGreaterThan(0);
    if (process.env.ZT_E2E_DEBUG) {
      console.log("[e2e-debug] 整包来源:", mirrorDownloads);
      console.log("[e2e-debug] 全部请求:", requestedUrls);
    }

    // 4. 安装出来的 java 真的能跑（中文路径 + UTF-16LE 批处理 + tar 解压）
    const probe = spawnSync(javaExe, ["-version"], { encoding: "utf8" });
    expect(probe.status).toBe(0);
    expect(`${probe.stdout}${probe.stderr}`).toMatch(/version "17\./);

    // 5. 进度回调走过了选择来源与下载阶段
    expect(phases.some((p) => p.startsWith("downloading:"))).toBe(true);
  }, 300_000);
});
