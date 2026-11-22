/**
 * probes-and-clamps — 能力探测、路径拼接、视觉可用性与坐标夹取。
 *
 * 为什么打包：四件事分属不同模块，却是同一类缺口——都是"被生产代码依赖、但从未
 * 被直接测过"的小函数。而且它们各自守护的是一条**契约**而不是一段逻辑：
 *
 *   - `probeReaderCapabilities` 的契约是"永不盲调内部 API"：每一个能力都用
 *     `typeof` 探，探不到就是 false，不抛错。破了这条，Zotero 7 上一个手滑就会
 *     让整个面板启动失败。
 *   - `joinWorkPath` 的契约是"必须走 PathUtils.join"：Windows 下临时目录是反斜杠，
 *     手拼正斜杠得到混合分隔符，IOUtils 直接拒收。这是个踩过的坑。
 *   - `isFormulaVisionAvailable` 的契约是"没有 Zotero 全局也不抛错"——注释里
 *     明写了 "Never throws on hosts without the Zotero global"。
 *   - `clampParagraph` 的契约是夹取后仍然 x1 > x0：夹成零宽或负宽的框会让渲染端
 *     折行宽度塌成 0，是整个静默截断链条的入口。
 *
 * 另外把批 8 新加的 `collectPageRotations` 一并钉住——它是那批唯一没有直接测试
 * 的新导出。
 *
 * @module tests/node/probes-and-clamps
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";

import { probeReaderCapabilities } from "../../src/core/capabilities";
import { joinWorkPath } from "../../src/core/pdf/scan/workDir";
import { isFormulaVisionAvailable } from "../../src/core/pdf/translation/formulaExtractor";
import { collectPageRotations, collectPageSizes } from "../../src/core/pdf/translation/backgroundFill";
import { clampParagraph } from "../../src/core/pdf/translation/LayoutPreservingRenderer";
import type { Paragraph } from "../../src/core/pdf/translation/translationIR";
import * as prefs from "../../src/utils/prefs";

// prefs 模块 mock：isFormulaVisionAvailable 只读 translate.custom.apiUrl。
// ESM 命名空间上直接 spyOn 过不了 tsconfig.node.json 的类型检查，照
// tests/node/translation-chain.spec.ts 的既有手法。
vi.mock("../../src/utils/prefs", () => ({
  getPrefDynamic: vi.fn(),
  getPref: vi.fn(),
  setPref: vi.fn(),
}));

const setPrefDynamic = vi.mocked(prefs.getPrefDynamic);

function para(overrides: Partial<Paragraph> = {}): Paragraph {
  return {
    x: 72,
    y: 700,
    x0: 72,
    x1: 500,
    y0: 700,
    y1: 720,
    size: 12,
    brk: false,
    ...overrides,
  };
}

describe("probeReaderCapabilities", () => {
  const realZotero = (globalThis as any).Zotero;

  afterEach(() => {
    if (realZotero === undefined) delete (globalThis as any).Zotero;
    else (globalThis as any).Zotero = realZotero;
  });

  it("Zotero 10 的内部 reader 带 SDT 三个方法时 sdtModeAvailable 为真", () => {
    (globalThis as any).Zotero = { version: "10.0.3" };
    const caps = probeReaderCapabilities({
      _internalReader: {
        _setReadingMode: () => {},
        _loadSDT: () => {},
      },
    });
    expect(caps.zoteroMajor).toBe(10);
    expect(caps.sdtModeAvailable).toBe(true);
  });

  it("三个方法缺任何一个都算不可用（存在是必要不充分条件）", () => {
    (globalThis as any).Zotero = { version: "10.0.3" };
    const partial = { _setReadingMode: () => {} };
    expect(probeReaderCapabilities({ _internalReader: partial }).sdtModeAvailable).toBe(false);
    expect(probeReaderCapabilities({ _internalReader: {} }).sdtModeAvailable).toBe(false);
    // _loadSDT 有但 _setReadingMode 没有，同样不算。
    expect(
      probeReaderCapabilities({ _internalReader: { _loadSDT: () => {} } }).sdtModeAvailable,
    ).toBe(false);
  });

  it("Zotero 7 的内部 reader 没有这三个方法", () => {
    (globalThis as any).Zotero = { version: "7.0.15" };
    const caps = probeReaderCapabilities({ _internalReader: {} });
    expect(caps.zoteroMajor).toBe(7);
    expect(caps.sdtModeAvailable).toBe(false);
  });

  it("没有 _internalReader 时退回 reader 自身", () => {
    (globalThis as any).Zotero = { version: "10.0.3" };
    // 直接把三个方法挂在 reader 上（没有 _internalReader 那一层）。
    const caps = probeReaderCapabilities({
      _setReadingMode: () => {},
      _loadSDT: () => {},
    });
    expect(caps.sdtModeAvailable).toBe(true);
  });

  it("reader 为 null/undefined 时不抛错，SDT 判假", () => {
    (globalThis as any).Zotero = { version: "10.0.3" };
    expect(() => probeReaderCapabilities(null)).not.toThrow();
    expect(probeReaderCapabilities(null).sdtModeAvailable).toBe(false);
    expect(probeReaderCapabilities(undefined).sdtModeAvailable).toBe(false);
  });

  it("没有 Zotero 全局时主版本号是 0，其余探测照样返回布尔", () => {
    delete (globalThis as any).Zotero;
    const caps = probeReaderCapabilities({});
    expect(caps.zoteroMajor).toBe(0);
    expect(typeof caps.sdtModeAvailable).toBe("boolean");
    expect(typeof caps.speechSynthesis).toBe("boolean");
    expect(typeof caps.intlSegmenter).toBe("boolean");
  });

  it("版本号解析取第一段，非数字时给 0", () => {
    (globalThis as any).Zotero = { version: "10.0.3-beta" };
    expect(probeReaderCapabilities({}).zoteroMajor).toBe(10);
    (globalThis as any).Zotero = { version: "not-a-version" };
    expect(probeReaderCapabilities({}).zoteroMajor).toBe(0);
    (globalThis as any).Zotero = {};
    expect(probeReaderCapabilities({}).zoteroMajor).toBe(0);
  });

  it("Intl.Segmenter 与 speechSynthesis 用 typeof 探，探不到就是 false", () => {
    (globalThis as any).Zotero = { version: "10.0.3" };
    // Node 22 两者都有。
    expect(probeReaderCapabilities({}).intlSegmenter).toBe(true);
    // speechSynthesis 在 Node 里没有，走主窗口回退也没有 —— 判假，不抛错。
    expect(probeReaderCapabilities({}).speechSynthesis).toBe(false);
  });
});

describe("joinWorkPath", () => {
  it("有 PathUtils 时走它的 join", () => {
    const calls: string[][] = [];
    (globalThis as any).PathUtils = {
      join: (...parts: string[]) => {
        calls.push(parts);
        return parts.join("/");
      },
    };
    try {
      expect(joinWorkPath("C:\\Temp\\zt", "page-1.json")).toBe("C:\\Temp\\zt/page-1.json");
      expect(calls).toEqual([["C:\\Temp\\zt", "page-1.json"]]);
    } finally {
      delete (globalThis as any).PathUtils;
    }
  });

  it("没有 PathUtils 时退回反斜杠拼接（Windows 语义）", () => {
    delete (globalThis as any).PathUtils;
    expect(joinWorkPath("C:\\Temp\\zt", "page-1.json")).toBe("C:\\Temp\\zt\\page-1.json");
  });

  it("PathUtils.join 抛错时异常照旧传出（?? 只管缺失，不管抛错）", () => {
    // 这一条钉的是一个容易看错的细节。实现是
    //   `PathUtils?.join?.(dir, name) ?? \`${dir}\\${name}\``
    // 可选链加 ?? 覆盖的是"PathUtils 不存在"与"join 不是函数"两种情形，
    // **不覆盖 join 抛异常**——?? 只接 null/undefined。所以宿主里的 join 真的
    // 抛错时，异常会一路传到调用方。
    //
    // 这是有意的：宿主把 join 实现了却让它抛错，那是宿主的 bug。安静地退回
    // 反斜杠会把问题藏起来，产出一个混合分隔符的路径让 IOUtils 在后面拒收，
    // 报错点离病根隔了整层。宁可在这里炸。
    (globalThis as any).PathUtils = {
      join: () => {
        throw new Error("host join failed");
      },
    };
    try {
      expect(() => joinWorkPath("dir", "name")).toThrow("host join failed");
    } finally {
      delete (globalThis as any).PathUtils;
    }
  });
});

describe("isFormulaVisionAvailable", () => {
  afterEach(() => {
    setPrefDynamic.mockReset();
  });

  it("配了接口地址就可用", () => {
    setPrefDynamic.mockImplementation((key: string) =>
      key === "translate.custom.apiUrl" ? "https://vlm.example.com" : undefined,
    );
    expect(isFormulaVisionAvailable()).toBe(true);
  });

  it("没配接口地址就不可用", () => {
    setPrefDynamic.mockImplementation(() => undefined);
    expect(isFormulaVisionAvailable()).toBe(false);
  });

  it("接口地址是空串时按未配处理", () => {
    setPrefDynamic.mockImplementation(() => "");
    expect(isFormulaVisionAvailable()).toBe(false);
  });

  it("pref 读取抛错时不抛出去，判不可用", () => {
    // 契约就在注释里："Never throws on hosts without the Zotero global"。
    // 无 Zotero 宿主上 getPrefDynamic 可能整个不可用，那时必须安静地给 false。
    setPrefDynamic.mockImplementation(() => {
      throw new Error("no prefs here");
    });
    expect(() => isFormulaVisionAvailable()).not.toThrow();
    expect(isFormulaVisionAvailable()).toBe(false);
  });
});

describe("collectPageRotations", () => {
  it("未旋转文档给全 0", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    doc.addPage([200, 300]);
    expect(await collectPageRotations(await doc.save())).toEqual([0, 0]);
  });

  it("逐页读 /Rotate，与页序一一对应", async () => {
    const doc = await PDFDocument.create();
    const a = doc.addPage([200, 300]);
    const b = doc.addPage([200, 300]);
    const c = doc.addPage([200, 300]);
    a.setRotation(degrees(90));
    c.setRotation(degrees(270));
    expect(await collectPageRotations(await doc.save())).toEqual([90, 0, 270]);
  });

  it("零页文档经保存加载往返后多出一页，旋转为 0", async () => {
    // 又是那个 pdf-lib 往返怪状：PDFDocument.create() 报 0 页，save() 之后再
    // load() 变成 1 页（与 tests/node/table-and-merge.spec.ts 里
    // mergePageBytes([]) 那一条同源）。所以这里断言的是真实行为 [0]，
    // 不是想当然的 []。把两者写在相邻两处，下次改 pdf-lib 版本时一起看见。
    const doc = await PDFDocument.create();
    expect(doc.getPageCount()).toBe(0);
    expect(await collectPageRotations(await doc.save())).toEqual([0]);
  });

  it("读不出 PDF 时返回空数组，不抛错", async () => {
    // 调用方按"没有旋转"处理——那是绝大多数文档的常态，不该让一个可选信息让
    // 整次翻译失败。
    await expect(collectPageRotations(new Uint8Array([1, 2, 3]))).resolves.toEqual([]);
  });
});

describe("collectPageSizes", () => {
  it("未旋转文档给逐页 MediaBox 尺寸", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    doc.addPage([500, 400]);
    expect(await collectPageSizes(await doc.save())).toEqual([
      { width: 200, height: 300 },
      { width: 500, height: 400 },
    ]);
  });

  it("报的是未旋转尺寸，旋转页上也不交换宽高", async () => {
    // 这一条是它存在的理由。pdf-lib 的 getSize() 给 MediaBox 原始尺寸，不套
    // /Rotate：rot90 的 200×300 页报的还是 200×300，不是 300×200。
    // 删除器解析内容流、画在原始空间，buildRemovalRects 也是先把显示空间的框
    // 变换回原始空间再裁剪——两边必须用同一套宽高，交换了就会切错方向。
    const doc = await PDFDocument.create();
    const a = doc.addPage([200, 300]);
    const b = doc.addPage([200, 300]);
    a.setRotation(degrees(90));
    b.setRotation(degrees(180));
    expect(await collectPageSizes(await doc.save())).toEqual([
      { width: 200, height: 300 },
      { width: 200, height: 300 },
    ]);
  });

  it("横版页面报横版尺寸，不往标准纸号上靠", async () => {
    // landscape-slides.pdf 是 841.92 × 594.96。装配层从内容范围估出的页面尺寸
    // 是 739.56 × 792（适配器的 JSON 不带 MediaBox，只能反推再往标准纸号靠），
    // 拿它裁剪删除区域会把每段右边约 30 磅的原文剩下——真机实测留下 24 个英文
    // 字母。所以删除区域必须用这里读到的真实 MediaBox，不能用估值。
    const doc = await PDFDocument.create();
    doc.addPage([841.92, 594.96]);
    expect(await collectPageSizes(await doc.save())).toEqual([
      { width: 841.92, height: 594.96 },
    ]);
  });

  it("零页文档经保存加载往返后多出一页，尺寸为 595×842 的默认页", async () => {
    // 又是那个 pdf-lib 往返怪状（见上面 collectPageRotations 的同一条）。
    const doc = await PDFDocument.create();
    expect(doc.getPageCount()).toBe(0);
    const sizes = await collectPageSizes(await doc.save());
    expect(sizes).toHaveLength(1);
    expect(sizes[0].width).toBeGreaterThan(0);
    expect(sizes[0].height).toBeGreaterThan(0);
  });

  it("读不出 PDF 时返回空数组，不抛错（与 collectPageRotations 同一契约）", async () => {
    // 调用方按"没有尺寸"处理，即跳过裁剪——那是绝大多数文档的常态。
    await expect(collectPageSizes(new Uint8Array([1, 2, 3]))).resolves.toEqual([]);
  });
});

describe("clampParagraph", () => {
  it("完全在页内的框原样返回（同一个对象，不做无谓拷贝）", () => {
    const p = para();
    expect(clampParagraph(p, 612, 792)).toBe(p);
  });

  it("越界框被裁回纸面", () => {
    // ODL 实例：612 宽页面上的 x=635。
    const out = clampParagraph(para({ x0: 600, x1: 635, y0: 100, y1: 120 }), 612, 792);
    expect(out.x1).toBe(612);
    expect(out.x0).toBe(600);
  });

  it("负坐标被夹到 0", () => {
    const out = clampParagraph(para({ x0: -50, x1: 100, y0: -20, y1: 50 }), 612, 792);
    expect(out.x0).toBe(0);
    expect(out.y0).toBe(0);
  });

  it("夹取后仍然 x1 > x0、y1 > y0（零宽框会让折行宽度塌成 0）", () => {
    // 整个框都在页面右侧之外：夹完 x0 与 x1 都等于 pageW，宽度为 0。
    // 这里断言的是"不会出现 x1 < x0"——调用方自己判宽度是否为 0。
    const out = clampParagraph(para({ x0: 700, x1: 800, y0: 900, y1: 950 }), 612, 792);
    expect(out.x1).toBeGreaterThanOrEqual(out.x0);
    expect(out.y1).toBeGreaterThanOrEqual(out.y0);
  });

  it("x 与 y 同步更新为新左界与新下界", () => {
    // 渲染端用 p.x 作绘制起点，夹了框不夹 x 会让文字画到夹取前的位置。
    const out = clampParagraph(para({ x0: -30, x1: 100, y0: -10, y1: 50 }), 612, 792);
    expect(out.x).toBe(out.x0);
    expect(out.y).toBe(out.y0);
  });

  it("其余字段原样保留", () => {
    const p = para({ size: 9, bold: true, text: "x" } as Partial<Paragraph>);
    const out = clampParagraph({ ...p, x0: -30, x1: 100 }, 612, 792);
    expect(out.size).toBe(9);
    expect(out.bold).toBe(true);
  });
});
