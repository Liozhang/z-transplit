/**
 * artifactAcquire 测试（src/core/pdf/artifactAcquire.ts）。
 *
 * 取件器被两个子系统共用（解析组件 jar、Python 运行时），它自己的契约必须
 * 直接钉住，不能只靠下游间接覆盖：
 *   1. 没有指纹绝不启动（信任边界）；
 *   2. 按 key 去重：同一目标共享一次取件，不同目标互不等待；
 *   3. 已落地副本复核通过 → 零网络；
 *   4. 归档级指纹（调用方知道时才传）不符即换源；不知道就不传，安装回调
 *      自己核对（jar 的指纹在包内，不在归档上）；
 *   5. 取消：不再开新的下载；
 *   6. 全部来源失败：报出每个来源的原因。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  acquireArtifact,
  acquisitionInFlightCount,
  rankSources,
} from "../../../../src/core/pdf/artifactAcquire";

class FakeFS {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async read(p: string) {
    const v = this.files.get(p);
    if (!v) throw new Error("ENOENT " + p);
    return v;
  }
  async write(p: string, b: Uint8Array) {
    this.files.set(p, b);
  }
  async makeDirectory(p: string) {
    this.dirs.add(p);
  }
  async remove(p: string) {
    this.files.delete(p);
    this.dirs.delete(p);
  }
  async move(from: string, to: string) {
    const v = this.files.get(from);
    if (!v) throw new Error("move source missing " + from);
    this.files.set(to, v);
    this.files.delete(from);
  }
}

const GOOD = new TextEncoder().encode("good bytes");
const GOOD_SHA = createHash("sha256").update(GOOD).digest("hex");
const BAD = new TextEncoder().encode("bad bytes");

let fs: FakeFS;
let calls: Array<{ url: string; kind: string }>;
let bytesFor: (url: string) => Uint8Array | null;

function installHost(): void {
  fs = new FakeFS();
  calls = [];
  bytesFor = () => GOOD;
  (globalThis as any).Zotero = {
    HTTP: {
      request: async (_m: string, url: string, opts: any) => {
        const kind = opts?.responseType === "arraybuffer" ? "download" : "probe";
        calls.push({ url, kind });
        if (kind === "probe") {
          // 让镜像的探测明显快于上游。rankSources 按探测耗时升序排，而这个 mock 的
          // 探测原本是立即返回的——两个来源的耗时都是 0 或 1 毫秒，谁排前面取决于
          // Date.now() 落在哪一毫秒上。机器一忙，事件循环被堵过 1 毫秒，次序就翻，
          // "换下一个来源"那条于是偶发失败（实测干净树上三遍里翻过一遍）。
          // 40 毫秒的差量到来回抖动翻不动为止。
          await new Promise((r) => setTimeout(r, url.includes("mirror") ? 1 : 40));
          return { status: 206, response: "" };
        }
        const bytes = bytesFor(url);
        if (!bytes) throw new Error("unreachable");
        return { status: 200, response: bytes.buffer };
      },
    },
  };
  (globalThis as any).IOUtils = {
    exists: (p: string) => fs.exists(p),
    read: (p: string) => fs.read(p),
    write: (p: string, b: Uint8Array) => fs.write(p, b),
    makeDirectory: (p: string) => fs.makeDirectory(p),
    remove: (p: string) => fs.remove(p),
    move: (a: string, b: string) => fs.move(a, b),
  };
  (globalThis as any).PathUtils = { join: (...p: string[]) => p.join("\\") };
}

beforeEach(() => {
  installHost();
});

afterEach(() => {
  delete (globalThis as any).Zotero;
  delete (globalThis as any).IOUtils;
  delete (globalThis as any).PathUtils;
});

const SOURCES = [
  { id: "mirror", url: "https://mirror.example/a.zip" },
  { id: "upstream", url: "https://upstream.example/a.zip" },
];

/** 安装回调：把归档内容原样搬到目标（模拟"解包后落地"）。 */
function installCopying(): (archivePath: string) => Promise<string> {
  return async (archivePath: string) => {
    const bytes = await fs.read(archivePath);
    await fs.makeDirectory("D:\\lib");
    await fs.move(archivePath, "D:\\lib\\target");
    return "D:\\lib\\target";
  };
}

describe("rankSources", () => {
  it("按耗时升序，丢弃不可达", () => {
    const ranked = rankSources([
      { source: SOURCES[0], ms: 30 },
      { source: SOURCES[1], ms: Number.POSITIVE_INFINITY },
    ]);
    expect(ranked.map((s) => s.id)).toEqual(["mirror"]);
  });
});

describe("acquireArtifact", () => {
  const base = () => ({
    key: "D:\\lib\\target",
    label: "test artifact",
    sources: SOURCES,
    sha256: GOOD_SHA,
    paths: { dir: "D:\\lib", target: "D:\\lib\\target" },
    install: installCopying(),
  });

  it("没有指纹：拒绝启动，一个请求都不发", async () => {
    await expect(acquireArtifact({ ...base(), sha256: "" })).rejects.toThrow(
      /no pinned SHA-256/,
    );
    expect(calls).toHaveLength(0);
  });

  it("完整链路：探测两个来源，只从第一个下载并落地", async () => {
    const out = await acquireArtifact(base());
    expect(out).toBe("D:\\lib\\target");
    expect([...(await fs.read("D:\\lib\\target"))]).toEqual([...GOOD]);
    expect(calls.filter((c) => c.kind === "probe")).toHaveLength(2);
    expect(calls.filter((c) => c.kind === "download")).toHaveLength(1);
    // 暂存归档已清理
    expect([...fs.files.keys()].some((f) => f.includes(".download-"))).toBe(false);
    expect(acquisitionInFlightCount()).toBe(0);
  });

  it("归档级指纹不符：换下一个来源", async () => {
    bytesFor = (url) => (url.includes("mirror") ? BAD : GOOD);
    const out = await acquireArtifact({ ...base(), archiveSha256: GOOD_SHA });
    expect(out).toBe("D:\\lib\\target");
    const downloads = calls.filter((c) => c.kind === "download");
    expect(downloads.map((d) => d.url)).toEqual([
      "https://mirror.example/a.zip",
      "https://upstream.example/a.zip",
    ]);
  });

  it("不传归档级指纹：安装回调自己核对（jar 的指纹在包内）", async () => {
    // 镜像给坏字节，但 install 只认好字节——回调抛错即换源
    bytesFor = (url) => (url.includes("mirror") ? BAD : GOOD);
    const install = async (archivePath: string) => {
      const bytes = await fs.read(archivePath);
      if (new TextDecoder().decode(bytes) !== "good bytes") {
        throw new Error("jar checksum mismatch");
      }
      await fs.makeDirectory("D:\\lib");
      await fs.move(archivePath, "D:\\lib\\target");
      return "D:\\lib\\target";
    };
    const out = await acquireArtifact({ ...base(), install });
    expect(out).toBe("D:\\lib\\target");
  });

  it("已落地副本复核通过：零网络", async () => {
    await fs.write("D:\\lib\\target", GOOD);
    const out = await acquireArtifact(base());
    expect(out).toBe("D:\\lib\\target");
    expect(calls).toHaveLength(0);
  });

  it("已落地副本指纹不符：重新取件", async () => {
    await fs.write("D:\\lib\\target", BAD);
    const out = await acquireArtifact(base());
    expect([...(await fs.read(out))]).toEqual([...GOOD]);
    expect(calls.filter((c) => c.kind === "download")).toHaveLength(1);
  });

  it("同一 key 的并发调用共享一次取件", async () => {
    const req = base();
    const [a, b] = await Promise.all([acquireArtifact(req), acquireArtifact(req)]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c.kind === "download")).toHaveLength(1);
  });

  it("不同 key 互不等待（jar 与运行时可并行取件）", async () => {
    const slow = {
      ...base(),
      key: "D:\\lib\\other",
      paths: { dir: "D:\\lib", target: "D:\\lib\\other" },
    };
    const both = await Promise.all([acquireArtifact(base()), acquireArtifact(slow)]);
    expect(both).toHaveLength(2);
    expect(calls.filter((c) => c.kind === "download")).toHaveLength(2);
  });

  it("取消信号已中止：不开新下载，报错带上取消原因", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireArtifact({ ...base(), signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect(calls.filter((c) => c.kind === "download")).toHaveLength(0);
  });

  it("全部来源失败：报出每个来源的原因", async () => {
    bytesFor = () => null;
    await expect(acquireArtifact(base())).rejects.toThrow(
      /mirror: Error: unreachable; upstream: Error: unreachable/,
    );
    expect(acquisitionInFlightCount()).toBe(0);
  });
});
