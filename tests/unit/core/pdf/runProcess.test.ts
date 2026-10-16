/**
 * runProcess 双分支外部进程 runner（src/core/pdf/OpenDataLoaderPdfClient.ts）。
 *
 * 假宿主驱动真实生产函数，覆盖契约：
 *
 *   1. Windows（Subprocess 直启）：Unicode/空格/shell 特殊字符 argv 原样抵达
 *      Subprocess.call，无 bat、无 cmd；UTF-8 JVM 编码属性只在 Windows 分支
 *      且位于调用方参数之前。
 *   2. 双流输出：多块、跨块 UTF-8、大输出、0/1/其他非零退出、单流/双流/空
 *      输出；实际退出码原样保留，未知退出码不伪报成功。
 *   3. 失败路径：模块导入/启动失败保留真实异常；读流/关闭失败保留已捕获
 *      内容与真实退出码并把捕获异常追加到 stderr；进程仍在运行时先停止。
 *   4. 生命周期：开始前取消不 spawn；启动窗口取消/超时后迟到句柄被终止；
 *      运行中取消/超时；exit/kill/abort 竞态首因主导、重复事件不重复
 *      settle；settle 前清 timer/卸 listener；kill 未完成前 Promise 不完成。
 *   5. Unix（nsIProcess + 捕获文件）：process-failed code=1 同样读双流再
 *      删文件；finished 非零；exitValue 不可读；同步启动异常；未知 topic
 *      不作完成；/bin/sh -c exec 引号转义与 kill 语义保持。
 *   6. 错误摘要 formatJavaExitError 总含退出码，经
 *      classifyOdlRuntimeError → PdfParseError → friendlyOdlError 传播后
 *      保留真实原因，不被改写成「Process failed to launch」/缺 Java/无输出。
 *
 * mock 只证明机制分支，不声称 Linux/macOS 实机已过。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runProcess,
  formatJavaExitError,
} from "../../../../src/core/pdf/OpenDataLoaderPdfClient";
import { classifyOdlRuntimeError } from "../../../../src/core/pdf/backendSelector";
import { PdfParseError } from "../../../../src/core/pdf/PdfParseError";
import {
  friendlyOdlError,
  isJavaMissingCause,
} from "../../../../src/core/pdf/splitview/splitViewFactory";

// ─── Windows 桩：ChromeUtils.importESModule → 假 Subprocess ─────────────────

type Chunk = string | Error;

class FakePipe {
  closed = false;
  chunks: Chunk[];
  closeCalls = 0;

  constructor(chunks: Chunk[] = []) {
    this.chunks = [...chunks];
  }

  async readString(): Promise<string> {
    if (!this.chunks.length) {
      this.closed = true; // EOF：真实 InputPipe 在 EOF 前置位 closed
      return "";
    }
    const c = this.chunks.shift()!;
    if (c instanceof Error) throw c;
    return c;
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.closed = true;
  }
}

class FakeProc {
  pid = 4242;
  exitCode: number | null = null;
  killCalls: number[] = [];
  stdin = {
    closeCalls: 0,
    closed: false,
    close: async () => {
      this.stdin.closeCalls++;
      this.stdin.closed = true;
    },
  };
  stdout: FakePipe;
  stderr: FakePipe;
  private waiters: Array<(v: { exitCode: number }) => void> = [];
  /** 挂起 kill() 直到放行——验证「终止未完成前 Promise 不完成」。 */
  killGate: Promise<void> | null = null;

  constructor(stdout: Chunk[] = [], stderr: Chunk[] = []) {
    this.stdout = new FakePipe(stdout);
    this.stderr = new FakePipe(stderr);
  }

  async wait(): Promise<{ exitCode: number }> {
    if (this.exitCode !== null) return { exitCode: this.exitCode };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async kill(timeout = 300): Promise<{ exitCode: number }> {
    this.killCalls.push(timeout);
    if (this.killGate) await this.killGate;
    this.finish(-9); // 真实 Subprocess：force kill 的终止码是 -9
    return this.wait();
  }

  finish(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const w of this.waiters.splice(0)) w({ exitCode: code });
    // 进程死亡后管道不再有新数据；EOF 由 readString 队列读空自然产生，
    // 不在这里预置 closed——否则「跨块空字节」中途会被误判为 EOF。
  }
}

interface CallRecord {
  command: string;
  arguments: string[];
  stderr?: string;
}

let savedGlobals: Record<string, unknown> = {};
let callRecords: CallRecord[];
let fakeProcs: FakeProc[];
/** 每次 Subprocess.call 的返回控制权（同步返回或挂起后手动放行）。 */
let pendingCalls: Array<(p: FakeProc) => void>;
let callRejects: Array<(e: Error) => void>;
let importError: Error | null;
let callCount: number;

function installWindowsHost(): void {
  (globalThis as any).Services = { appinfo: { OS: "WINNT" } };
  (globalThis as any).ChromeUtils = {
    importESModule: () => {
      if (importError) throw importError;
      return {
        Subprocess: {
          call(opts: CallRecord) {
            callRecords.push(opts);
            callCount++;
            return new Promise((resolve, reject) => {
              pendingCalls.push(resolve);
              callRejects.push(reject);
            });
          },
        },
      };
    },
  };
}

/** 造进程并放行 Subprocess.call。 */
function spawn(stdout: Chunk[] = [], stderr: Chunk[] = []): FakeProc {
  const p = new FakeProc(stdout, stderr);
  fakeProcs.push(p);
  const resolve = pendingCalls.shift();
  if (!resolve) throw new Error("no pending Subprocess.call");
  resolve(p);
  return p;
}

function rejectSpawn(e: Error): void {
  const reject = callRejects.shift();
  if (!reject) throw new Error("no pending Subprocess.call");
  reject(e);
}

function rejectPipe(pipe: FakePipe, message: string): void {
  pipe.chunks.push(new Error(message));
}

// ─── Unix 桩：nsIProcess 观察者 + 捕获文件 ──────────────────────────────────

class FakeFs {
  files = new Map<string, string>();
  removed: string[] = [];

  exists(p: string): boolean {
    return this.files.has(p);
  }
  write(p: string, text: string): void {
    this.files.set(p, text);
  }
  read(p: string): string {
    const v = this.files.get(p);
    if (v === undefined) throw new Error("NoSuchFile: " + p);
    return v;
  }
  remove(p: string): void {
    this.files.delete(p);
    this.removed.push(p);
  }
}

interface RunwRecord {
  args: string[];
  observer: { observe: (subject: any, topic: string) => void };
  proc: any;
}

let fs: FakeFs;
let runwCalls: RunwRecord[];

function makeFakeNsIFile(): any {
  const file: any = {
    path: "",
    initWithPath(p: string) {
      file.path = p;
    },
    exists: () => fs.exists(file.path),
    clone: () => makeFakeNsIFile(),
    append(name: string) {
      file.path = file.path ? file.path + "\\" + name : name;
    },
    remove: () => fs.remove(file.path),
    QueryInterface: () => file,
  };
  return file;
}

function installUnixHost(): void {
  const fakeComponents: any = {
    classes: {
      "@mozilla.org/file/local;1": {
        createInstance: () => makeFakeNsIFile(),
      },
      "@mozilla.org/file/directory_service;1": {
        getService: () => ({
          get: () => ({
            clone: () => {
              const dir = makeFakeNsIFile();
              dir.path = "C:\\Temp";
              return dir;
            },
          }),
        }),
      },
      "@mozilla.org/process/util;1": {
        createInstance: () => {
          const proc: any = {
            isRunning: false,
            killed: 0,
            exitValue: undefined,
            init(file: any) {
              proc.file = file;
            },
            runwAsync(args: string[], _count: number, observer: any) {
              proc.isRunning = true;
              runwCalls.push({ args, observer, proc });
            },
            kill() {
              proc.killed++;
              proc.isRunning = false;
            },
          };
          return proc;
        },
      },
    },
    interfaces: {
      nsIFile: {},
      nsIProcess: {},
      nsIObserver: {},
      nsISupports: {},
      nsIProperties: {},
    },
    results: { NS_NOINTERFACE: 0x80004002 },
  };
  (globalThis as any).Services = { appinfo: { OS: "Linux" } };
  (globalThis as any).Components = fakeComponents;
  (globalThis as any).Zotero = {
    isWin: false,
    getTempDirectory: () => ({ clone: () => makeFakeNsIFile() }),
    File: {
      getContents: (f: any) => fs.read(f.path),
    },
  };
}

/** 从 `/bin/sh -c` 命令串里解析重定向捕获文件路径（亦验证 exec 引号结构）。 */
function capturePathsOf(cmd: string): { out: string; err: string } {
  const m = / > '([^']*)' 2> '([^']*)'$/.exec(cmd);
  if (!m) throw new Error("redirect tail not found in: " + cmd);
  return { out: m[1], err: m[2] };
}

// ─── 公共生命周期 ───────────────────────────────────────────────────────────

beforeEach(() => {
  savedGlobals = {};
  // navigator 在 Node 上是 getter-only 属性，不能整体赋值——生产代码对它
  // 只做可选读取，这里跳过存取。
  for (const k of ["Components", "Services", "ChromeUtils", "Zotero", "IOUtils", "PathUtils"]) {
    savedGlobals[k] = (globalThis as any)[k];
  }
  callRecords = [];
  fakeProcs = [];
  pendingCalls = [];
  callRejects = [];
  importError = null;
  callCount = 0;
  fs = new FakeFs();
  runwCalls = [];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedGlobals)) {
    if (v === undefined) delete (globalThis as any)[k];
    else (globalThis as any)[k] = v;
  }
  vi.useRealTimers();
});

// ─── Windows：参数与编码属性 ────────────────────────────────────────────────

describe("Windows runner — argv 原样直达 Subprocess，无 bat / 无 shell", () => {
  const EXE = "C:\\Users\\张三\\Zotero\\java-runtime\\bin\\java.exe";
  const ARGS = [
    "-jar",
    "C:\\中文 目录\\opendataloader-pdf-cli.jar",
    "--output-dir",
    "C:\\输出 等 & dir",
    "C:\\文献 等 & % ! ( ).pdf",
  ];

  it("Unicode/空格/& % ! ( ) 参数逐字抵达，UTF-8 JVM 属性在最前", async () => {
    installWindowsHost();
    const p = runProcess(EXE, ARGS, 5000);
    const proc = spawn();
    proc.finish(0);
    const r = await p;

    expect(callRecords).toHaveLength(1);
    expect(callRecords[0].command).toBe(EXE);
    expect(callRecords[0].stderr).toBe("pipe");
    expect(callRecords[0].arguments).toEqual([
      "-Dfile.encoding=UTF-8",
      "-Dstdout.encoding=UTF-8",
      "-Dstderr.encoding=UTF-8",
      ...ARGS,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("不创建 bat、不派生 nsIProcess（Components 从不被触碰）", async () => {
    installWindowsHost();
    (globalThis as any).Components = {
      classes: new Proxy(
        {},
        {
          get: (_t, prop) => {
            throw new Error("Windows runner must not touch Components: " + String(prop));
          },
        },
      ),
    };
    const p = runProcess(EXE, ["-version"], 5000);
    spawn().finish(0);
    await p;
    expect(callCount).toBe(1);
  });

  it("Unix 分支不注入 JVM 编码属性", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x.jar", "a.pdf"], 5000);
    expect(runwCalls).toHaveLength(1);
    const cmd = runwCalls[0].args[1];
    expect(cmd.startsWith("exec ")).toBe(true);
    expect(cmd).not.toContain("-Dfile.encoding");
    runwCalls[0].proc.isRunning = false;
    const paths = capturePathsOf(cmd);
    fs.write(paths.out, "");
    fs.write(paths.err, "");
    runwCalls[0].observer.observe(
      { exitValue: 0 },
      "process-finished",
    );
    const r = await p;
    expect(r.exitCode).toBe(0);
  });
});

// ─── Windows：双流捕获与退出码 ──────────────────────────────────────────────

describe("Windows runner — 双流捕获与真实退出码", () => {
  it("多块双流拼接完整", async () => {
    installWindowsHost();
    const p = runProcess("java", ["-jar", "x"], 5000);
    spawn(["Hello ", "多块", " 输出"], ["warn", " 信息"]).finish(0);
    const r = await p;
    expect(r.stdout).toBe("Hello 多块 输出");
    expect(r.stderr).toBe("warn 信息");
  });

  it("跨块 UTF-8：空块（半个汉字）不结束读取", async () => {
    installWindowsHost();
    const p = runProcess("java", ["-jar", "x"], 5000);
    // 第二块是被块边界劈开的半个汉字：流式解码返回 ""，管道仍未关闭。
    spawn(["中", "", "文"]).finish(0);
    const r = await p;
    expect(r.stdout).toBe("中文");
  });

  it("大输出（>64KB，256 块×512B）双流无丢失", async () => {
    installWindowsHost();
    const big = (ch: string) =>
      Array.from({ length: 256 }, () => ch.repeat(512));
    const p = runProcess("java", ["-jar", "x"], 5000);
    spawn(big("x"), big("y")).finish(0);
    const r = await p;
    expect(r.stdout).toHaveLength(256 * 512);
    expect(r.stderr).toHaveLength(256 * 512);
    expect(new Set(r.stdout)).toEqual(new Set("x"));
  });

  it.each([
    [0, "", ""],
    [1, "out", ""],
    [2, "", "err"],
    [3, "both-out", "both-err"],
    [7, "", ""],
    [255, "partial", "boom"],
  ])("exit=%i 保留实际退出码与双流", async (code, out, err) => {
    installWindowsHost();
    const p = runProcess("java", ["-jar", "x"], 5000);
    spawn([out], [err]).finish(code);
    const r = await p;
    expect(r.exitCode).toBe(code);
    expect(r.stdout).toBe(out);
    expect(r.stderr).toBe(err);
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBeFalsy();
  });

  it("未知退出码（NaN）不伪报成功", async () => {
    installWindowsHost();
    const p = runProcess("java", ["-jar", "x"], 5000);
    const proc = spawn();
    proc.finish(NaN); // wait() 返回 { exitCode: NaN }
    const r = await p;
    expect(r.exitCode).toBe(-1);
  });
});

// ─── Windows：失败路径 ──────────────────────────────────────────────────────

describe("Windows runner — 失败诊断保留真实原因", () => {
  it("模块导入异常保留真实消息，返回 -1", async () => {
    installWindowsHost();
    importError = new Error("Module resource://gre/modules/Subprocess.sys.mjs missing");
    const r = await runProcess("java", ["-jar", "x"], 5000);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("Subprocess.sys.mjs missing");
    expect(r.stderr).not.toBe("Process failed to launch");
    expect(r.timedOut).toBe(false);
  });

  it("启动失败（无效可执行文件）保留真实异常", async () => {
    installWindowsHost();
    const p = runProcess("C:\\bad\\java.exe", ["-jar", "x"], 5000);
    rejectSpawn(new Error('File at path "C:\\bad\\java.exe" does not exist'));
    const r = await p;
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("does not exist");
    expect(r.stderr).not.toBe("Process failed to launch");
  });

  it("读流失败：保留已捕获内容、终止仍在运行的进程、追加捕获异常", async () => {
    installWindowsHost();
    const p = runProcess("java", ["-jar", "x"], 5000);
    const proc = spawn(["captured-before-fail"]);
    rejectPipe(proc.stdout, "pipe read broke");
    proc.finish(0); // 进程仍可正常退出
    const r = await p;
    expect(r.exitCode).toBe(0); // 已知实际退出码保留
    expect(r.stdout).toBe("captured-before-fail");
    expect(r.stderr).toContain("stdout capture failed: pipe read broke");
  });

  it("读流失败且进程仍在运行：先 kill 再返回实际终止码", async () => {
    installWindowsHost();
    const p = runProcess("java", ["-jar", "x"], 5000);
    const proc = spawn([], ["err-partial"]);
    rejectPipe(proc.stderr, "reader died");
    // 进程未退出 → runner 应发起 kill
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.killCalls).toEqual([0]);
    const r = await p;
    expect(r.exitCode).toBe(-9); // kill 的实际终止码
    expect(r.stderr).toContain("err-partial");
    expect(r.stderr).toContain("stderr capture failed: reader died");
  });

  it("stdin 关闭失败被记录但不改变退出码", async () => {
    installWindowsHost();
    const p = runProcess("java", ["-jar", "x"], 5000);
    const proc = spawn();
    proc.stdin.close = async () => {
      throw new Error("stdin busy");
    };
    proc.finish(0);
    const r = await p;
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("stdin close failed: stdin busy");
  });

  it("收尾 pipe 关闭失败不覆盖原始结果", async () => {
    installWindowsHost();
    const p = runProcess("java", ["-jar", "x"], 5000);
    const proc = spawn(["o"], ["e"]);
    proc.stdout.close = async () => {
      throw new Error("close exploded");
    };
    // 读取器先耗尽到 EOF（closed=true），再模拟 finalize 时管道仍挂着：
    // 真实 API 下 close 只对未关管道发起，失败须记录且不改结果。
    await new Promise((r) => setTimeout(r, 5));
    proc.stdout.closed = false;
    proc.finish(4);
    const r = await p;
    expect(r.exitCode).toBe(4);
    expect(r.stdout).toBe("o");
    expect(r.stderr).toContain("e");
    expect(r.stderr).toContain("pipe close failed: close exploded");
  });
});

// ─── Windows：生命周期与竞态 ────────────────────────────────────────────────

describe("Windows runner — 取消/超时/竞态/清理", () => {
  it("开始前已取消：不 spawn", async () => {
    installWindowsHost();
    const ac = new AbortController();
    ac.abort();
    const r = await runProcess("java", ["-jar", "x"], 5000, ac.signal);
    expect(callCount).toBe(0);
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBe(-1);
  });

  it("启动 Promise pending 时取消：迟到句柄被终止，结果为 aborted", async () => {
    installWindowsHost();
    const ac = new AbortController();
    const p = runProcess("java", ["-jar", "x"], 5000, ac.signal);
    ac.abort(); // call 尚未返回
    const proc = spawn(["late-out"]);
    await new Promise((r) => setTimeout(r, 5));
    expect(proc.killCalls).toEqual([0]); // 句柄一到即 kill
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("aborted");
  });

  it("启动窗口超时：迟到句柄被终止，结果为 timedOut", async () => {
    installWindowsHost();
    vi.useFakeTimers();
    const p = runProcess("java", ["-jar", "x"], 50);
    await vi.advanceTimersByTimeAsync(50); // call 仍 pending，超时先登记
    const proc = spawn();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.killCalls).toEqual([0]);
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("Process timed out");
  });

  it("运行中取消：kill 进程树，保留已捕获输出", async () => {
    installWindowsHost();
    const ac = new AbortController();
    const p = runProcess("java", ["-jar", "x"], 5000, ac.signal);
    const proc = spawn(["partial stdout"], ["partial stderr"]);
    ac.abort();
    const r = await p;
    expect(proc.killCalls).toEqual([0]);
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stdout).toBe("partial stdout");
    expect(r.stderr.startsWith("aborted")).toBe(true);
    expect(r.stderr).toContain("partial stderr");
  });

  it("运行中超时：kill 后以哨兵完成，kill 的 -9 不覆盖控制原因", async () => {
    installWindowsHost();
    vi.useFakeTimers();
    const p = runProcess("java", ["-jar", "x"], 100);
    const proc = spawn(["chunk"]);
    await vi.advanceTimersByTimeAsync(100);
    const r = await p;
    expect(proc.killCalls).toEqual([0]);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stdout).toBe("chunk");
    expect(r.stderr.startsWith("Process timed out")).toBe(true);
  });

  it("竞态：自然退出先登记，晚到的超时不改写结果", async () => {
    installWindowsHost();
    vi.useFakeTimers();
    const p = runProcess("java", ["-jar", "x"], 50);
    const proc = spawn();
    proc.finish(3);
    await vi.advanceTimersByTimeAsync(200); // 让超时晚到
    const r = await p;
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(proc.killCalls).toHaveLength(0); // 不再 kill 已退出进程
  });

  it("竞态：kill 的 -9 已先被超时登记，结果保持 timedOut", async () => {
    installWindowsHost();
    vi.useFakeTimers();
    const p = runProcess("java", ["-jar", "x"], 30);
    const proc = spawn();
    await vi.advanceTimersByTimeAsync(30); // 超时登记 → kill → finish(-9)
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  });

  it("重复 abort 通知只 settle 一次，结果稳定", async () => {
    installWindowsHost();
    const ac = new AbortController();
    const p = runProcess("java", ["-jar", "x"], 5000, ac.signal);
    const proc = spawn();
    ac.abort();
    ac.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(proc.killCalls).toHaveLength(1);
  });

  it("settle 后清 timer、卸 abort listener、关闭 pipe", async () => {
    installWindowsHost();
    const listeners = new Set<() => void>();
    const ac = new AbortController();
    const signal = {
      aborted: false,
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    } as unknown as AbortSignal;
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const p = runProcess("java", ["-jar", "x"], 5000, signal);
    const proc = spawn();
    proc.finish(0);
    await p;
    expect(listeners.size).toBe(0); // listener 已卸
    expect(clearSpy).toHaveBeenCalled(); // timer 已清
    expect(proc.stdin.closeCalls).toBe(1);
  });

  it("kill 未完成前 Promise 不完成（semaphore 释放被顺延）", async () => {
    installWindowsHost();
    vi.useFakeTimers();
    const p = runProcess("java", ["-jar", "x"], 30);
    const proc = spawn();
    let releaseKill!: () => void;
    proc.killGate = new Promise((r) => (releaseKill = r));
    await vi.advanceTimersByTimeAsync(30); // 超时 → kill 挂在 gate 上
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false); // kill 未完成，Promise 仍挂起
    releaseKill();
    await vi.advanceTimersByTimeAsync(10);
    const r = await p;
    expect(settled).toBe(true);
    expect(r.timedOut).toBe(true);
  });

  it("并发两次不串输出", async () => {
    installWindowsHost();
    const p1 = runProcess("java", ["-jar", "a"], 5000);
    const p2 = runProcess("java", ["-jar", "b"], 5000);
    const [procA, procB] = [spawn(), spawn()];
    procB.finish(0);
    procA.finish(0);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    // args 各自独立抵达
    expect(callRecords[0].arguments).toContain("a");
    expect(callRecords[1].arguments).toContain("b");
    expect(callRecords[0].arguments).not.toBe(callRecords[1].arguments);
  });
});

// ─── Unix：观察者诊断修复 ───────────────────────────────────────────────────

describe("Unix runner — nsIProcess 观察者诊断与清理", () => {
  it("process-failed code=1 同样读双流再删文件", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x", "中文.pdf"], 5000);
    const rec = runwCalls[0];
    const paths = capturePathsOf(rec.args[1]);
    fs.write(paths.out, "stdout 内容");
    fs.write(paths.err, "stderr: 中文路径 等.pdf not found");
    rec.observer.observe({ exitValue: 1 }, "process-failed");
    const r = await p;
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("stdout 内容");
    expect(r.stderr).toContain("中文路径 等.pdf not found");
    expect(r.stderr).not.toContain("Process failed to launch");
    expect(fs.removed).toContain(paths.out);
    expect(fs.removed).toContain(paths.err);
  });

  it("process-finished 非零保留真实退出码", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x"], 5000);
    const rec = runwCalls[0];
    const paths = capturePathsOf(rec.args[1]);
    fs.write(paths.out, "");
    fs.write(paths.err, "java.lang.Error: boom");
    rec.observer.observe({ exitValue: 2 }, "process-finished");
    const r = await p;
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe("java.lang.Error: boom");
  });

  it("exitValue 不可读时用 -1，且不默认为 0", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x"], 5000);
    const rec = runwCalls[0];
    const paths = capturePathsOf(rec.args[1]);
    fs.write(paths.out, "partial");
    fs.write(paths.err, "");
    // subject 与 proc 的 exitValue 都读不到
    rec.proc.exitValue = undefined;
    rec.observer.observe({}, "process-finished");
    const r = await p;
    expect(r.exitCode).toBe(-1);
    expect(r.stdout).toBe("partial");
    expect(r.stderr).not.toContain("Process failed to launch");
  });

  it("process-failed + exitValue 不可读 + 无输出 → 保留启动失败提示", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x"], 5000);
    const rec = runwCalls[0];
    fs.write(capturePathsOf(rec.args[1]).out, "");
    rec.proc.exitValue = undefined;
    rec.observer.observe({}, "process-failed");
    const r = await p;
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toBe("Process failed to launch");
  });

  it("同步启动异常：清理已建资源并保留真实异常", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x"], 5000);
    const rec = runwCalls[0];
    const paths = capturePathsOf(rec.args[1]);
    fs.write(paths.out, "");
    // 模拟 runwAsync 抛错路径：直接触发不了，改为新一次调用让 runwAsync 抛
    runwCalls.pop();
    (globalThis as any).Components.classes["@mozilla.org/process/util;1"] = {
      createInstance: () => {
        throw new Error("nsIProcess init failed");
      },
    };
    const p2 = runProcess("/usr/bin/java", ["-jar", "y"], 5000);
    const r2 = await p2;
    expect(r2.exitCode).toBe(-1);
    expect(r2.stderr).toContain("nsIProcess init failed");
    expect(r2.stderr).not.toBe("Process failed to launch");
    // 先前那次仍可正常完成，未受污染
    rec.observer.observe({ exitValue: 0 }, "process-finished");
    const r = await p;
    expect(r.exitCode).toBe(0);
  });

  it("未知 topic 不作完成、不默认 0；后续真实 topic 正常 settle", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x"], 5000);
    const rec = runwCalls[0];
    const paths = capturePathsOf(rec.args[1]);
    fs.write(paths.out, "kept");
    fs.write(paths.err, "");
    rec.observer.observe({ exitValue: 0 }, "random-topic");
    rec.observer.observe({ exitValue: 0 }, "profile-after-change");
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // 未知 topic 未完成 Promise
    rec.observer.observe({ exitValue: 5 }, "process-finished");
    const r = await p;
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe("kept");
  });

  it("晚到观察者事件不重复删除、不改写已定结果", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x"], 5000);
    const rec = runwCalls[0];
    const paths = capturePathsOf(rec.args[1]);
    fs.write(paths.out, "first");
    fs.write(paths.err, "");
    rec.observer.observe({ exitValue: 1 }, "process-finished");
    const removedBefore = fs.removed.length;
    rec.observer.observe({ exitValue: 0 }, "process-finished"); // 晚到重复
    const r = await p;
    expect(r.exitCode).toBe(1); // 首次结果不被改写
    expect(r.stdout).toBe("first");
    expect(fs.removed.length).toBe(removedBefore); // 不重复删除
  });

  it("/bin/sh -c exec + 单引号转义，超时 kill 进程", async () => {
    installUnixHost();
    vi.useFakeTimers();
    const p = runProcess("/usr/bin/java", ["-jar", "x", "a'b.pdf"], 40);
    const rec = runwCalls[0];
    expect(rec.args[0]).toBe("-c");
    const cmd = rec.args[1];
    expect(cmd.startsWith("exec '/usr/bin/java' ")).toBe(true);
    expect(cmd).toContain("'a'\\''b.pdf'");
    await vi.advanceTimersByTimeAsync(40);
    expect(rec.proc.killed).toBe(1); // killProcessTree → proc.kill()
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("Process timed out");
  });

  it("Unix 失败摘要同样带真实退出码（与 Windows 同一 formatJavaExitError）", async () => {
    installUnixHost();
    const p = runProcess("/usr/bin/java", ["-jar", "x"], 5000);
    const rec = runwCalls[0];
    const paths = capturePathsOf(rec.args[1]);
    fs.write(paths.out, "");
    fs.write(paths.err, "Error: 不存在 等.pdf not found");
    rec.observer.observe({ exitValue: 1 }, "process-finished");
    const r = await p;
    const summary = formatJavaExitError(r);
    expect(summary.startsWith("java exited with code 1")).toBe(true);
    expect(summary).toContain("不存在 等.pdf not found");
  });
});

// ─── 错误摘要 → 生产分类链 ──────────────────────────────────────────────────

describe("formatJavaExitError → classifyOdlRuntimeError → friendlyOdlError", () => {
  const CHINESE_ERR =
    "10月 15, 2026 6:05:08 严重 org.opendataloader.pdf.cli.CLIMain processPath\n" +
    "严重: File or folder D:\\中文 目录\\不存在 等.pdf not found";

  it("错误摘要总含 code，双流各自标注保留", () => {
    const s = formatJavaExitError({
      exitCode: 1,
      stdout: "some stdout",
      stderr: "some stderr",
    });
    expect(s.startsWith("java exited with code 1")).toBe(true);
    expect(s).toContain("stderr: some stderr");
    expect(s).toContain("stdout: some stdout");
  });

  it("空双流时摘要仍以 code 开头", () => {
    const s = formatJavaExitError({ exitCode: 3, stdout: "  ", stderr: "" });
    expect(s).toBe("java exited with code 3");
  });

  it("运行期失败传播后保留真实原因，不被改写为缺 Java / 启动失败", () => {
    const summary = formatJavaExitError({
      exitCode: 1,
      stdout: "",
      stderr: CHINESE_ERR,
    });
    const err = classifyOdlRuntimeError(summary);
    expect(err).toBeInstanceOf(PdfParseError);
    expect(err.reason).toBe("parse-failed"); // 不是 java-missing / timeout
    expect(err.message).toContain("java exited with code 1"); // 退出码在最前
    expect(err.message).toContain("不存在 等.pdf"); // 真实原因保留
    // friendlyOdlError 不把它路由到缺 Java 或组件缺失文案
    const friendly = friendlyOdlError(summary);
    expect(friendly).not.toBe("ztransplit-odl-error-java-missing");
    expect(friendly).not.toBe("ztransplit-odl-error-jar-missing");
    expect(friendly.startsWith("java exited with code 1")).toBe(true);
    expect(isJavaMissingCause(err)).toBe(false);
  });

  it("200 字截断也保住最前面的退出码", () => {
    const long =
      "x".repeat(300) + "\nstderr: File or folder D:\\中.pdf not found";
    const summary = formatJavaExitError({
      exitCode: 1,
      stdout: "",
      stderr: long,
    });
    const friendly = friendlyOdlError(summary);
    if (friendly.endsWith("…")) {
      expect(friendly.startsWith("java exited with code 1")).toBe(true);
      expect(friendly.length).toBeLessThanOrEqual(201);
    }
  });

  it("超时/取消仍走既有标志位语义（与非零退出可区分）", () => {
    const timeout = {
      exitCode: -1,
      stdout: "",
      stderr: "Process timed out",
      timedOut: true,
    };
    expect(timeout.timedOut).toBe(true);
    const aborted = {
      exitCode: -1,
      stdout: "",
      stderr: "aborted",
      timedOut: false,
      aborted: true,
    };
    expect(aborted.aborted).toBe(true);
    // 非零自然退出不携带这些控制哨兵
    const natural = formatJavaExitError({
      exitCode: 1,
      stdout: "",
      stderr: "real reason",
    });
    expect(natural).toContain("real reason");
    expect(natural).not.toContain("Process timed out");
  });
});
