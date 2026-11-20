/**
 * sidecarEnv 测试（src/core/pdf/scan/sidecarEnv.ts）。
 *
 * 一键安装是"用户点一次，插件把解释器、脚本、依赖、命令全办好"的那条链路，
 * 钉住四件事：
 *   1. 全链路成功：解释器（真实走 pythonRuntime，宿主已伪造）→ 脚本落地 →
 *      pip 带镜像索引 → 自检 → 命令回填偏好，四步顺序与产物都验到；
 *   2. 已就绪时不重复下载几百兆（零网络、零进程）；
 *   3. 任一步失败（pip、自检、随包缺失、无镜像、取消）都抛本地化错误，且
 *      不写安装标记、不回填命令——半成品环境不能被当成装好了；
 *   4. 状态查询的四个层级与清理（删目录 + 清命令偏好）。
 *
 * 宿主边界全部伪造：OpenDataLoaderPdfClient（readBundledFile / runProcess）
 * 与 JavaRuntimeManager（extractTarGzArchive）整体 mock，HTTP 按 URL 形态
 * 路由，文件系统用内存实现，Zotero.Prefs 用内存表。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const readBundledFile = vi.fn();
const runProcess = vi.fn();

vi.mock("../../../../../src/core/pdf/OpenDataLoaderPdfClient", () => ({
  readBundledFile: (...args: unknown[]) => readBundledFile(...args),
  readBundledLibFile: (...args: unknown[]) => readBundledFile(...args),
  runProcess: (...args: unknown[]) => runProcess(...args),
}));

const extractTarGzArchive = vi.fn();

vi.mock("../../../../../src/core/pdf/JavaRuntimeManager", () => ({
  extractTarGzArchive: (...args: unknown[]) => extractTarGzArchive(...args),
}));

import {
  buildSidecarCommand,
  discardSidecarEnv,
  fastestPypiIndex,
  getSidecarEnvStatus,
  getSidecarScriptPath,
  installSidecarEnv,
  type SidecarEnvProgress,
} from "../../../../../src/core/pdf/scan/sidecarEnv";

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
const SIDECAR_DIR = `${DATA_DIR}\\ztransplit\\scan-sidecar`;
const PYTHON_EXE = `${RUNTIME_DIR}\\python\\python.exe`;
const SIDECAR_PY = `${SIDECAR_DIR}\\sidecar.py`;
const PREF_KEY = "extensions.zotero.ztransplit.pdfParser.scan.sidecarPath";
/** 假 PATH 上的"系统 Python"（解析后的绝对路径）。 */
const SYSTEM_PYTHON_DIR = "D:\\Python313";
const SYSTEM_PYTHON_PATH = `${SYSTEM_PYTHON_DIR}\\python.exe`;

/** 好字节与它们的真实 SHA-256（模拟"上游 SHA256SUMS 里登记的指纹"）。 */
const GOOD_BYTES = new TextEncoder().encode("good python runtime archive");
const GOOD_SHA = createHash("sha256").update(GOOD_BYTES).digest("hex");

const MANIFEST_TEXT = readFileSync(
  path.resolve(__dirname, "../../../../../src/core/pdf/lib/PYTHON-RUNTIME.json"),
  "utf-8",
);
const MANIFEST = JSON.parse(MANIFEST_TEXT);
const WIN_ARTIFACT = MANIFEST.artifacts.find((a: any) => a.platform === "win-x64");
const SUMS_TEXT = `${GOOD_SHA}  ${WIN_ARTIFACT.file}\n`;

const TUNA_BASE = "https://pypi.tuna.tsinghua.edu.cn";

let fs: FakeFS;
let host: {
  httpCalls: Array<{ url: string; kind: string }>;
  /** 每个 URL 的探测延迟；pip 索引探测也用它。 */
  latencyFor: (url: string) => number;
  /** pip 索引是否可达。 */
  mirrorReachable: (url: string) => boolean;
  /** pip install 的退出码。 */
  pipExit: number;
  /** 自检的退出码。 */
  selftestExit: number;
  /** pip / 自检是否超时（进程仍在跑，被 runner 掐掉）。 */
  timedOut: boolean;
  /** 偏好写入是否失败（Zotero.Prefs.set 抛错）。 */
  prefWriteFails: boolean;
  /** 随包 sidecar.py / requirements.txt 是否读得到。 */
  bundlePresent: boolean;
  /**
   * 机器上"已有"的系统 Python。默认 none——既有用例都走受管运行时；
   * good 表示 PATH 上有一个合格的解释器（直接使用，不下载运行时）。
   */
  systemPython: "none" | "good";
};

function installHost(): void {
  fs = new FakeFS();
  host = {
    httpCalls: [],
    latencyFor: () => 5,
    mirrorReachable: () => true,
    pipExit: 0,
    selftestExit: 0,
    timedOut: false,
    prefWriteFails: false,
    bundlePresent: true,
    systemPython: "none",
  };

  (globalThis as any).Zotero = {
    DataDirectory: { dir: DATA_DIR },
    isWin: true,
    isMac: false,
    isARM: false,
    Prefs: {
      values: new Map<string, string>(),
      // 第二个参数是分支。真机上漏掉它读的是另一个分支，拿回来是空——桩必须
      // 复现这个行为，否则"漏分支参数"这类缺陷在测试里永远测不出来：
      // sidecarEnv 的状态查询就曾因此漏过，安装五步全成功、偏好也确实写进去
      // 了，状态却一直报"命令未回填"（真机 2026-11-19）。
      get(key: string, branch?: boolean) {
        if (branch !== true) return "";
        return this.values.get(key) ?? "";
      },
      set(key: string, value: string) {
        if (host.prefWriteFails) throw new Error("prefs store unavailable");
        this.values.set(key, value);
      },
      clear(key: string) {
        this.values.delete(key);
      },
    },
    HTTP: {
      request: async (method: string, url: string, opts: any) => {
        // 三类请求：校验清单（URL 收尾）、构件区间探测（带 requestObserver）、
        // pip 镜像探测（纯 text 无观察者）、整包下载（arraybuffer）。
        const kind = opts?.responseType === "arraybuffer"
          ? "download"
          : opts?.requestObserver
            ? "probe"
            : url.endsWith("/SHA256SUMS")
              ? "sums"
              : "mirror";
        host.httpCalls.push({ url, kind });
        if (kind === "sums") return { status: 200, response: SUMS_TEXT };
        if (kind === "mirror") {
          if (!host.mirrorReachable(url)) throw new Error("unreachable: " + url);
          await new Promise((r) => setTimeout(r, host.latencyFor(url)));
          return { status: 200, response: "" };
        }
        if (kind === "probe") {
          await new Promise((r) => setTimeout(r, host.latencyFor(url)));
          return { status: 206, response: "" };
        }
        return { status: 200, response: GOOD_BYTES.buffer };
      },
    },
  };
  (globalThis as any).IOUtils = {
    exists: (p: string) => fs.exists(p),
    read: (p: string) => fs.read(p),
    write: (p: string, bytes: Uint8Array) => fs.write(p, bytes),
    makeDirectory: (p: string) => fs.makeDirectory(p),
    remove: (p: string, opts?: any) => fs.remove(p, opts),
    move: (from: string, to: string) => fs.move(from, to),
  };
  (globalThis as any).PathUtils = {
    join: (...parts: string[]) => parts.join("\\"),
  };
  // PATH 搜索（pathSearch）要 nsIFile 与 nsIEnvironment：系统候选先按 PATH 把
  // 名字解析成绝对路径——Gecko 的 Subprocess 不做 PATH 查找（真机实测）。
  (globalThis as any).Components = {
    classes: {
      "@mozilla.org/file/local;1": {
        createInstance: () => ({
          path: "",
          initWithPath(this: any, p: string) {
            this.path = p;
          },
          exists(this: any) {
            return host.systemPython === "none"
              ? false
              : this.path === SYSTEM_PYTHON_PATH;
          },
          isDirectory() {
            return false;
          },
          isExecutable(this: any) {
            return this.exists();
          },
          QueryInterface(this: any) {
            return this;
          },
        }),
      },
      "@mozilla.org/process/environment;1": {
        getService: () => ({
          get: (name: string) => (name === "PATH" ? SYSTEM_PYTHON_DIR : ""),
        }),
      },
    },
    interfaces: {
      nsIFile: { name: "nsIFile" },
      nsIEnvironment: { name: "nsIEnvironment" },
    },
  };
  // 假本地化：测试里没有 Fluent 源，getString 会退回键名。这里造一个把参数
  // 拼进结果的格式化器，"错误信息带上了 pip 的 stderr 尾巴"才可断言。
  (globalThis as any)._globalThis = {
    addon: {
      data: {
        locale: {
          current: {
            formatMessagesSync: (
              msgs: Array<{ id: string; args?: Record<string, unknown> }>,
            ) =>
              msgs.map((m) => {
                const args = m.args ?? {};
                const rendered = Object.keys(args).map((k) => `${k}=${args[k]}`);
                return {
                  value: rendered.length ? `${m.id} (${rendered.join(", ")})` : m.id,
                };
              }),
          },
        },
      },
    },
  };

  readBundledFile.mockReset();
  readBundledFile.mockImplementation(async (rel: string) => {
    // 同一个 mock 同时供 readBundledLibFile（随包清单）与 readBundledFile
    // （侧车脚本）使用。清单缺失的行为由 pythonRuntime 的测试覆盖，这里始终
    // 提供，让缺件用例只缺侧车脚本。
    if (rel === "PYTHON-RUNTIME.json") return MANIFEST_TEXT;
    if (!host.bundlePresent) return null;
    if (rel === "scan-sidecar/sidecar.py") return "# sidecar.py\n";
    if (rel === "scan-sidecar/requirements.txt") return "paddleocr\n";
    return null;
  });
  runProcess.mockReset();
  runProcess.mockImplementation(async (exe: string, argv: string[]) => {
    // 系统候选探测（PATH 上的 python3 / python）。默认 none：绝大多数用例
    // 走受管运行时，系统解析按需开启。
    if (exe === SYSTEM_PYTHON_PATH) {
      if (host.systemPython === "none") {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `File at path "${exe}" does not exist`,
          timedOut: false,
          aborted: false,
        };
      }
      // 三关合成一条 `-c` 命令：版本 / 指针宽度 / pip 可导入，输出三行
      if (argv.includes("-c")) {
        return {
          exitCode: 0,
          stdout: "3.12.16\r\n64\r\npip\r\n",
          stderr: "",
          timedOut: false,
          aborted: false,
        };
      }
    }
    if (argv.includes("-V")) {
      return {
        exitCode: 0,
        stdout: "Python 3.12.16",
        stderr: "",
        timedOut: false,
        aborted: false,
      };
    }
    // 超时与控制原因由 runner 放在 stderr 首行（真实 Subprocess 的行为）
    const control = host.timedOut ? "Process timed out\n" : "";
    if (argv.includes("pip")) {
      const ok = host.pipExit === 0 && !host.timedOut;
      return {
        exitCode: ok ? 0 : -1,
        stdout: ok ? "Successfully installed paddleocr" : "",
        stderr: ok ? "" : `${control}ERROR: No matching distribution found for paddlepaddle`,
        timedOut: host.timedOut,
        aborted: false,
      };
    }
    // 自检：stdout 里带引擎版本（安装标记会记下它）
    const ok = host.selftestExit === 0 && !host.timedOut;
    return {
      exitCode: ok ? 0 : -1,
      stdout: ok ? '{"selftest": "ok", "engineVersion": "3.4.0"}' : "",
      stderr: ok ? "" : `${control}OSError: [WinError 126] 找不到指定的模块`,
      timedOut: host.timedOut,
      aborted: false,
    };
  });
  extractTarGzArchive.mockReset();
  extractTarGzArchive.mockImplementation(async (_archive: string, dest: string) => {
    await fs.makeDirectory(`${dest}\\python`);
    await fs.write(`${dest}\\python\\python.exe`, new TextEncoder().encode("MZ fake python"));
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
  delete (globalThis as any)._globalThis;
});

/** 已装好解释器的宿主（少走一遍下载链路，供状态与清理用例复用）。 */
async function installRuntimeOnly(): Promise<void> {
  await fs.makeDirectory(`${RUNTIME_DIR}\\python`);
  await fs.write(PYTHON_EXE, new TextEncoder().encode("MZ"));
}

// ─── 纯函数 ────────────────────────────────────────────────────────────────

describe("buildSidecarCommand", () => {
  it("解释器与脚本都加引号（路径带空格是常态）", () => {
    expect(buildSidecarCommand("D:\\a b\\python.exe", "D:\\c d\\sidecar.py")).toBe(
      '"D:\\a b\\python.exe" "D:\\c d\\sidecar.py"',
    );
  });
});

describe("fastestPypiIndex", () => {
  it("并发探测全部索引，返回最快的那个", async () => {
    host.latencyFor = (url) => (url.includes(TUNA_BASE) ? 1 : 30);
    const index = await fastestPypiIndex();
    expect(index).toBe(`${TUNA_BASE}/simple`);
    const probes = host.httpCalls.filter((c) => c.kind === "mirror");
    // 六个索引都要探测（否则"最快"只是猜）
    expect(probes).toHaveLength(6);
  });

  it("官方索引走 pypi.org，不拿文件主机当索引（files.pythonhosted.org 没有 /simple/）", async () => {
    // 只连通官方源：选中的索引必须是 pypi.org/simple。用文件主机当索引会
    // 404，官方源被永远判为不可达，只连通官方源的网络就装不上。
    host.mirrorReachable = (url) => url.startsWith("https://pypi.org/simple");
    const index = await fastestPypiIndex();
    expect(index).toBe("https://pypi.org/simple");
    // 探测的是索引主机下的 /pip/，不是文件主机
    const official = host.httpCalls.filter(
      (c) => c.kind === "mirror" && c.url.startsWith("https://pypi.org/simple"),
    );
    expect(official.map((c) => c.url)).toEqual(["https://pypi.org/simple/pip/"]);
    expect(host.httpCalls.some((c) => c.url.includes("files.pythonhosted.org"))).toBe(false);
  });

  it("全部索引不可达：抛本地化错误，不提任何索引", async () => {
    host.mirrorReachable = () => false;
    await expect(fastestPypiIndex()).rejects.toThrow(/sidecar-error-no-mirror/);
  });
});

// ─── 安装全链路 ─────────────────────────────────────────────────────────────

describe("installSidecarEnv", () => {
  it("完整链路：脚本落地 → 解释器 → pip 带最快索引 → 自检 → 命令回填", async () => {
    host.latencyFor = (url) => (url.includes(TUNA_BASE) ? 1 : 30);
    const phases: string[] = [];
    const out = await installSidecarEnv({
      onProgress: (p: SidecarEnvProgress) => {
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      },
    });

    // 返回值与落地位置
    expect(out.pythonPath).toBe(PYTHON_EXE);
    expect(out.sidecarPath).toBe(SIDECAR_PY);
    expect(await fs.exists(PYTHON_EXE)).toBe(true);
    expect(await fs.exists(SIDECAR_PY)).toBe(true);
    expect(await fs.exists(`${SIDECAR_DIR}\\requirements.txt`)).toBe(true);
    expect(new TextDecoder().decode(await fs.read(SIDECAR_PY))).toBe("# sidecar.py\n");

    // 命令已回填，且形如 "<python>" "<script>"（用户不需要手抄）
    const prefs = (globalThis as any).Zotero.Prefs;
    expect(prefs.get(PREF_KEY, true)).toBe(`"${PYTHON_EXE}" "${SIDECAR_PY}"`);

    // 安装标记记下解释器、脚本、索引源与引擎版本
    const marker = JSON.parse(
      new TextDecoder().decode(await fs.read(`${SIDECAR_DIR}\\env.json`)),
    );
    expect(marker.pythonPath).toBe(PYTHON_EXE);
    expect(marker.sidecarPath).toBe(SIDECAR_PY);
    expect(marker.pipIndex).toBe(`${TUNA_BASE}/simple`);
    // 引擎版本来自自检的 stdout（不是解释器版本）
    expect(marker.engineVersion).toBe("3.4.0");

    // 进程调用：解释器探活（安装内 + 收尾各一次）、pip、自检
    const argvSets = runProcess.mock.calls.map((c) => c[1] as string[]);
    const pipCall = argvSets.find((a) => a.includes("pip"));
    expect(pipCall).toBeDefined();
    expect(pipCall).toEqual([
      "-m",
      "pip",
      "install",
      "--no-input",
      "--disable-pip-version-check",
      "--progress-bar",
      "off",
      "--index-url",
      `${TUNA_BASE}/simple`,
      "-r",
      `${SIDECAR_DIR}\\requirements.txt`,
    ]);
    expect(argvSets.some((a) => a[0] === SIDECAR_PY && a.includes("--selftest"))).toBe(true);

    // 进度阶段：脚本先落地（升级后要刷新），其后解释器、依赖、自检
    expect(phases).toEqual(["script", "runtime", "dependencies", "selftest", "done"]);
  });

  it("已就绪时刷新随包脚本（插件升级不能沿用盘上的旧侧车）", async () => {
    await installSidecarEnv({});
    // 模拟升级：盘上是旧脚本，随包里是新脚本
    await fs.write(SIDECAR_PY, new TextEncoder().encode("# old sidecar\n"));
    const out = await installSidecarEnv({});
    expect(out.sidecarPath).toBe(SIDECAR_PY);
    expect(new TextDecoder().decode(await fs.read(SIDECAR_PY))).toBe("# sidecar.py\n");
  });

  it("机器上已有合格的 Python：直接用它，一个字节的运行时都不下载", async () => {
    host.systemPython = "good";
    const phases: string[] = [];
    const out = await installSidecarEnv({
      onProgress: (p) => {
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      },
    });

    // 用的是 PATH 上解析出来的那个解释器，不是受管运行时
    expect(out.pythonPath).toBe(SYSTEM_PYTHON_PATH);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe(
      `"${SYSTEM_PYTHON_PATH}" "${SIDECAR_PY}"`,
    );
    // 受管运行时没有下载、没有解包、没有落地
    expect(host.httpCalls.filter((c) => c.kind === "download")).toHaveLength(0);
    expect(host.httpCalls.filter((c) => c.kind === "sums")).toHaveLength(0);
    expect(await fs.exists(PYTHON_EXE)).toBe(false);
    // 标记记下来源：状态查询据此知道依赖装在哪个环境里
    const marker = JSON.parse(
      new TextDecoder().decode(await fs.read(`${SIDECAR_DIR}\\env.json`)),
    );
    expect(marker.pythonSource).toBe("system");
    expect(marker.pythonPath).toBe(SYSTEM_PYTHON_PATH);
    // 没有"安装运行时"这一阶段（没有东西要装）
    expect(phases).toEqual(["script", "dependencies", "selftest", "done"]);

    // 状态查询同样认它
    const status = await getSidecarEnvStatus();
    expect(status.ready).toBe(true);
    expect(status.pythonSource).toBe("system");
    expect(status.pythonPath).toBe(SYSTEM_PYTHON_PATH);
  });

  it("系统 Python 存在但没有安装标记：解释器算就绪，依赖算缺失", async () => {
    host.systemPython = "good";
    const status = await getSidecarEnvStatus();
    expect(status.interpreter).toBe(true);
    expect(status.pythonSource).toBe("system");
    expect(status.dependencies).toBe(false);
    expect(status.error).toContain("sidecar-status-deps-missing");
  });

  it("系统 Python 被换掉（升级/卸载）：状态回到依赖缺失，不冒充就绪", async () => {
    host.systemPython = "good";
    await installSidecarEnv({});
    // 用户卸载了那个解释器：标记还在，但解析不到它了
    host.systemPython = "none";
    const status = await getSidecarEnvStatus();
    expect(status.interpreter).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.error).toContain("py-status-not-installed");
  });

  it("只差命令回填：直接补写命令，不重跑 pip 与自检", async () => {
    await installSidecarEnv({});
    // 命令偏好被清掉（用户误删或设置被重置）
    (globalThis as any).Zotero.Prefs.clear(PREF_KEY);
    const before = runProcess.mock.calls.length;
    const out = await installSidecarEnv({});
    expect(out.sidecarPath).toBe(SIDECAR_PY);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe(
      `"${PYTHON_EXE}" "${SIDECAR_PY}"`,
    );
    // 只有一次解释器探活，没有 pip、没有自检
    const fresh = runProcess.mock.calls.slice(before).map((c) => c[1] as string[]);
    expect(fresh).toEqual([["-V"]]);
  });

  it("命令写入设置失败：报错并给出可手填的命令（不假装装好了）", async () => {
    host.prefWriteFails = true;
    await expect(installSidecarEnv({})).rejects.toThrow(/sidecar-error-pref-write/);
    // 依赖确实装好了，只是没写上：再修好写入即可成功
    host.prefWriteFails = false;
    const out = await installSidecarEnv({});
    expect(out.sidecarPath).toBe(SIDECAR_PY);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe(
      `"${PYTHON_EXE}" "${SIDECAR_PY}"`,
    );
  });

  it("已就绪：零网络，也不重跑 pip 与自检", async () => {
    await installSidecarEnv({});
    const calls = host.httpCalls.length;
    const before = runProcess.mock.calls.length;
    const out = await installSidecarEnv({});
    expect(out.sidecarPath).toBe(SIDECAR_PY);
    // 一个字节都不再下载
    expect(host.httpCalls).toHaveLength(calls);
    // 唯一新增的进程调用是状态查询里的解释器探活；pip 与自检都不重跑
    const fresh = runProcess.mock.calls.slice(before).map((c) => c[1] as string[]);
    expect(fresh).toEqual([["-V"]]);
  });

  it("状态就绪判定要求解释器、脚本、依赖、命令四者齐备", async () => {
    await installSidecarEnv({});
    const status = await getSidecarEnvStatus();
    expect(status).toMatchObject({
      ready: true,
      interpreter: true,
      dependencies: true,
      commandConfigured: true,
      sidecarPath: SIDECAR_PY,
      pythonPath: PYTHON_EXE,
    });
    expect(status.error).toBeUndefined();
  });
});

// ─── 失败路径：半成品环境不得被当成装好了 ──────────────────────────────────

describe("installSidecarEnv 失败路径", () => {
  it("pip 失败：抛带 stderr 尾巴的本地化错误，不写标记、不回填命令", async () => {
    host.pipExit = 1;
    await expect(installSidecarEnv({})).rejects.toThrow(/sidecar-error-pip/);
    // 错误里必须带上 pip 的 stderr 尾巴（版本冲突、镜像缺件都写在末尾）
    await expect(installSidecarEnv({})).rejects.toThrow(/No matching distribution/);
    // 标记与命令偏好都不该留下
    expect(await fs.exists(`${SIDECAR_DIR}\\env.json`)).toBe(false);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe("");
  });

  it("自检失败：引擎装好了但跑不起来，同样不写标记", async () => {
    host.selftestExit = 1;
    await expect(installSidecarEnv({})).rejects.toThrow(/sidecar-error-selftest/);
    await expect(installSidecarEnv({})).rejects.toThrow(/WinError 126/);
    expect(await fs.exists(`${SIDECAR_DIR}\\env.json`)).toBe(false);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe("");
    // pip 已经跑过（自检在依赖之后）
    expect(runProcess.mock.calls.some((c) => (c[1] as string[]).includes("pip"))).toBe(true);
  });

  it("随包脚本缺失：报缺件错误，且不动 pip 与自检", async () => {
    host.bundlePresent = false;
    await expect(installSidecarEnv({})).rejects.toThrow(/sidecar-error-bundle-missing/);
    const argvSets = runProcess.mock.calls.map((c) => c[1] as string[]);
    expect(argvSets.some((a) => a.includes("pip"))).toBe(false);
    expect(argvSets.some((a) => a.includes("--selftest"))).toBe(false);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe("");
  });

  it("随包缺件但盘上已有脚本：保留原文件，装好的环境仍能补写命令", async () => {
    await installSidecarEnv({});
    // 安装包损坏（脚本读不到）+ 命令偏好被清掉：此时该补命令，不是报缺件
    host.bundlePresent = false;
    (globalThis as any).Zotero.Prefs.clear(PREF_KEY);
    const out = await installSidecarEnv({});
    expect(out.sidecarPath).toBe(SIDECAR_PY);
    // 盘上的脚本没被清掉，命令补写成功
    expect(new TextDecoder().decode(await fs.read(SIDECAR_PY))).toBe("# sidecar.py\n");
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe(
      `"${PYTHON_EXE}" "${SIDECAR_PY}"`,
    );
  });

  it("镜像全不可达：报无镜像错误，不跑 pip", async () => {
    host.mirrorReachable = () => false;
    await expect(installSidecarEnv({})).rejects.toThrow(/sidecar-error-no-mirror/);
    const argvSets = runProcess.mock.calls.map((c) => c[1] as string[]);
    expect(argvSets.some((a) => a.includes("pip"))).toBe(false);
    // 脚本已落地（这一步在探测索引之前），但没有标记
    expect(await fs.exists(SIDECAR_PY)).toBe(true);
    expect(await fs.exists(`${SIDECAR_DIR}\\env.json`)).toBe(false);
  });

  it("pip 超时：报超时文案（不归入「安装失败」），不写标记", async () => {
    host.timedOut = true;
    await expect(installSidecarEnv({})).rejects.toThrow(/sidecar-error-timeout/);
    // 文案里带等待分钟数，用户知道等的是多久
    await expect(installSidecarEnv({})).rejects.toThrow(/30/);
    expect(await fs.exists(`${SIDECAR_DIR}\\env.json`)).toBe(false);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe("");
  });

  it("取消信号已中止：按取消归类（name 可识别），不写标记、不回填命令", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      installSidecarEnv({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: "ZTransplitCancelled" });
    expect(await fs.exists(`${SIDECAR_DIR}\\env.json`)).toBe(false);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe("");
  });
});

// ─── 状态查询 ───────────────────────────────────────────────────────────────

describe("getSidecarEnvStatus", () => {
  it("什么都没装：解释器缺失，错误指向未安装", async () => {
    const status = await getSidecarEnvStatus();
    expect(status).toMatchObject({
      ready: false,
      interpreter: false,
      dependencies: false,
      commandConfigured: false,
    });
    expect(status.error).toContain("py-status-not-installed");
  });

  it("解释器在但依赖未装：报依赖缺失", async () => {
    await installRuntimeOnly();
    const status = await getSidecarEnvStatus();
    expect(status).toMatchObject({
      ready: false,
      interpreter: true,
      dependencies: false,
      commandConfigured: false,
    });
    expect(status.error).toContain("sidecar-status-deps-missing");
  });

  it("依赖装好但命令未回填：报命令缺失", async () => {
    await installSidecarEnv({});
    // 模拟命令偏好被用户清掉
    (globalThis as any).Zotero.Prefs.clear(PREF_KEY);
    const status = await getSidecarEnvStatus();
    expect(status).toMatchObject({
      ready: false,
      interpreter: true,
      dependencies: true,
      commandConfigured: false,
    });
    expect(status.error).toContain("sidecar-status-command-missing");
  });

  it("四步全齐：ready 为真", async () => {
    // 这条是"装完了"的正面断言。缺了它，状态查询里任何一处判错都只是让
    // ready 停在 false，而现有用例只断言 false 的各种形状，照样全绿——
    // 真机上"命令未回填"那个误报就是这么漏过去的（2026-11-19）。
    await installSidecarEnv({});
    const status = await getSidecarEnvStatus();
    expect(status).toMatchObject({
      ready: true,
      interpreter: true,
      dependencies: true,
      commandConfigured: true,
    });
    expect(status.error).toBeUndefined();
  });

  it("解释器探活不过：不算已安装", async () => {
    runProcess.mockImplementation(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "python: cannot execute",
      timedOut: false,
      aborted: false,
    }));
    await installRuntimeOnly();
    const status = await getSidecarEnvStatus();
    expect(status.interpreter).toBe(false);
    expect(status.error).toContain("py-status-not-installed");
  });
});

// ─── 清理 ──────────────────────────────────────────────────────────────────

describe("discardSidecarEnv", () => {
  it("删掉整个侧车目录并清掉命令偏好（修复入口）", async () => {
    await installSidecarEnv({});
    expect(await fs.exists(SIDECAR_PY)).toBe(true);
    await discardSidecarEnv();
    expect(await fs.exists(SIDECAR_DIR)).toBe(false);
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toBe("");
    // 命令偏好被清掉后状态回到依赖缺失层
    const status = await getSidecarEnvStatus();
    expect(status.ready).toBe(false);
  });

  it("目录不存在时不抛（重复点击修复）", async () => {
    await expect(discardSidecarEnv()).resolves.toBeUndefined();
  });

  it("清理后重新安装：命令回填恢复", async () => {
    await installSidecarEnv({});
    await discardSidecarEnv();
    host.latencyFor = (url) => (url.includes(TUNA_BASE) ? 1 : 30);
    const out = await installSidecarEnv({});
    expect(out.sidecarPath).toBe(getSidecarScriptPath());
    expect((globalThis as any).Zotero.Prefs.get(PREF_KEY, true)).toContain(SIDECAR_PY);
  });
});
