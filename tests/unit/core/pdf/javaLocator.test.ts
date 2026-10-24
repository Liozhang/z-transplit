/**
 * javaLocator 测试（src/core/pdf/javaLocator.ts）。
 *
 * 该模块与 Zotero 宿主耦合（nsIFile 目录枚举 / nsIEnvironment），在 Node 下用
 * 内存虚拟文件系统 + 宿主桩覆盖。重点验证三类历史上真实发生过的漏判：
 *
 *   1. Windows：Temurin 版本化安装目录（jdk-17.0.20.1-hotspot）能被枚举到，
 *      不再依赖硬编码的无版本号 jdk-17。
 *   2. macOS：/usr/bin/java 存根排在所有真实 JDK 位置之后；只有连存根都没有
 *      时才返回 null。
 *   3. JAVA_HOME 设了就一定最先被读到（包括末尾带斜杠的写法），指向无效目录
 *      时安静跳过并继续找下一个来源。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findJavaCandidates, resolveJavaExecutable } from "../../../../src/core/pdf/javaLocator";

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

  /** 添加一个空目录（用于验证 enumeration 跳过纯文件条目）。 */
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

  childNames(path: string): string[] {
    const node = this.resolve(path);
    return node ? [...node.children.keys()] : [];
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
    get leafName(this: any): string {
      const parts = this.path.split(/[\\/]+/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : "";
    },
    QueryInterface(this: any) {
      return this;
    },
    get directoryEntries(this: any) {
      const self = this;
      const names = fs.childNames(self.path);
      let index = 0;
      const lastSeparator = /[\\/](?=[^\\/]*$)/.exec(self.path);
      const separator = lastSeparator ? lastSeparator[0] : "/";
      return {
        hasMoreElements: () => index < names.length,
        getNext: () => {
          const name = names[index++];
          const child = makeFakeFile();
          child.initWithPath(self.path.replace(/[\\/]+$/, "") + separator + name);
          return child;
        },
      };
    },
  };
}

function buildGlobals(): void {
  const Ci: any = {
    nsIFile: { name: "nsIFile" },
    nsIEnvironment: { name: "nsIEnvironment" },
  };
  (globalThis as any).Components = {
    classes: {
      "@mozilla.org/file/local;1": { createInstance: () => makeFakeFile() },
      "@mozilla.org/process/environment;1": {
        getService: () => ({ get: (name: string) => env[name] ?? "" }),
      },
    },
    interfaces: Ci,
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

describe("javaLocator：Windows", () => {
  const PF = "C:\\Program Files";

  beforeEach(() => {
    platform = "win";
    env = { ProgramFiles: PF, LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" };
  });

  it("JAVA_HOME 优先于 PATH，末尾带斜杠也能拼对", () => {
    fs.addFile("D:\\jdk-21\\bin\\java.exe");
    fs.addFile("C:\\tools\\java-home\\bin\\java.exe");
    env.JAVA_HOME = "C:\\tools\\java-home\\";
    env.PATH = "D:\\jdk-21\\bin";

    expect(resolveJavaExecutable()).toBe("C:\\tools\\java-home\\bin\\java.exe");
  });

  it("枚举到 Temurin 版本化安装目录（硬编码 jdk-17 匹配不到的那一种）", () => {
    fs.addFile(`${PF}\\Eclipse Adoptium\\jdk-17.0.20.1-hotspot\\bin\\java.exe`);

    expect(resolveJavaExecutable()).toBe(
      `${PF}\\Eclipse Adoptium\\jdk-17.0.20.1-hotspot\\bin\\java.exe`,
    );
  });

  it("Android Studio 内置 jbr 也能找到", () => {
    fs.addFile(`${PF}\\Android\\Android Studio\\jbr\\bin\\java.exe`);

    expect(resolveJavaExecutable()).toBe(
      `${PF}\\Android\\Android Studio\\jbr\\bin\\java.exe`,
    );
  });

  it("Microsoft / Corretto / Zulu 的目录布局同样覆盖", () => {
    fs.addFile(`${PF}\\Microsoft\\jdk-17.0.5.11-hotspot\\bin\\java.exe`);
    expect(resolveJavaExecutable()).toBe(
      `${PF}\\Microsoft\\jdk-17.0.5.11-hotspot\\bin\\java.exe`,
    );

    fs = new FakeFs();
    fs.addFile(`${PF}\\Amazon Corretto\\jdk17.0.5_8\\bin\\java.exe`);
    expect(resolveJavaExecutable()).toBe(`${PF}\\Amazon Corretto\\jdk17.0.5_8\\bin\\java.exe`);

    fs = new FakeFs();
    fs.addFile(`${PF}\\Zulu\\zulu-17\\bin\\java.exe`);
    expect(resolveJavaExecutable()).toBe(`${PF}\\Zulu\\zulu-17\\bin\\java.exe`);
  });

  it("JAVA_HOME 指向无效目录时安静跳过，继续找下一个来源", () => {
    fs.addFile("C:\\portable-jdk\\bin\\java.exe");
    env.JAVA_HOME = "C:\\does\\not\\exist";
    env.PATH = "C:\\portable-jdk\\bin";

    expect(resolveJavaExecutable()).toBe("C:\\portable-jdk\\bin\\java.exe");
  });

  it("多个来源同时存在时，顺序为 JAVA_HOME → 安装目录 → PATH", () => {
    fs.addFile(`${PF}\\Eclipse Adoptium\\jdk-17.0.20.1-hotspot\\bin\\java.exe`);
    fs.addFile(`${PF}\\Android\\Android Studio\\jbr\\bin\\java.exe`);
    fs.addFile("C:\\portable-jdk\\bin\\java.exe");
    env.JAVA_HOME = "C:\\portable-jdk";
    env.PATH = "C:\\portable-jdk\\bin";

    const candidates = findJavaCandidates();
    expect(candidates).toEqual([
      "C:\\portable-jdk\\bin\\java.exe",
      `${PF}\\Eclipse Adoptium\\jdk-17.0.20.1-hotspot\\bin\\java.exe`,
      `${PF}\\Android\\Android Studio\\jbr\\bin\\java.exe`,
    ]);
  });

  it("PATH 条目带末尾反斜杠不产出双斜杠路径", () => {
    fs.addFile("C:\\jdk\\bin\\java.exe");
    env.PATH = "C:\\jdk\\bin\\;C:\\other";

    expect(resolveJavaExecutable()).toBe("C:\\jdk\\bin\\java.exe");
  });

  it("到处都没有 java 时返回 null", () => {
    env.PATH = "C:\\windows\\system32";
    expect(resolveJavaExecutable()).toBeNull();
    expect(findJavaCandidates()).toEqual([]);
  });

  it("枚举时跳过文件条目，只收目录", () => {
    fs.addFile(`${PF}\\Java\\readme.txt`);
    fs.addFile(`${PF}\\Java\\jdk-17\\bin\\java.exe`);

    expect(resolveJavaExecutable()).toBe(`${PF}\\Java\\jdk-17\\bin\\java.exe`);
  });
});

// ─── macOS ───────────────────────────────────────────────────────

describe("javaLocator：macOS", () => {
  beforeEach(() => {
    platform = "mac";
    env = { HOME: "/Users/alice", PATH: "/usr/bin:/bin" };
    // 外层 beforeEach 已按默认平台（win）建过一次宿主桩，改平台后必须重建，
    // 否则 isWindows()/isMac() 读到的还是旧值。
    buildGlobals();
  });

  it("真实 JDK 优先于 /usr/bin/java 存根", () => {
    fs.addFile("/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java");
    fs.addFile("/usr/bin/java"); // 系统存根：没装 JDK 时也"存在且可执行"

    expect(resolveJavaExecutable()).toBe(
      "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java",
    );
  });

  it("只有存根时返回存根（探测失败由调用方处理）", () => {
    fs.addFile("/usr/bin/java");

    expect(resolveJavaExecutable()).toBe("/usr/bin/java");
  });

  it("Android Studio 内置 jbr 能找到，且优先于 Homebrew 与存根", () => {
    fs.addFile("/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java");
    fs.addFile("/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin/java");
    fs.addFile("/usr/bin/java");

    expect(resolveJavaExecutable()).toBe(
      "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java",
    );
  });

  it("用户目录下的 Android Studio（~/Applications）也覆盖", () => {
    fs.addFile("/Users/alice/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java");

    expect(resolveJavaExecutable()).toBe(
      "/Users/alice/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java",
    );
  });

  it("Homebrew openjdk（Apple Silicon 与 Intel 两个前缀）都能找到", () => {
    fs.addFile("/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin/java");
    expect(resolveJavaExecutable()).toBe(
      "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin/java",
    );

    fs = new FakeFs();
    fs.addFile("/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java");
    expect(resolveJavaExecutable()).toBe(
      "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java",
    );
  });

  it("JAVA_HOME 在 macOS 同样最优先", () => {
    fs.addFile("/Users/alice/jdk/bin/java");
    fs.addFile("/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java");
    env.JAVA_HOME = "/Users/alice/jdk";

    expect(resolveJavaExecutable()).toBe("/Users/alice/jdk/bin/java");
  });

  it("PATH 里的 java 作为最后兜底", () => {
    fs.addFile("/opt/custom/java/bin/java");
    env.PATH = "/opt/custom/java/bin:/usr/bin";

    expect(resolveJavaExecutable()).toBe("/opt/custom/java/bin/java");
  });
});

describe("javaLocator：Linux", () => {
  beforeEach(() => {
    platform = "linux";
    // 否则 isWindows()/isMac() 读到的还是旧值。
    buildGlobals();
  });

  it("枚举 /usr/lib/jvm 下的发行版 JDK（目录名不可预测，只能枚举）", () => {
    fs.addFile("/usr/lib/jvm/java-17-openjdk-amd64/bin/java");
    fs.addFile("/usr/lib/jvm/temurin-17-jdk-aarch64/bin/java");

    const candidates = findJavaCandidates();
    expect(candidates).toContain("/usr/lib/jvm/java-17-openjdk-amd64/bin/java");
    expect(candidates).toContain("/usr/lib/jvm/temurin-17-jdk-aarch64/bin/java");
  });

  it("/usr/bin/java（真实可执行文件）在枚举位置之后兜底", () => {
    fs.addFile("/usr/lib/jvm/java-17-openjdk/bin/java");
    fs.addFile("/usr/bin/java");

    const candidates = findJavaCandidates();
    expect(candidates.indexOf("/usr/lib/jvm/java-17-openjdk/bin/java")).toBeLessThan(
      candidates.indexOf("/usr/bin/java"),
    );
  });

  it("只有 /usr/bin/java 时也能找到（Linux 上它不是存根）", () => {
    fs.addFile("/usr/bin/java");
    expect(resolveJavaExecutable()).toBe("/usr/bin/java");
  });

  it("JAVA_HOME 在 Linux 同样最优先", () => {
    fs.addFile("/opt/jdk/bin/java");
    fs.addFile("/usr/bin/java");
    env.JAVA_HOME = "/opt/jdk";

    expect(resolveJavaExecutable()).toBe("/opt/jdk/bin/java");
  });
});
