/**
 * sidecarProtocol 测试（src/core/pdf/scan/sidecarProtocol.ts）。
 *
 * 契约层是插件与识别侧车之间唯一的信任边界：侧车是独立进程，输出可能
 * 缺字段、错类型、乱序——一批 300 页里一页 JSON 坏掉不能让整批作废。
 * 本文件锁住：命令行的引号拆分（Windows 空格路径）、单页校验的硬伤判定
 * （缺页码/缺页面尺寸）、软伤容错（坏行跳过、bbox 归一、coverage 钳制）、
 * 以及整批解析的零异常保证。
 */
import { describe, it, expect } from "vitest";
import {
  indexPages,
  parseCommandLine,
  parseSidecarBatchOutput,
  parseSidecarPageResult,
  SIDECAR_EXIT_OK,
  SIDECAR_EXIT_PARTIAL,
} from "../../../../../src/core/pdf/scan/sidecarProtocol";

function validPageRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageNumber: 3,
    pageSizePt: { width: 595.28, height: 841.89 },
    renderSizePx: { width: 1654, height: 2339 },
    dpi: 200,
    rotation: 0,
    lines: [
      { bbox: { x0: 100, y0: 200, x1: 500, y1: 220 }, text: "第一行", blockId: 0 },
      { bbox: { x0: 100, y0: 230, x1: 480, y1: 250 }, text: "第二行", blockId: 0 },
      { bbox: { x0: 100, y0: 260, x1: 300, y1: 280 }, text: "标题", blockId: 1, blockType: "title" },
    ],
    formulas: [{ bbox: { x0: 100, y0: 400, x1: 300, y1: 440 }, latex: "$E=mc^2$", isDisplay: false }],
    tables: [{ bbox: { x0: 100, y0: 600, x1: 500, y1: 800 }, html: "<table></table>" }],
    figures: [{ bbox: { x0: 600, y0: 600, x1: 900, y1: 800 } }],
    coverage: 0.42,
    ...over,
  };
}

describe("parseCommandLine", () => {
  it("普通空格拆分", () => {
    expect(parseCommandLine("python sidecar.py")).toEqual(["python", "sidecar.py"]);
  });

  it("双引号保护带空格的 Windows 路径", () => {
    expect(parseCommandLine('"C:\\Program Files\\Python\\python.exe" sidecar.py')).toEqual([
      "C:\\Program Files\\Python\\python.exe",
      "sidecar.py",
    ]);
  });

  it("单引号同样受保护", () => {
    expect(parseCommandLine("'/opt/my python/bin/python' sidecar.py")).toEqual([
      "/opt/my python/bin/python",
      "sidecar.py",
    ]);
  });

  it("引号不闭合返回 null（调用方按配置错误提示）", () => {
    expect(parseCommandLine('"C:\\broken python.exe sidecar.py')).toBeNull();
  });

  it("空串与纯空白返回 null", () => {
    expect(parseCommandLine("")).toBeNull();
    expect(parseCommandLine("   \t ")).toBeNull();
  });

  it("连续多个空白按一个分隔", () => {
    expect(parseCommandLine("python   \t sidecar.py")).toEqual(["python", "sidecar.py"]);
  });
});

describe("parseSidecarPageResult", () => {
  it("完整页解析成功，元素全部保留", () => {
    const page = parseSidecarPageResult(validPageRaw());
    expect(page).not.toBeNull();
    expect(page!.pageNumber).toBe(3);
    expect(page!.lines).toHaveLength(3);
    expect(page!.lines[2].blockType).toBe("title");
    expect(page!.formulas[0].latex).toBe("$E=mc^2$");
    expect(page!.tables[0].html).toBe("<table></table>");
    expect(page!.figures).toHaveLength(1);
    expect(page!.coverage).toBeCloseTo(0.42, 5);
  });

  it("缺页码或页面尺寸是硬伤，返回 null", () => {
    expect(parseSidecarPageResult({ ...validPageRaw(), pageNumber: undefined })).toBeNull();
    expect(parseSidecarPageResult({ ...validPageRaw(), pageNumber: 0 })).toBeNull();
    expect(parseSidecarPageResult({ ...validPageRaw(), pageSizePt: { width: 0, height: 100 } })).toBeNull();
  });

  it("坏行（无 bbox / 空文本 / 非对象）跳过不拖垮整页", () => {
    const page = parseSidecarPageResult(
      validPageRaw({
        lines: [
          { bbox: { x0: 1, y0: 1, x1: 2, y1: 2 }, text: "好的", blockId: 0 },
          { bbox: null, text: "没有框", blockId: 0 },
          { bbox: { x0: 1, y0: 1, x1: 2, y1: 2 }, text: "   ", blockId: 0 },
          "根本不是对象",
        ],
      }),
    );
    expect(page!.lines).toHaveLength(1);
    expect(page!.lines[0].text).toBe("好的");
  });

  it("无序 bbox 自动归一", () => {
    const page = parseSidecarPageResult(
      validPageRaw({ formulas: [{ bbox: { x0: 300, y0: 440, x1: 100, y1: 400 }, latex: "$x$", isDisplay: true }] }),
    );
    expect(page!.formulas[0].bbox).toEqual({ x0: 100, y0: 400, x1: 300, y1: 440 });
  });

  // 侧车（sidecar.py 的 _as_bbox）输出的是扁平数组 [x0,y0,x1,y1]，不是
  // {x0,y0,x1,y1} 对象。2026-11-23 之前只认对象形状，于是真机上每一行
  // 文字都因取不到框被静默丢弃：result.json 里 28 条 lines，插件收到 0 条，
  // 页面全空且没有任何 warning，看起来就像"识别引擎坏了"。下面三条把
  // 侧车的真实形状钉在测试里——数组、点列、以及数组与对象混用。
  it("扁平数组 bbox [x0,y0,x1,y1]（侧车的真实形状）", () => {
    const page = parseSidecarPageResult(
      validPageRaw({
        lines: [
          { bbox: [200, 197, 716, 248], text: "标题行", blockId: 0, blockType: "doc_title" },
          { bbox: [203, 292, 596, 322], text: "作者行", blockId: 1, blockType: "text" },
        ],
        formulas: [{ bbox: [100, 400, 300, 440], latex: "$E=mc^2$", isDisplay: false }],
        tables: [{ bbox: [100, 600, 500, 800], html: "<table></table>" }],
        figures: [{ bbox: [600, 600, 900, 800] }],
      }),
    );
    expect(page!.lines).toHaveLength(2);
    expect(page!.lines[0].bbox).toEqual({ x0: 200, y0: 197, x1: 716, y1: 248 });
    expect(page!.lines[1].blockType).toBe("text");
    expect(page!.formulas[0].bbox).toEqual({ x0: 100, y0: 400, x1: 300, y1: 440 });
    expect(page!.tables[0].bbox).toEqual({ x0: 100, y0: 600, x1: 500, y1: 800 });
    expect(page!.figures[0].bbox).toEqual({ x0: 600, y0: 600, x1: 900, y1: 800 });
  });

  it("四边形点列 bbox [[x,y] x4]（PaddleX dt_polys 的形状）", () => {
    const page = parseSidecarPageResult(
      validPageRaw({
        lines: [
          {
            bbox: [
              [200, 197],
              [716, 197],
              [716, 248],
              [200, 248],
            ],
            text: "点列行",
            blockId: 0,
          },
        ],
      }),
    );
    expect(page!.lines).toHaveLength(1);
    expect(page!.lines[0].bbox).toEqual({ x0: 200, y0: 197, x1: 716, y1: 248 });
  });

  it("数组 bbox 与对象 bbox 可以在同一页混用", () => {
    const page = parseSidecarPageResult(
      validPageRaw({
        lines: [
          { bbox: [10, 20, 30, 40], text: "数组行", blockId: 0 },
          { bbox: { x0: 50, y0: 60, x1: 70, y1: 80 }, text: "对象行", blockId: 0 },
        ],
      }),
    );
    expect(page!.lines).toHaveLength(2);
    expect(page!.lines[0].bbox).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
    expect(page!.lines[1].bbox).toEqual({ x0: 50, y0: 60, x1: 70, y1: 80 });
  });

  it("长度不对的数组 bbox 整条丢弃，不拖垮同页其它行", () => {
    const page = parseSidecarPageResult(
      validPageRaw({
        lines: [
          { bbox: [10, 20, 30], text: "三点", blockId: 0 },
          { bbox: [10, 20, 30, 40], text: "好的", blockId: 0 },
        ],
      }),
    );
    expect(page!.lines).toHaveLength(1);
    expect(page!.lines[0].text).toBe("好的");
  });

  it("coverage 钳到 0–1", () => {
    expect(parseSidecarPageResult(validPageRaw({ coverage: 1.7 }))!.coverage).toBe(1);
    expect(parseSidecarPageResult(validPageRaw({ coverage: -0.2 }))!.coverage).toBe(0);
  });

  it("缺 renderSizePx 时按 dpi 推算（渲染取整的兜底）", () => {
    const page = parseSidecarPageResult(validPageRaw({ renderSizePx: undefined }));
    expect(page!.renderSizePx.width).toBe(Math.round((595.28 * 200) / 72));
    expect(page!.renderSizePx.height).toBe(Math.round((841.89 * 200) / 72));
  });

  it("旋转页带着 rotation 与 skipReason 原样回报", () => {
    const page = parseSidecarPageResult(validPageRaw({ rotation: 90, skipReason: "rotated", lines: [] }));
    expect(page!.rotation).toBe(90);
    expect(page!.skipReason).toBe("rotated");
  });

  it("完全不是对象返回 null", () => {
    expect(parseSidecarPageResult(null)).toBeNull();
    expect(parseSidecarPageResult("page")).toBeNull();
  });
});

describe("parseSidecarBatchOutput", () => {
  it("整批解析，诊断信息透传", () => {
    const out = parseSidecarBatchOutput({
      pages: [validPageRaw(), validPageRaw({ pageNumber: 4 })],
      diagnostics: {
        engine: "pp-structurev3",
        engineVersion: "3.x",
        modelTier: "light",
        warnings: ["low dpi"],
      },
    });
    expect(out!.pages).toHaveLength(2);
    expect(out!.diagnostics!.engine).toBe("pp-structurev3");
    expect(out!.diagnostics!.warnings).toEqual(["low dpi"]);
  });

  // result.json 在批次成功后就删了，档位只有 diagnostics 这一条路留得下来：
  // 少解析一个字段，事后就认不出这批字出自哪套模型。
  it("诊断信息带出模型档位", () => {
    const out = parseSidecarBatchOutput({
      pages: [validPageRaw()],
      diagnostics: { engine: "pp-structurev3", modelTier: "light" },
    });
    expect(out!.diagnostics!.modelTier).toBe("light");
  });

  it("档位不是字符串时忽略，不当成有效值", () => {
    const out = parseSidecarBatchOutput({
      pages: [validPageRaw()],
      diagnostics: { engine: "pp-structurev3", modelTier: 7 },
    });
    expect(out!.diagnostics!.modelTier).toBeUndefined();
  });

  it("坏页从批里剔除，不影响好页", () => {
    const out = parseSidecarBatchOutput({
      pages: [validPageRaw(), { pageNumber: "坏" }, validPageRaw({ pageNumber: 9 })],
    });
    expect(out!.pages.map((p) => p.pageNumber)).toEqual([3, 9]);
  });

  it("pages 缺失或不是数组返回 null", () => {
    expect(parseSidecarBatchOutput({})).toBeNull();
    expect(parseSidecarBatchOutput({ pages: "none" })).toBeNull();
    expect(parseSidecarBatchOutput(null)).toBeNull();
  });
});

describe("indexPages", () => {
  it("同页后出现覆盖先出现的（防御性）", () => {
    const map = indexPages([
      parseSidecarPageResult(validPageRaw({ coverage: 0.1 }))!,
      parseSidecarPageResult(validPageRaw({ coverage: 0.2 }))!,
    ]);
    expect(map.size).toBe(1);
    expect(map.get(3)!.coverage).toBeCloseTo(0.2, 5);
  });
});

describe("退出码常量", () => {
  it("0 = 全部成功，2 = 部分成功（与侧车约定一致）", () => {
    expect(SIDECAR_EXIT_OK).toBe(0);
    expect(SIDECAR_EXIT_PARTIAL).toBe(2);
  });
});
