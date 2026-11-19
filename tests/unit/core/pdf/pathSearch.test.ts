/**
 * pathSearch 测试（src/core/pdf/pathSearch.ts）。
 *
 * 这份模块的存在理由是一条真机实测：Gecko 的 Subprocess 不做 PATH 查找，按
 * 名字启动（command: "python"）会以 "File at path \"python\" does not exist,
 * or is not executable" 失败，哪怕 PATH 里就有那个可执行文件。因此这里钉住
 * 三件事：名字要解析成绝对路径、Windows 要补 .exe、不可执行的条目要跳过。
 *
 * 宿主边界用内存文件系统 + Components 桩覆盖（与 javaLocator 同一形状）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  findExecutableOnPath,
  findExecutablesOnPath,
  readEnvVar,
} from "../../../../src/core/pdf/pathSearch";

// ─── 内存虚拟文件系统 ────────────────────────────────────────────

interface VNode {
  children: Map<string, VNode>;
  isFile: boolean;
  executable: boolean;
}

function makeNode(): VNode {
  return { children: new Map(), isFile: false, executable: false };
}

class FakeFs {
  root: VNode = makeNode();

  addFile(path: string, opts: { executable?: boolean } = {}): void {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node.children.has(part)) node.children.set(part, makeNode());
      node = node.children.get(part)!;
      if (i === parts.length - 1) {
        node.isFile = true;
        node.executable = opts.executable !== false;
      }
    }
  }

  /** 添加一个空目录（验证"拼出来是目录"要跳过）。 */
  addDir(path: string): void {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    let node = this.root;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, makeNode());
      node = node.children.get(part)!;
    }
  }

  private resolve(path: string): VNode | null {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    let node: VNode | undefined = this.root;
    for (const part of parts) {
      node = node?.children.get(part);
      if (!node) return null;
    }
    return node ?? null;
  }

  exists(path: string): boolean {
    return this.resolve(path) !== null;
  }

  isDirectory(path: string): boolean {
    const node = this.resolve(path);
    return !!node && !node.isFile;
  }

  isExecutable(path: string): boolean {
    const node = this.resolve(path);
    return !!node && node.isFile && node.executable;
  }
}

// ─── 宿主桩 ──────────────────────────────────────────────────────

let fs: FakeFs;
let env: Record<string, string>;
let platform: "win" | "mac" | "linux";

function makeFakeFile() {
  return {
    path: "",
    initWithPath(this: any, p: string) {
      this.path = p;
    },
    exists(this: any) {
      return fs.exists(this.path);
    },
    isDirectory(this: any) {
      return fs.isDirectory(this.path);
    },
    isExecutable(this: any) {
      return fs.isExecutable(this.path);
    },
    QueryInterface(this: any) {
      return this;
    },
  };
}

function setPlatform(p: "win" | "mac" | "linux"): void {
  platform = p;
  buildGlobals();
}

function buildGlobals(): void {
  (globalThis as any).Components = {
    classes: {
      "@mozilla.org/file/local;1": { createInstance: () => makeFakeFile() },
      "@mozilla.org/process/environment;1": {
        getService: () => ({ get: (name: string) => env[name] }),
      },
    },
    interfaces: {
      nsIFile: { name: "nsIFile" },
      nsIEnvironment: { name: "nsIEnvironment" },
    },
  };
  (globalThis as any).Zotero = {
    isWin: platform === "win",
    isMac: platform === "mac",
    platform:
      platform === "win" ? "win32" : platform === "mac" ? "macosx" : "linux",
  };
}

const saved: Record<string, unknown> = {};

beforeEach(() => {
  fs = new FakeFs();
  env = {};
  platform = "win";
  for (const k of ["Components", "Zotero"]) saved[k] = (globalThis as any)[k];
  buildGlobals();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete (globalThis as any)[k];
    else (globalThis as any)[k] = v;
  }
});

// ─── Windows ─────────────────────────────────────────────────────

describe("pathSearch：Windows", () => {
  beforeEach(() => {
    setPlatform("win");
  });

  it("按名字找到绝对路径，并补上 .exe（PATH 条目里只有目录）", () => {
    fs.addFile("C:\\Python313\\python.exe");
    env.PATH = "C:\\Windows\\system32;C:\\Python313";
    expect(findExecutableOnPath("python")).toBe("C:\\Python313\\python.exe");
  });

  it("PATH 顺序决定优先级：前面的先返回", () => {
    fs.addFile("D:\\py-a\\python.exe");
    fs.addFile("D:\\py-b\\python.exe");
    env.PATH = "D:\\py-a;D:\\py-b";
    expect(findExecutablesOnPath("python")).toEqual([
      "D:\\py-a\\python.exe",
      "D:\\py-b\\python.exe",
    ]);
    expect(findExecutableOnPath("python")).toBe("D:\\py-a\\python.exe");
  });

  it("条目带末尾斜杠与空白也能拼对（PATH 里这种写法很常见）", () => {
    fs.addFile("C:\\tools\\bin\\java.exe");
    env.PATH = " C:\\tools\\bin\\ ;C:\\other";
    expect(findExecutableOnPath("java")).toBe("C:\\tools\\bin\\java.exe");
  });

  it("文件在但没有执行位：不算可执行", () => {
    fs.addFile("C:\\Python313\\python.exe", { executable: false });
    env.PATH = "C:\\Python313";
    expect(findExecutableOnPath("python")).toBeNull();
  });

  it("拼出来的路径是个目录：不算可执行文件", () => {
    // PATH 条目 + 名字拼出来的是目录时（罕见但会发生），必须跳过而不是把它
    // 当解释器返回——返回一个目录会让后续启动失败在更难查的地方。
    fs.addDir("C:\\tools\\python.exe");
    fs.addFile("C:\\tools\\bin\\python.exe");
    env.PATH = "C:\\tools;C:\\tools\\bin";
    expect(findExecutableOnPath("python")).toBe("C:\\tools\\bin\\python.exe");
  });

  it("PATH 里没有：返回 null（调用方据此改装自带的运行时）", () => {
    env.PATH = "C:\\Windows\\system32";
    expect(findExecutableOnPath("python")).toBeNull();
  });

  it("PATH 为空或不设：安静返回 null，不抛", () => {
    env.PATH = "";
    expect(findExecutableOnPath("python")).toBeNull();
    delete env.PATH;
    expect(findExecutableOnPath("python")).toBeNull();
  });

  it("重复条目只返回一次", () => {
    fs.addFile("D:\\py\\python.exe");
    env.PATH = "D:\\py;D:\\py;D:\\py";
    expect(findExecutablesOnPath("python")).toEqual(["D:\\py\\python.exe"]);
  });
});

// ─── Unix ────────────────────────────────────────────────────────

describe("pathSearch：Unix", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  it("冒号分隔、不加扩展名", () => {
    fs.addFile("/usr/local/bin/python3");
    env.PATH = "/usr/bin:/usr/local/bin";
    expect(findExecutableOnPath("python3")).toBe("/usr/local/bin/python3");
  });

  it("可执行位缺失：跳过", () => {
    fs.addFile("/usr/bin/python3", { executable: false });
    env.PATH = "/usr/bin";
    expect(findExecutableOnPath("python3")).toBeNull();
  });

  it("多个命中按 PATH 顺序全部返回", () => {
    fs.addFile("/opt/py/bin/python3");
    fs.addFile("/usr/bin/python3");
    env.PATH = "/opt/py/bin:/usr/bin";
    expect(findExecutablesOnPath("python3")).toEqual([
      "/opt/py/bin/python3",
      "/usr/bin/python3",
    ]);
  });
});

// ─── readEnvVar ──────────────────────────────────────────────────

describe("readEnvVar", () => {
  it("读到即返回，未设返回 undefined", () => {
    env.PATH = "C:\\bin";
    expect(readEnvVar("PATH")).toBe("C:\\bin");
    expect(readEnvVar("NOPE")).toBeUndefined();
  });

  it("宿主不可用：返回 undefined，不抛", () => {
    delete (globalThis as any).Components;
    expect(readEnvVar("PATH")).toBeUndefined();
  });
});
