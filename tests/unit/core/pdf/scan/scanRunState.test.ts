/**
 * scanRunState 测试（src/core/pdf/scan/scanRunState.ts）。
 *
 * 断点状态是"重跑不从头再来"的唯一依据，两件事必须钉住：存进去的读得
 * 回来（否则续跑静默失效），源文件换版后必须作废（否则旧坐标配新页面，
 * 比不识别更糟）。宿主部分用内存文件系统桩驱动真实的 openScanRunState。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openScanRunState,
  pageStateFileName,
  parseRunManifest,
  parseStoredPage,
  runStateFingerprint,
  serializeRunManifest,
  RUN_MANIFEST_FILE,
} from "../../../../../src/core/pdf/scan/scanRunState";
import type { SidecarPageResult } from "../../../../../src/core/pdf/scan/sidecarProtocol";

// ─── 内存文件系统桩 ────────────────────────────────────────────────────────

class FakeIOUtils {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async read(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error("ENOENT: " + path);
    return new TextEncoder().encode(content);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, new TextDecoder().decode(bytes));
  }

  async makeDirectory(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(path + "\\") || key.startsWith(path + "/")) {
        this.files.delete(key);
      }
    }
    this.dirs.delete(path);
  }
}

let io: FakeIOUtils;

function installHost(): void {
  io = new FakeIOUtils();
  (globalThis as any).IOUtils = io;
  (globalThis as any).Zotero = { DataDirectory: { dir: "D:/data" } };
  (globalThis as any).PathUtils = {
    join: (...parts: string[]) => parts.join("\\"),
  };
}

beforeEach(() => {
  installHost();
});

afterEach(() => {
  delete (globalThis as any).IOUtils;
  delete (globalThis as any).Zotero;
  delete (globalThis as any).PathUtils;
});

function page(pageNumber: number): SidecarPageResult {
  return {
    pageNumber,
    pageSizePt: { width: 595, height: 842 },
    renderSizePx: { width: 1654, height: 2339 },
    dpi: 200,
    rotation: 0,
    lines: [{ bbox: { x0: 10, y0: 10, x1: 100, y1: 30 }, text: `第 ${pageNumber} 页`, blockId: 0 }],
    formulas: [],
    tables: [],
    figures: [],
    coverage: 0.5,
  };
}

// ─── 纯函数 ────────────────────────────────────────────────────────────────

describe("runStateFingerprint", () => {
  it("时间或字节数变化都产生不同指纹", () => {
    const a = runStateFingerprint(1000, 500);
    expect(runStateFingerprint(1001, 500)).not.toBe(a);
    expect(runStateFingerprint(1000, 501)).not.toBe(a);
    expect(runStateFingerprint(1000, 500)).toBe(a);
  });

  it("小数时间被取整（同一文件的重复 stat 稳定）", () => {
    expect(runStateFingerprint(1000.7, 500)).toBe(runStateFingerprint(1000.2, 500));
  });
});

describe("parseRunManifest", () => {
  it("序列化后原样解析", () => {
    const m = serializeRunManifest({
      version: 1,
      fingerprint: "1000:500",
      pages: [3, 1, 2],
      updatedAt: 123,
    });
    const parsed = parseRunManifest(m);
    expect(parsed).toEqual({ version: 1, fingerprint: "1000:500", pages: [1, 2, 3], updatedAt: 123 });
  });

  it("版本不符、缺指纹、pages 非整数都判无效", () => {
    expect(parseRunManifest(JSON.stringify({ version: 2, fingerprint: "a", pages: [] }))).toBeNull();
    expect(parseRunManifest(JSON.stringify({ version: 1, fingerprint: "", pages: [] }))).toBeNull();
    expect(parseRunManifest(JSON.stringify({ version: 1, fingerprint: "a", pages: [1, "x"] }))).toBeNull();
    expect(parseRunManifest("not json")).toBeNull();
  });
});

describe("parseStoredPage", () => {
  it("复用侧车协议校验：缺页面尺寸的存档页判无效", () => {
    expect(parseStoredPage(JSON.stringify(page(1)))!.pageNumber).toBe(1);
    expect(parseStoredPage(JSON.stringify({ pageNumber: 1 }))).toBeNull();
    expect(parseStoredPage("not json")).toBeNull();
  });
});

describe("pageStateFileName", () => {
  it("四位补零，字典序即页序", () => {
    expect(pageStateFileName(1)).toBe("page-0001.json");
    expect(pageStateFileName(42)).toBe("page-0042.json");
    expect(pageStateFileName(1000)).toBe("page-1000.json");
  });
});

// ─── 宿主部分（内存桩驱动真实实现） ────────────────────────────────────────

describe("openScanRunState", () => {
  it("空目录开局：completed 为空，load 返回空映射", async () => {
    const state = await openScanRunState(7, "1000:500");
    expect(state.completed).toEqual([]);
    expect((await state.load()).size).toBe(0);
  });

  it("save 后 load 原样读回，清单同步更新", async () => {
    const state = await openScanRunState(7, "1000:500");
    await state.save(page(1));
    await state.save(page(2));
    expect(state.completed).toEqual([1, 2]);
    const loaded = await state.load();
    expect([...loaded.keys()]).toEqual([1, 2]);
    expect(loaded.get(2)!.lines[0].text).toBe("第 2 页");
    // 清单落盘
    const manifestPath = `D:/data\\ztransplit\\scan-state\\7\\${RUN_MANIFEST_FILE}`;
    expect(io.files.has(manifestPath)).toBe(true);
  });

  it("重新打开同一状态：completed 从清单恢复", async () => {
    const first = await openScanRunState(7, "1000:500");
    await first.save(page(1));
    const second = await openScanRunState(7, "1000:500");
    expect(second.completed).toEqual([1]);
    expect((await second.load()).get(1)!.pageNumber).toBe(1);
  });

  it("源文件指纹不匹配：旧状态被清空（旧坐标不能配新页面）", async () => {
    const first = await openScanRunState(7, "1000:500");
    await first.save(page(1));
    const second = await openScanRunState(7, "2000:900");
    expect(second.completed).toEqual([]);
    expect((await second.load()).size).toBe(0);
  });

  it("清单在但页文件丢失：该页按未完成处理（不冒充已认）", async () => {
    const first = await openScanRunState(7, "1000:500");
    await first.save(page(1));
    // 删掉页文件、保留清单
    const pagePath = `D:/data\\ztransplit\\scan-state\\7\\${pageStateFileName(1)}`;
    io.files.delete(pagePath);
    const second = await openScanRunState(7, "1000:500");
    expect(second.completed).toEqual([1]); // 清单仍登记
    expect((await second.load()).size).toBe(0); // 读不回来
  });

  it("清单损坏（JSON 坏）：按无状态开局", async () => {
    io.files.set(`D:/data\\ztransplit\\scan-state\\7\\${RUN_MANIFEST_FILE}`, "{坏");
    const state = await openScanRunState(7, "1000:500");
    expect(state.completed).toEqual([]);
  });

  it("clear 后状态目录内容清空", async () => {
    const state = await openScanRunState(7, "1000:500");
    await state.save(page(1));
    await state.clear();
    expect(state.completed).toEqual([]);
    expect((await state.load()).size).toBe(0);
  });

  it("save 的页写入以附件 id 分目录（不同附件互不干扰）", async () => {
    const a = await openScanRunState(7, "fp");
    const b = await openScanRunState(8, "fp");
    await a.save(page(1));
    await b.save(page(1));
    expect((await a.load()).get(1)!.lines[0].text).toBe("第 1 页");
    expect(a.dir).not.toBe(b.dir);
    expect((await b.load()).size).toBe(1);
  });
});
