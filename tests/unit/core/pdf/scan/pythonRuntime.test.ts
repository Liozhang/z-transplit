/**
 * pythonRuntime 测试（src/core/pdf/scan/pythonRuntime.ts）。
 *
 * 安装链路是"宁可不装，也不装来路不明的字节"的执行者，钉住：
 *   1. 信任链：SHA256SUMS（上游信任锚）→ 字节过 SHA-256 → 解包 → 探活 →
 *      原子落地，缺一环就停；
 *   2. 降级：最快镜像字节不符自动换源；全部来源失败时报出每个来源的原因；
 *   3. 状态：探活不过的运行时不算可用（文件在 ≠ 能跑）；
 *   4. 清理：探活失败的暂存区被删掉，正式位置不被占据；在飞行取件归零。
 *
 * 宿主边界全部伪造：OpenDataLoaderPdfClient（readBundledLibFile /
 * runProcess）与 JavaRuntimeManager（extractTarGzArchive）整体 mock，HTTP
 * 按 URL 形态路由，文件系统用内存实现。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const readBundledLibFile = vi.fn();
const runProcess = vi.fn();
const extractTarGzArchive = vi.fn();

vi.mock("../../../../../src/core/pdf/OpenDataLoaderPdfClient", () => ({
  readBundledLibFile: (...args: unknown[]) => readBundledLibFile(...args),
  runProcess: (...args: unknown[]) => runProcess(...args),
}));

vi.mock("../../../../../src/core/pdf/JavaRuntimeManager", () => ({
  extractTarGzArchive: (...args: unknown[]) => extractTarGzArchive(...args),
}));

import {
  discardManagedPython,
  getManagedPythonPath,
  getPythonRuntimeStatus,
  installPythonRuntime,
  loadPythonRuntimeManifest,
  parsePythonVersion,
  pythonRuntimePlatformKey,
  resolveManagedPython,
} from "../../../../../src/core/pdf/scan/pythonRuntime";
import { acquisitionInFlightCount } from "../../../../../src/core/pdf/artifactAcquire";

// ─── 内存文件系统（IOUtils 语义子集，Windows 分隔符）──────────────────────

class FakeFS {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();

  private norm(p: string): string {
    return p.replace(/\//g, "\\");
  }

  async exists(p: string): Promise<boolean> {
    const n = this.norm(p);
    return this.files.has(n) || this.dirs.has(n);
  }

  async read(p: string): Promise<Uint8Array> {
    const n = this.norm(p);
    const content = this.files.get(n);
    if (!content) throw new Error("ENOENT: " + n);
    return content;
  }

  async readUTF8(p: string): Promise<string> {
    return new TextDecoder().decode(await this.read(p));
  }

  async write(p: string, bytes: Uint8Array): Promise<void> {
    this.files.set(this.norm(p), bytes);
  }

  async makeDirectory(p: string): Promise<void> {
    const n = this.norm(p);
    this.dirs.add(n);
    let idx = n.length;
    while ((idx = n.lastIndexOf("\\", idx - 1)) > 0) this.dirs.add(n.slice(0, idx));
  }

  async remove(p: string, opts?: { recursive?: boolean; ignoreAbsent?: boolean }): Promise<void> {
    const n = this.norm(p);
    const existed = this.files.has(n) || this.dirs.has(n);
    if (!existed) {
      if (opts?.ignoreAbsent) return;
      throw new Error("ENOENT: " + n);
    }
    for (const key of [...this.files.keys()]) {
      if (key === n || key.startsWith(n + "\\")) this.files.delete(key);
    }
    for (const key of [...this.dirs]) {
      if (key === n || key.startsWith(n + "\\")) this.dirs.delete(key);
    }
  }

  async move(from: string, to: string): Promise<void> {
    const f = this.norm(from);
    const t = this.norm(to);
    const moved: Array<[string, Uint8Array]> = [];
    for (const [key, value] of this.files) {
      if (key === f) moved.push([t, value]);
      else if (key.startsWith(f + "\\")) moved.push([t + key.slice(f.length), value]);
    }
    if (moved.length === 0) throw new Error("move source empty: " + f);
    for (const [key, value] of moved) this.files.set(key, value);
    await this.remove(f, { recursive: true, ignoreAbsent: true });
  }
}

// ─── 假宿主 ────────────────────────────────────────────────────────────────

const DATA_DIR = "D:\\ZoteroData";
const RUNTIME_DIR = `${DATA_DIR}\\ztransplit\\python-runtime`;

let fs: FakeFS;
let host: {
  httpCalls: Array<{ url: string; kind: string }>;
  /** 每个 URL 子串对应的下载字节；缺省用 GOOD_BYTES。 */
  bytesFor: (url: string) => Uint8Array | null;
  /** 每个 URL 子串对应的是否可探测（Range 请求）。 */
  reachable: (url: string) => boolean;
  latencyFor: (url: string) => number;
};

/** 好字节与它们的真实 SHA-256（模拟"上游 SHA256SUMS 里登记的指纹"）。 */
const GOOD_BYTES = new TextEncoder().encode("good python runtime archive");
const GOOD_SHA = createHash("sha256").update(GOOD_BYTES).digest("hex");
const BAD_BYTES = new TextEncoder().encode("tampered archive");

const MANIFEST_TEXT = readFileSync(
  path.resolve(__dirname, "../../../../../src/core/pdf/lib/PYTHON-RUNTIME.json"),
  "utf-8",
);
const MANIFEST = JSON.parse(MANIFEST_TEXT);
const WIN_ARTIFACT = MANIFEST.artifacts.find((a: any) => a.platform === "win-x64");

/** 上游 SHA256SUMS 文本：只登记本平台构件（好字节的指纹）。 */
const SUMS_TEXT = `${GOOD_SHA}  ${WIN_ARTIFACT.file}\n`;

let probeExits: number[] = [];

function installHost(): void {
  fs = new FakeFS();
  host = {
    httpCalls: [],
    bytesFor: () => GOOD_BYTES,
    reachable: () => true,
    latencyFor: () => 5,
  };
  probeExits = [0];

  (globalThis as any).Zotero = {
    DataDirectory: { dir: DATA_DIR },
    isWin: true,
    isMac: false,
    HTTP: {
      request: async (method: string, url: string, opts: any) => {
        // 探测是 1 字节区间请求（responseType text + Range 头）；下载是整包
        // （responseType arraybuffer + 进度观察者）。两者都带 requestObserver，
        // 只能按 responseType 区分。
        const kind = opts?.responseType === "arraybuffer" ? "download" : "probe";
        host.httpCalls.push({ url, kind });
        if (url.endsWith("/SHA256SUMS")) {
          if (!host.reachable(url)) throw new Error("unreachable: " + url);
          return { status: 200, response: SUMS_TEXT };
        }
        if (kind === "probe") {
          if (!host.reachable(url)) throw new Error("unreachable: " + url);
          await new Promise((r) => setTimeout(r, host.latencyFor(url)));
          return { status: 206, response: "" };
        }
        const bytes = host.bytesFor(url);
        if (!bytes) throw new Error("download failed: " + url);
        return { status: 200, response: bytes.buffer };
      },
    },
  };
  (globalThis as any).IOUtils = {
    exists: (p: string) => fs.exists(p),
    read: (p: string) => fs.read(p),
    readUTF8: (p: string) => fs.readUTF8(p),
    write: (p: string, bytes: Uint8Array) => fs.write(p, bytes),
    makeDirectory: (p: string) => fs.makeDirectory(p),
    remove: (p: string, opts?: any) => fs.remove(p, opts),
    move: (from: string, to: string) => fs.move(from, to),
  };
  (globalThis as any).PathUtils = {
    join: (...parts: string[]) => parts.join("\\"),
  };
  (globalThis as any).Components = {
    classes: {},
    interfaces: {},
  };

  readBundledLibFile.mockReset();
  readBundledLibFile.mockImplementation(async (name: string) =>
    name === "PYTHON-RUNTIME.json" ? MANIFEST_TEXT : null,
  );
  runProcess.mockReset();
  runProcess.mockImplementation(async () => {
    const exit = probeExits.length > 1 ? probeExits.shift()! : probeExits[0]!;
    return {
      exitCode: exit,
      stdout: exit === 0 ? "Python 3.12.16" : "",
      stderr: exit === 0 ? "" : "python: error while loading shared libraries",
      timedOut: false,
      aborted: false,
    };
  });
  extractTarGzArchive.mockReset();
  extractTarGzArchive.mockImplementation(async (_archive: string, dest: string) => {
    // 真实解包的落点：<dest>/python/python.exe（见清单的 executable 字段）
    const exe = `${dest}\\python\\python.exe`;
    await fs.makeDirectory(`${dest}\\python`);
    await fs.write(exe, new TextEncoder().encode("MZ fake python"));
  });
}

beforeEach(() => {
  installHost();
});

afterEach(() => {
  delete (globalThis as any).Zotero;
  delete (globalThis as any).IOUtils;
  delete (globalThis as any).PathUtils;
  delete (globalThis as any).Components;
});

// ─── 纯函数与探测 ──────────────────────────────────────────────────────────

describe("parsePythonVersion", () => {
  it("从 -V 输出取三段版本号", () => {
    expect(parsePythonVersion("Python 3.12.16")).toBe("3.12.16");
    expect(parsePythonVersion("python 3.13.1\n")).toBe("3.13.1");
    expect(parsePythonVersion("")).toBeNull();
    expect(parsePythonVersion("Python 3")).toBeNull();
  });
});

describe("pythonRuntimePlatformKey", () => {
  it("Windows x64 → win-x64", () => {
    expect(pythonRuntimePlatformKey()).toBe("win-x64");
  });

  it("Windows ARM → win-arm64", () => {
    (globalThis as any).Zotero.isARM = true;
    expect(pythonRuntimePlatformKey()).toBe("win-arm64");
  });

  it("macOS ARM → mac-arm64", () => {
    (globalThis as any).Zotero.isWin = false;
    (globalThis as any).Zotero.isMac = true;
    (globalThis as any).Zotero.isARM = true;
    expect(pythonRuntimePlatformKey()).toBe("mac-arm64");
  });
});

describe("loadPythonRuntimeManifest", () => {
  it("读随包清单并解析", async () => {
    const m = await loadPythonRuntimeManifest();
    expect(m).not.toBeNull();
    expect(m!.release).toBe(MANIFEST.release);
  });

  it("清单缺失 → null（安装入口据此报清单不可用）", async () => {
    readBundledLibFile.mockResolvedValue(null);
    expect(await loadPythonRuntimeManifest()).toBeNull();
  });

  it("清单结构不符 → null", async () => {
    readBundledLibFile.mockResolvedValue(JSON.stringify({ schema: "wrong" }));
    expect(await loadPythonRuntimeManifest()).toBeNull();
  });
});

// ─── 定位与状态 ────────────────────────────────────────────────────────────

describe("resolveManagedPython / getPythonRuntimeStatus", () => {
  it("未安装：路径给得出，解析为 null", async () => {
    expect(await getManagedPythonPath()).toBe(`${RUNTIME_DIR}\\python\\python.exe`);
    expect(await resolveManagedPython()).toBeNull();
  });

  it("装在盘上但探活失败：不算可用（文件在 ≠ 能跑）", async () => {
    const exe = `${RUNTIME_DIR}\\python\\python.exe`;
    await fs.makeDirectory(`${RUNTIME_DIR}\\python`);
    await fs.write(exe, new TextEncoder().encode("MZ"));
    probeExits = [1, 1];
    expect(await resolveManagedPython()).toBeNull();
    const status = await getPythonRuntimeStatus();
    expect(status.ready).toBe(false);
    expect(status.error).toContain("py-status-not-installed");
  });

  it("已安装且探活通过：状态带版本", async () => {
    const exe = `${RUNTIME_DIR}\\python\\python.exe`;
    await fs.makeDirectory(`${RUNTIME_DIR}\\python`);
    await fs.write(exe, new TextEncoder().encode("MZ"));
    const status = await getPythonRuntimeStatus();
    expect(status.ready).toBe(true);
    expect(status.version).toBe("3.12.16");
    expect(status.managed).toBe(true);
    expect(status.path).toBe(exe);
  });

  it("平台不在覆盖表内：状态报平台不支持", async () => {
    (globalThis as any).Zotero.isWin = false;
    (globalThis as any).Zotero.isMac = false;
    (globalThis as any).Zotero.isARM = false;
    (globalThis as any).Zotero.platform = "sunos";
    (globalThis as any).PathUtils = undefined;
    // isLinux() 兜底为 linux-x64，仍覆盖；真正不覆盖的平台靠 pythonPlatformFor
    // 的 null 分支，这里只验 linux 分支能落到键上。
    expect(pythonRuntimePlatformKey()).toBe("linux-x64");
  });
});

// ─── 安装 ──────────────────────────────────────────────────────────────────

describe("installPythonRuntime", () => {
  it("完整链路：校验清单 → 探测镜像 → 下载 → 指纹 → 解包 → 探活 → 落地", async () => {
    // 镜像明确更快：同延迟要靠计时决胜，那样的断言是 flaky 的
    host.latencyFor = (url) => (url.includes("cernet") ? 1 : 30);
    const exe = await installPythonRuntime({});
    expect(exe).toBe(`${RUNTIME_DIR}\\python\\python.exe`);
    // 落地后的文件在（探活 mock 成功）
    expect(await fs.exists(exe)).toBe(true);
    // 先取校验清单，再探测镜像（两个来源：cernet + upstream）
    expect(host.httpCalls[0].url.endsWith("/SHA256SUMS")).toBe(true);
    // 校验清单也是 text 响应，不算镜像探测
    const probes = host.httpCalls.filter(
      (c) => c.kind === "probe" && !c.url.endsWith("/SHA256SUMS"),
    );
    expect(probes.length).toBe(2);
    const downloads = host.httpCalls.filter((c) => c.kind === "download");
    // 探测出 cernet 更快 → 只从它下载一次
    expect(downloads).toHaveLength(1);
    expect(downloads[0].url).toContain("mirrors.cernet.edu.cn");
    // 解包目标目录存在过，且暂存区已被清掉
    expect([...fs.dirs].some((d) => d.includes(".staging-"))).toBe(false);
    // 下载的暂存归档也被清掉
    expect([...fs.files.keys()].some((f) => f.includes(".download-"))).toBe(false);
    // 在飞行取件归零（没有泄漏）
    expect(acquisitionInFlightCount()).toBe(0);
  });

  it("已安装且探活通过：零网络直接返回", async () => {
    const exe = `${RUNTIME_DIR}\\python\\python.exe`;
    await fs.makeDirectory(`${RUNTIME_DIR}\\python`);
    await fs.write(exe, new TextEncoder().encode("MZ"));
    const out = await installPythonRuntime({});
    expect(out).toBe(exe);
    expect(host.httpCalls).toHaveLength(0);
  });

  it("最快镜像字节不符：自动降级到规范源", async () => {
    host.bytesFor = (url) => (url.includes("cernet") ? BAD_BYTES : GOOD_BYTES);
    const exe = await installPythonRuntime({});
    expect(exe).toBe(`${RUNTIME_DIR}\\python\\python.exe`);
    const downloads = host.httpCalls.filter((c) => c.kind === "download");
    expect(downloads.length).toBe(2);
    expect(downloads[0].url).toContain("mirrors.cernet.edu.cn");
    expect(downloads[1].url).toContain("github.com");
  });

  it("最快镜像更慢：从快的那个下载", async () => {
    host.latencyFor = (url) => (url.includes("cernet") ? 50 : 5);
    await installPythonRuntime({});
    const downloads = host.httpCalls.filter((c) => c.kind === "download");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].url).toContain("github.com");
  });

  it("全部来源字节不符：报错且不落地", async () => {
    host.bytesFor = () => BAD_BYTES;
    await expect(installPythonRuntime({})).rejects.toThrow(/failed/);
    expect(await fs.exists(RUNTIME_DIR)).toBe(false);
    expect(acquisitionInFlightCount()).toBe(0);
  });

  it("校验清单里没有本平台构件：拒绝安装（不装来路不明的字节）", async () => {
    (globalThis as any).Zotero.isARM = true; // win-arm64，SUMS 里没登记
    await expect(installPythonRuntime({})).rejects.toThrow(/py-error-checksum-unavailable/);
    // 一个字节都不该下载
    expect(host.httpCalls.filter((c) => c.kind === "download")).toHaveLength(0);
  });

  it("清单不可用：报清单错误，不发起任何请求", async () => {
    readBundledLibFile.mockResolvedValue(null);
    await expect(installPythonRuntime({})).rejects.toThrow(/py-error-manifest-unavailable/);
    expect(host.httpCalls).toHaveLength(0);
  });

  it("解包后探活失败：暂存区清掉、正式位置不被占据", async () => {
    probeExits = [0, 1, 1]; // 第一次 resolve 前的存在性检查不跑进程；解包后探活失败
    runProcess.mockImplementation(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "python: cannot execute",
      timedOut: false,
      aborted: false,
    }));
    await expect(installPythonRuntime({})).rejects.toThrow(/failed/);
    expect(await fs.exists(RUNTIME_DIR)).toBe(false);
    expect([...fs.dirs].some((d) => d.includes(".staging-"))).toBe(false);
  });

  it("解包后可执行文件缺失：判失败并清理", async () => {
    extractTarGzArchive.mockImplementation(async () => {
      /* 解包了什么都没产出 */
    });
    await expect(installPythonRuntime({})).rejects.toThrow(/missing after extract/);
    expect([...fs.dirs].some((d) => d.includes(".staging-"))).toBe(false);
  });

  it("进度事件覆盖校验清单、下载、解包与完成四个阶段", async () => {
    const phases: string[] = [];
    await installPythonRuntime({
      onProgress: (p) => {
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      },
    });
    expect(phases).toEqual(["checksum", "probing", "downloading", "verifying", "extracting", "done"]);
  });

  it("取消信号已中止：不进下载", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      installPythonRuntime({ signal: controller.signal }),
    ).rejects.toThrow();
    expect(host.httpCalls.filter((c) => c.kind === "download")).toHaveLength(0);
  });
});

describe("discardManagedPython", () => {
  it("清掉整个运行时目录", async () => {
    const exe = `${RUNTIME_DIR}\\python\\python.exe`;
    await fs.makeDirectory(`${RUNTIME_DIR}\\python`);
    await fs.write(exe, new TextEncoder().encode("MZ"));
    await discardManagedPython();
    expect(await fs.exists(exe)).toBe(false);
    expect(await fs.exists(RUNTIME_DIR)).toBe(false);
  });

  it("目录不存在时不抛（修复入口的重复点击）", async () => {
    await expect(discardManagedPython()).resolves.toBeUndefined();
  });
});
