/**
 * OdlJarDownloader — 按指纹从镜像下载解析组件（src/core/pdf/OdlJarDownloader.ts）。
 *
 * 伪造宿主边界（内存文件系统、假 nsIZipReader、假 Zotero.HTTP），覆盖：
 *   1. 来源表与条目匹配、探测排序（纯函数）。
 *   2. 择优：并发探测后从最快镜像整包下载。
 *   3. 降级：最快来源的 jar 校验和不符时自动换下一个。
 *   4. 已落地副本指纹相符：零网络请求直接复用。
 *   5. 全部镜像不可达 / 缺指纹：拒绝并给出明确错误。
 *   6. getJarPath 端到端（精简版打包安装）：XPI 无内置 jar → 下载兜底生效，
 *      会话备忘命中；下载失败时回退原路径且会话内不再重试。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildSources,
  jarEntryMatches,
  rankSources,
  downloadPinnedJar,
  type PinnedJarMeta,
} from "../../../../src/core/pdf/OdlJarDownloader";
import { getJarPath } from "../../../../src/core/pdf/OpenDataLoaderPdfClient";

// ─── 内存文件系统（IOUtils 语义子集，Windows 分隔符）──────────────

class FakeFS {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();

  private registerAncestors(p: string): void {
    let idx = p.length;
    while ((idx = p.lastIndexOf("\\", idx - 1)) > 0) {
      this.dirs.add(p.slice(0, idx));
    }
  }
  exists(p: string): boolean {
    return this.files.has(p) || this.dirs.has(p);
  }
  isFile(p: string): boolean {
    return this.files.has(p);
  }
  isDirectory(p: string): boolean {
    return this.dirs.has(p);
  }
  read(p: string): Uint8Array {
    const v = this.files.get(p);
    if (v === undefined) throw new Error("NoSuchFile: " + p);
    return v;
  }
  readUTF8(p: string): string {
    return new TextDecoder().decode(this.read(p));
  }
  write(p: string, data: Uint8Array): void {
    this.files.set(p, data);
    this.registerAncestors(p);
  }
  remove(p: string, opts: { ignoreAbsent?: boolean } = {}): void {
    if (this.files.has(p)) {
      this.files.delete(p);
      return;
    }
    if (this.dirs.has(p)) {
      for (const q of [...this.files.keys()]) {
        if (q.startsWith(p + "\\")) this.files.delete(q);
      }
      for (const q of [...this.dirs]) {
        if (q.startsWith(p + "\\")) this.dirs.delete(q);
      }
      this.dirs.delete(p);
      return;
    }
    if (!opts.ignoreAbsent) throw new Error("NoSuchFile: " + p);
  }
  move(src: string, dest: string): void {
    if (!this.exists(src)) throw new Error("NoSuchFile: " + src);
    if (this.exists(dest)) throw new Error("DestinationExists: " + dest);
    this.files.set(dest, this.files.get(src)!);
    this.files.delete(src);
    this.registerAncestors(dest);
  }
  makeDirectory(p: string, opts: { createAncestors?: boolean } = {}): void {
    if (this.dirs.has(p)) return;
    if (this.files.has(p)) throw new Error("FileExists: " + p);
    this.dirs.add(p);
    if (opts.createAncestors) this.registerAncestors(p);
  }
  getChildren(dir: string): string[] {
    const prefix = dir.endsWith("\\") ? dir : dir + "\\";
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (!p.startsWith(prefix)) continue;
      const first = p.slice(prefix.length).split("\\")[0];
      if (first) names.add(prefix + first);
    }
    return [...names];
  }
}

// ─── 夹具与宿主桩 ────────────────────────────────────────────────

const DATA_DIR = "D:\\ZoteroData";
const LIB_DIR = DATA_DIR + "\\ztransplit\\lib";
const PROFILE = "C:\\Users\\tester\\profile";
const EXT_DIR = PROFILE + "\\extensions";
const XPI_PATH = EXT_DIR + "\\ztransplit@zotero.org.xpi";
const ADDON_ID = "ztransplit@zotero.org";
const TMP_DIR = "C:\\Temp";

const INNER_JAR = new Uint8Array([0x50, 0x4b, 9, 9, 1, 2, 3, 4]);
const OTHER_JAR = new Uint8Array([7, 7, 7, 7]);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

// 内容无关紧要——假 zip 读的是登记条目，不是压缩包字节
const WHEEL_BYTES = new Uint8Array([0x50, 0x4b, 3, 3, 3, 3]);

const META: PinnedJarMeta = {
  file: "opendataloader-pdf-cli.jar",
  artifact: "org.opendataloader:opendataloader-pdf-cli:2.5.0",
  version: "2.5.0",
  sha256: sha256(INNER_JAR),
  bytes: INNER_JAR.byteLength,
};

interface ZipRecord {
  entries: Map<string, Uint8Array>;
  opens: number;
}
const zipRegistry = new Map<string, ZipRecord>();
/** 暂存压缩包文件名含随机数，注册表未命中时按队列依次弹出。 */
let defaultZipRecords: ZipRecord[];

let fs: FakeFS;
let extEntries: any[];
let httpCalls: Array<{ url: string; kind: "probe" | "download" }>;
let loggedErrors: string[];

interface HttpRoute {
  match: (url: string, kind: "probe" | "download") => boolean;
  respond: (url: string, kind: "probe" | "download") => Promise<any> | any;
}
let httpRoutes: HttpRoute[];

function zipRecordFor(xpiPath: string): ZipRecord {
  let rec = zipRegistry.get(xpiPath);
  if (!rec) {
    rec = { entries: new Map(), opens: 0 };
    zipRegistry.set(xpiPath, rec);
  }
  return rec;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeNsIFile(initial = ""): any {
  const file = {
    path: initial,
    initWithPath(p: string) {
      this.path = p;
    },
    exists() {
      return fs.exists(this.path);
    },
    isFile() {
      return fs.isFile(this.path);
    },
    isDirectory() {
      return fs.isDirectory(this.path);
    },
    // readZipEntryText 的临时文件用法：clone → append → extract → remove。
    clone() {
      return makeFakeNsIFile(this.path);
    },
    append(name: string) {
      this.path = this.path ? this.path + "\\" + name : name;
    },
    remove() {
      fs.remove(this.path);
    },
    QueryInterface() {
      return file;
    },
  };
  return file;
}

function makeExtEntry(leafName: string, kind: "file" | "dir"): any {
  const p = EXT_DIR + "\\" + leafName;
  const entry: any = {
    leafName,
    path: p,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    QueryInterface() {
      return entry;
    },
  };
  return entry;
}

function makeEnumerator(items: any[]): any {
  let i = 0;
  return {
    hasMoreElements: () => i < items.length,
    getNext: () => items[i++],
  };
}

function makeZipReader(): any {
  return {
    _rec: null as ZipRecord | null,
    open(f: any) {
      const rec = zipRegistry.get(f.path) ?? defaultZipRecords.shift();
      if (!rec) throw new Error("cannot open zip: " + f.path);
      this._rec = rec;
      rec.opens++;
    },
    hasEntry(e: string) {
      return !!this._rec?.entries.has(e);
    },
    getEntry(e: string) {
      if (!this._rec?.entries.has(e)) throw new Error("no entry: " + e);
      return { name: e };
    },
    // 真实宿主（Gecko 140）的 nsIZipReader 没有 getEntries()：条目枚举只有
    // findEntries(pattern)，返回 hasMore()/getNext() 迭代器，getNext 给出
    // 条目名字符串。
    findEntries(_pattern: string) {
      const names = [...(this._rec?.entries.keys() ?? [])];
      let i = 0;
      return {
        hasMore: () => i < names.length,
        getNext: () => names[i++],
      };
    },
    // extract(entry, nsIFile)：把条目字节直接写到目标路径。
    extract(e: string, f: any) {
      const bytes = this._rec?.entries.get(e);
      if (!bytes) throw new Error("no entry: " + e);
      fs.write(f.path, bytes);
    },
    close() {},
  };
}

function buildGlobals(): void {
  const fakeComponents: any = {
    classes: {
      "@mozilla.org/file/local;1": { createInstance: () => makeFakeNsIFile() },
      "@mozilla.org/libjar/zip-reader;1": {
        createInstance: () => makeZipReader(),
      },
      "@mozilla.org/file/directory_service;1": {
        getService: () => ({
          get(name: string) {
            if (name !== "ProfD") throw new Error("unknown dir: " + name);
            return {
              path: PROFILE,
              clone() {
                return {
                  path: PROFILE,
                  append(n: string) {
                    this.path += "\\" + n;
                  },
                  exists: () => true,
                  isDirectory: () => true,
                  get directoryEntries() {
                    return makeEnumerator(extEntries);
                  },
                };
              },
            };
          },
        }),
      },
    },
    interfaces: {
      nsIFile: {},
      nsIZipReader: {},
      nsIBinaryInputStream: {},
      nsISupportsCString: {},
      nsIProperties: {},
      nsIFileURL: {},
    },
    results: { NS_NOINTERFACE: 0x80004002 },
  };

  (globalThis as any).Components = fakeComponents;
  (globalThis as any).IOUtils = {
    exists: async (p: string) => fs.exists(p),
    read: async (p: string) => fs.read(p),
    readUTF8: async (p: string) => fs.readUTF8(p),
    write: async (p: string, data: Uint8Array) => fs.write(p, data),
    remove: async (p: string, opts?: any) => fs.remove(p, opts),
    move: async (s: string, d: string) => fs.move(s, d),
    makeDirectory: async (p: string, opts?: any) => fs.makeDirectory(p, opts),
    getChildren: async (p: string) => fs.getChildren(p),
    setPermissions: async () => {},
  };
  (globalThis as any).PathUtils = {
    join: (...p: string[]) => path.win32.join(...p),
  };
  (globalThis as any).Zotero = {
    isWin: true,
    DataDirectory: { dir: DATA_DIR },
    logError: (e: unknown) => loggedErrors.push(String(e)),
    // readZipEntryText 把 zip 内小条目解到临时目录后按文本读回。
    getTempDirectory: () => makeFakeNsIFile(TMP_DIR),
    File: {
      getContents: (f: any) => new TextDecoder().decode(fs.read(f.path)),
    },
    getMainWindow: () => null,
    ProgressWindow: class {
      descriptions: string[] = [];
      changeHeadline() {}
      addDescription(d: string) {
        this.descriptions.push(d);
      }
      show() {}
      startCloseTimer() {}
    },
    HTTP: {
      async request(_m: string, url: string, opts: any = {}) {
        const kind: "probe" | "download" =
          opts.responseType === "arraybuffer" ? "download" : "probe";
        httpCalls.push({ url, kind });
        const route = httpRoutes.find((r) => r.match(url, kind));
        if (!route) throw new Error("no route: " + url);
        return await route.respond(url, kind);
      },
    },
  };
}

const GLOBAL_KEYS = ["Components", "IOUtils", "PathUtils", "Zotero"] as const;
let savedGlobals: Record<string, unknown> = {};

beforeEach(() => {
  fs = new FakeFS();
  zipRegistry.clear();
  defaultZipRecords = [];
  extEntries = [];
  httpCalls = [];
  httpRoutes = [];
  loggedErrors = [];
  savedGlobals = {};
  for (const k of GLOBAL_KEYS) {
    savedGlobals[k] = (globalThis as any)[k];
  }
  buildGlobals();
});

afterEach(() => {
  for (const k of GLOBAL_KEYS) {
    if (savedGlobals[k] === undefined) {
      delete (globalThis as any)[k];
    } else {
      (globalThis as any)[k] = savedGlobals[k];
    }
  }
});

// ─── 纯函数 ──────────────────────────────────────────────────────

describe("buildSources", () => {
  it("已登记版本返回镜像优先的来源表", () => {
    const sources = buildSources(META);
    // 与 PYPI_MIRRORS 一字不差：五家国内镜像在前，PyPI 官方殿后
    expect(sources.map((s) => s.id)).toEqual([
      "aliyun-pypi",
      "tuna-pypi",
      "tencent-pypi",
      "huawei-pypi",
      "ustc-pypi",
      "pypi",
      "github-release",
    ]);
    expect(sources[0].url).toContain("/packages/b1/78/c2e5aab0ad");
    expect(sources[0].url).toContain("opendataloader_pdf-2.5.0-py3-none-any.whl");
    // 六家镜像都沿用同一套内容寻址路径（PyPI 同路径布局）
    for (const s of sources.filter((x) => x.id !== "github-release")) {
      expect(s.url).toContain("/packages/b1/78/c2e5aab0ad");
      expect(s.url).toContain("opendataloader_pdf-2.5.0-py3-none-any.whl");
    }
  });

  it("未登记哈希路径的版本只保留 GitHub 来源", () => {
    const sources = buildSources({ ...META, version: "9.9.9" });
    expect(sources.map((s) => s.id)).toEqual(["github-release"]);
  });

  it("非 opendataloader 构件没有公开来源", () => {
    expect(buildSources({ ...META, artifact: "org.ztransplit:region-text-remover:1.0.0" })).toEqual(
      [],
    );
  });
});

describe("jarEntryMatches", () => {
  it("接受轮子内固定路径与带版本后缀的条目名", () => {
    expect(jarEntryMatches("opendataloader_pdf/jar/opendataloader-pdf-cli.jar", META)).toBe(
      true,
    );
    expect(jarEntryMatches("cli/opendataloader-pdf-cli-2.5.0.jar", META)).toBe(true);
    expect(jarEntryMatches("cli/other.jar", META)).toBe(false);
  });
});

describe("rankSources", () => {
  it("按耗时升序并丢弃不可达来源", () => {
    const ranked = rankSources([
      { source: { id: "a", url: "a" }, ms: Number.POSITIVE_INFINITY },
      { source: { id: "b", url: "b" }, ms: 300 },
      { source: { id: "c", url: "c" }, ms: 50 },
    ]);
    expect(ranked.map((s) => s.id)).toEqual(["c", "b"]);
  });
});

// ─── downloadPinnedJar（伪造宿主边界）────────────────────────────

describe("downloadPinnedJar", () => {
  const paths = { dir: LIB_DIR, target: LIB_DIR + "\\opendataloader-pdf-cli.jar" };

  /** URL → 来源 id，覆盖 PYPI_MIRRORS 全部六项。 */
  const MIRROR_URL_MATCHERS: Array<[string, string]> = [
    ["mirrors.aliyun.com", "aliyun-pypi"],
    ["tuna.tsinghua.edu.cn", "tuna-pypi"],
    ["mirrors.cloud.tencent.com", "tencent-pypi"],
    ["mirrors.huaweicloud.com", "huawei-pypi"],
    ["mirrors.ustc.edu.cn", "ustc-pypi"],
    ["files.pythonhosted.org", "pypi"],
  ];
  /** 新增三家镜像未显式指定时的默认耗时：慢于阿里云，快于 PyPI 官方。 */
  const NEW_MIRROR_DEFAULT_MS: Record<string, number> = {
    "tencent-pypi": 120,
    "huawei-pypi": 140,
    "ustc-pypi": 160,
  };

  function sourceIdOf(url: string): string {
    for (const [needle, id] of MIRROR_URL_MATCHERS) {
      if (url.includes(needle)) return id;
    }
    return "github-release";
  }

  function installMirrorRoutes(opts: {
    aliyun?: number | null; // 探测耗时毫秒；null = 不可达
    tuna?: number | null;
    tencent?: number | null;
    huawei?: number | null;
    ustc?: number | null;
    pypi?: number | null;
    /** 按来源 id 给出整包下载的字节（缺省 = 正确轮子）。 */
    archiveFor?: (id: string) => Uint8Array | null;
  }): void {
    const delayOf = (id: string): number | null => {
      const explicit = (opts as Record<string, number | null | undefined>)[
        id === "pypi"
          ? "pypi"
          : id.replace("-pypi", "")
      ];
      if (explicit !== undefined) return explicit;
      return NEW_MIRROR_DEFAULT_MS[id] ?? null;
    };
    httpRoutes.push({
      match: (_url, kind) => kind === "probe",
      respond: async (url) => {
        const id = sourceIdOf(url);
        const delay = delayOf(id);
        if (delay == null) throw new Error("unreachable: " + id);
        await sleep(delay);
        return { status: 206, response: "" };
      },
    });
    httpRoutes.push({
      match: (_url, kind) => kind === "download",
      respond: (url) => {
        const id = sourceIdOf(url);
        const bytes = opts.archiveFor?.(id) ?? WHEEL_BYTES;
        if (!bytes) throw new Error("download failed: " + id);
        return { status: 200, response: bytes.buffer };
      },
    });
  }

  it("并发探测后从最快镜像下载并落地", async () => {
    installMirrorRoutes({ aliyun: 5, tuna: 300, pypi: 150 });
    defaultZipRecords = [
      {
        entries: new Map([["opendataloader_pdf/jar/opendataloader-pdf-cli.jar", INNER_JAR]]),
        opens: 0,
      },
    ];
    const out = await downloadPinnedJar(META, paths);
    expect(out).toBe(paths.target);
    expect([...fs.read(paths.target)]).toEqual([...INNER_JAR]);
    const downloads = httpCalls.filter((c) => c.kind === "download");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].url).toContain("mirrors.aliyun.com");
    // 暂存压缩包与暂存 jar 均已清理
    for (const child of fs.getChildren(LIB_DIR)) {
      expect(child.startsWith(LIB_DIR + "\\.download-")).toBe(false);
      expect(child.includes(".staging-")).toBe(false);
    }
  });

  it("最快来源校验和不符时自动降级到下一个", async () => {
    installMirrorRoutes({ aliyun: 5, tuna: 300, pypi: 150 });
    // 第一个被打开的暂存压缩包里装着坏 jar，第二个装好 jar
    const badRecord: ZipRecord = {
      entries: new Map([["opendataloader_pdf/jar/opendataloader-pdf-cli.jar", OTHER_JAR]]),
      opens: 0,
    };
    const goodRecord: ZipRecord = {
      entries: new Map([["opendataloader_pdf/jar/opendataloader-pdf-cli.jar", INNER_JAR]]),
      opens: 0,
    };
    defaultZipRecords = [badRecord, goodRecord];

    const out = await downloadPinnedJar(META, paths);

    expect(out).toBe(paths.target);
    expect([...fs.read(paths.target)]).toEqual([...INNER_JAR]);
    const downloads = httpCalls.filter((c) => c.kind === "download");
    expect(downloads).toHaveLength(2);
    expect(downloads[0].url).toContain("mirrors.aliyun.com");
  });

  it("阿里云与清华不可达：自动改从腾讯云镜像取件", async () => {
    // 前两家国内镜像探测失败，第三家（腾讯云）120ms 胜出
    installMirrorRoutes({ aliyun: null, tuna: null, pypi: 400 });
    defaultZipRecords = [
      {
        entries: new Map([["opendataloader_pdf/jar/opendataloader-pdf-cli.jar", INNER_JAR]]),
        opens: 0,
      },
    ];

    const out = await downloadPinnedJar(META, paths);

    expect(out).toBe(paths.target);
    expect([...fs.read(paths.target)]).toEqual([...INNER_JAR]);
    const downloads = httpCalls.filter((c) => c.kind === "download");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].url).toContain("mirrors.cloud.tencent.com");
  });

  it("六家镜像全部可达：按探测延迟排序，最慢的官方 PyPI 不被使用", async () => {
    installMirrorRoutes({
      aliyun: 300,
      tuna: 260,
      tencent: 200,
      huawei: 180,
      ustc: 5, // 中科大最快
      pypi: 900,
    });
    defaultZipRecords = [
      {
        entries: new Map([["opendataloader_pdf/jar/opendataloader-pdf-cli.jar", INNER_JAR]]),
        opens: 0,
      },
    ];

    const out = await downloadPinnedJar(META, paths);

    expect(out).toBe(paths.target);
    const downloads = httpCalls.filter((c) => c.kind === "download");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].url).toContain("mirrors.ustc.edu.cn");
    // 六家镜像与 GitHub Release 都被探测过（并发探测择优）
    const probed = new Set(
      httpCalls.filter((c) => c.kind === "probe").map((c) => sourceIdOf(c.url)),
    );
    expect(probed.size).toBe(7);
  });

  it("已落地副本指纹相符时零请求复用", async () => {
    fs.write(paths.target, INNER_JAR);
    const out = await downloadPinnedJar(META, paths);
    expect(out).toBe(paths.target);
    expect(httpCalls).toHaveLength(0);
  });

  it("全部镜像不可达时拒绝并给出明确错误", async () => {
    installMirrorRoutes({
      aliyun: null,
      tuna: null,
      tencent: null,
      huawei: null,
      ustc: null,
      pypi: null,
    });
    await expect(downloadPinnedJar(META, paths)).rejects.toThrow(
      /no mirror reachable/,
    );
  });

  it("没有固定指纹时拒绝下载", async () => {
    await expect(
      downloadPinnedJar({ ...META, sha256: "" }, paths),
    ).rejects.toThrow(/no pinned SHA-256/);
    expect(fs.exists(paths.target)).toBe(false);
  });

  it("压缩包里没有匹配条目时该来源判负并降级", async () => {
    installMirrorRoutes({ aliyun: 5, tuna: 300, pypi: 150 });
    const emptyRecord: ZipRecord = { entries: new Map(), opens: 0 };
    const goodRecord: ZipRecord = {
      entries: new Map([["opendataloader_pdf/jar/opendataloader-pdf-cli.jar", INNER_JAR]]),
      opens: 0,
    };
    defaultZipRecords = [emptyRecord, goodRecord];

    const out = await downloadPinnedJar(META, paths);
    expect(out).toBe(paths.target);
    expect(httpCalls.filter((c) => c.kind === "download")).toHaveLength(2);
  });
});

// ─── getJarPath 端到端（精简版打包安装）──────────────────────────

describe("getJarPath（精简版打包安装）", () => {
  function installSlimXpi(jarName: string): void {
    extEntries.push(makeExtEntry(ADDON_ID + ".xpi", "file"));
    // 精简版 XPI：只有来源信息，没有 jar
    zipRecordFor(XPI_PATH).entries.set(
      "core/pdf/lib/PROVENANCE.json",
      utf8(JSON.stringify({ ...META, file: jarName })),
    );
  }

  function installMirrorRoutesLikeSlim(): void {
    httpRoutes.push({
      match: (_url, kind) => kind === "probe",
      respond: async (url) => {
        if (url.includes("aliyun")) {
          await sleep(5);
          return { status: 206, response: "" };
        }
        throw new Error("unreachable");
      },
    });
    httpRoutes.push({
      match: (_url, kind) => kind === "download",
      respond: () => ({ status: 200, response: WHEEL_BYTES.buffer }),
    });
  }

  it("XPI 无内置 jar 时下载兜底生效，再次调用命中会话备忘", async () => {
    const jarName = "opendataloader-pdf-cli.jar";
    installSlimXpi(jarName);
    installMirrorRoutesLikeSlim();
    defaultZipRecords = [
      {
        entries: new Map([["opendataloader_pdf/jar/" + jarName, INNER_JAR]]),
        opens: 0,
      },
    ];

    const first = await getJarPath(jarName);
    expect(first).toBe(LIB_DIR + "\\" + jarName);
    expect([...fs.read(first)]).toEqual([...INNER_JAR]);
    expect(httpCalls.filter((c) => c.kind === "download")).toHaveLength(1);

    // 第二次调用：会话备忘直接命中，不再发任何请求
    const before = httpCalls.length;
    const second = await getJarPath(jarName);
    expect(second).toBe(first);
    expect(httpCalls.length).toBe(before);
  });

  it("下载失败时回退原路径，会话内不再重复尝试", async () => {
    const jarName = "unreachable-jar.jar";
    installSlimXpi(jarName);
    httpRoutes.push({
      match: (_url, kind) => kind === "probe",
      respond: async () => {
        throw new Error("network down");
      },
    });

    const out = await getJarPath(jarName);
    expect(out).toBe(".\\core\\pdf\\lib\\" + jarName);
    expect(loggedErrors.join("\n")).toMatch(/no mirror reachable/);

    // 失败登记生效：第二次调用不再发探测请求
    const probeCount = httpCalls.filter((c) => c.kind === "probe").length;
    expect(probeCount).toBeGreaterThan(0);
    const out2 = await getJarPath(jarName);
    expect(out2).toBe(out);
    expect(httpCalls.filter((c) => c.kind === "probe").length).toBe(probeCount);
  });
});
