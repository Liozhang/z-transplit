/**
 * 译文附件命名辅助函数的契约（translatedAttachment.ts）。
 *
 * 几条硬约束在这里钉死：
 *   1. 磁盘文件基名 = Translated_<原基名>，且原基名先经过文件名清洗——
 *      Windows 非法字符、结尾点号与超长名必须在落盘前消化掉；Zotero 默认
 *      按父条目命名会让原文与译文两个 PDF 在 storage 里同名，前缀消除歧义；
 *   2. 显示标题默认保持 `Translated (<lang>) (` 开头——splitViewCleanup 的
 *      TRANSLATION_TITLE_RE 与条目菜单的内联正则以 `^` 锚定识别译文附件
 *      （查重 + 分屏复用），标题换格式必须先过这一关；
 *   3. 配置命名模板后标题按模板渲染，识别匹配器必须同时认识旧格式与模板
 *      渲染结果，否则查重与分屏复用会漏判；
 *   4. PDF 判定以 attachmentContentType 为主，文件扩展名为兜底（有些来源
 *      下载的大写扩展名文件内容类型为空）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 命名模板偏好经 getPrefDynamic 读取；用可控行为的桩代替 Zotero 全局，
// 默认返回 undefined（= 未配置模板），与真实无模板环境同形。
vi.mock("../../../../../src/utils/prefs", () => ({
  getPrefDynamic: vi.fn(),
}));

import { getPrefDynamic } from "../../../../../src/utils/prefs";

import {
  isPdfAttachment,
  translatedFileBaseName,
  translatedSourceBaseName,
  translatedTitleWithSource,
  translationTitleMatcher,
} from "../../../../../src/core/pdf/translation/translatedAttachment";

const getPrefDynamicMock = vi.mocked(getPrefDynamic);

beforeEach(() => {
  getPrefDynamicMock.mockReturnValue(undefined);
});

describe("translatedSourceBaseName — 原文件基名", () => {
  it("取附件文件名并去掉 .pdf 扩展名", () => {
    expect(translatedSourceBaseName({ attachmentFilename: "paper.pdf" })).toBe(
      "paper",
    );
    expect(
      translatedSourceBaseName({ attachmentFilename: "Paper.PDF" }),
    ).toBe("Paper");
  });

  it("attachmentFilename 缺失时回退到文件路径（正反斜杠均可）", () => {
    expect(
      translatedSourceBaseName({ getFilePath: () => "C:\\lib\\storage\\a b.pdf" }),
    ).toBe("a b");
    expect(
      translatedSourceBaseName({ getFilePath: () => "/data/storage/x.pdf" }),
    ).toBe("x");
  });

  it("无扩展名、空值或空基名时给常量兜底", () => {
    expect(translatedSourceBaseName({ attachmentFilename: "noext" })).toBe(
      "noext",
    );
    expect(translatedSourceBaseName({ attachmentFilename: "  " })).toBe("pdf");
    expect(translatedSourceBaseName(undefined)).toBe("pdf");
    expect(translatedSourceBaseName({})).toBe("pdf");
  });
});

describe("translatedSourceBaseName — 文件名清洗", () => {
  it("Windows 非法字符替换为空格并折叠连续空白", () => {
    expect(
      translatedSourceBaseName({ attachmentFilename: "论文: v2?.pdf" }),
    ).toBe("论文 v2");
    expect(
      translatedSourceBaseName({ attachmentFilename: 'a<b>c"d.pdf' }),
    ).toBe("a b c d");
  });

  it("结尾点号与空格去掉（Windows 拒绝以此类字符结尾的文件名）", () => {
    expect(
      translatedSourceBaseName({ attachmentFilename: "draft....pdf" }),
    ).toBe("draft");
    expect(translatedSourceBaseName({ attachmentFilename: "paper .pdf" })).toBe(
      "paper",
    );
  });

  it("超长基名截断到 100 字符", () => {
    expect(
      translatedSourceBaseName({ attachmentFilename: `${"x".repeat(120)}.pdf` }),
    ).toHaveLength(100);
  });

  it("清洗同样作用于磁盘文件基名", () => {
    expect(translatedFileBaseName({ attachmentFilename: "a:b.pdf" })).toBe(
      "Translated_a b",
    );
  });
});

describe("translatedFileBaseName — 译文磁盘文件基名", () => {
  it("原名前加 Translated_ 前缀", () => {
    expect(translatedFileBaseName({ attachmentFilename: "paper.pdf" })).toBe(
      "Translated_paper",
    );
    expect(
      translatedFileBaseName({ attachmentFilename: "a b (2024).PDF" }),
    ).toBe("Translated_a b (2024)");
  });
});

describe("translatedTitleWithSource — 附件标题（未配置模板）", () => {
  const RECOGNITION_RE = /^(译文|Translated)\s*\(/i;

  it("格式为 Translated (<lang>) · <原基名>", () => {
    expect(translatedTitleWithSource("zh-CN", "paper")).toBe(
      "Translated (zh-CN) · paper",
    );
  });

  it("保持译文识别正则命中（查重与分屏复用的兼容契约）", () => {
    for (const lang of ["zh-CN", "en-US", "ja"]) {
      expect(RECOGNITION_RE.test(translatedTitleWithSource(lang, "paper"))).toBe(
        true,
      );
    }
  });
});

describe("translatedTitleWithSource — 命名模板", () => {
  it("占位符 {lang} {title} {date} 全部替换（date 为 UTC 日期）", () => {
    getPrefDynamicMock.mockReturnValue("译文-{title}-{lang}-{date}");
    expect(translatedTitleWithSource("zh-CN", "paper")).toBe(
      `译文-paper-zh-CN-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("未知占位符按字面保留", () => {
    getPrefDynamicMock.mockReturnValue("{title} v{version}");
    expect(translatedTitleWithSource("en", "paper")).toBe("paper v{version}");
  });

  it("纯空白模板视同未配置，回退旧格式", () => {
    getPrefDynamicMock.mockReturnValue("   ");
    expect(translatedTitleWithSource("en", "paper")).toBe(
      "Translated (en) · paper",
    );
  });

  it("渲染结果为空时回退旧格式（标题永不空白）", () => {
    getPrefDynamicMock.mockReturnValue("{title}");
    expect(translatedTitleWithSource("en", "")).toBe("Translated (en) · ");
  });
});

describe("translationTitleMatcher — 译文标题识别", () => {
  it("未配置模板：只认句首的「译文 (」/「Translated (」前缀，大小写不敏感", () => {
    const matches = translationTitleMatcher();
    expect(matches("译文 (zh-CN) · paper")).toBe(true);
    expect(matches("Translated (zh-CN) · paper")).toBe(true);
    expect(matches("translated (en) · x")).toBe(true);
    expect(matches("paper")).toBe(false);
    expect(matches("My Translated (en) file")).toBe(false);
  });

  it("配置模板后：旧格式仍然命中（已有译文附件不丢识别）", () => {
    getPrefDynamicMock.mockReturnValue("译文-{title}-{lang}");
    const matches = translationTitleMatcher();
    expect(matches("Translated (zh-CN) · paper")).toBe(true);
  });

  it("模板渲染出的标题命中，其余不命中", () => {
    getPrefDynamicMock.mockReturnValue("译文-{title}-{lang}");
    const matches = translationTitleMatcher();
    expect(matches("译文-任意标题-en")).toBe(true);
    // 占位符至少吞一个字符
    expect(matches("译文--")).toBe(false);
    expect(matches("random title")).toBe(false);
  });

  it("模板字面部分按正则转义（括号等元字符不变成通配）", () => {
    getPrefDynamicMock.mockReturnValue("译({title})");
    const matches = translationTitleMatcher();
    expect(matches("译(abc)")).toBe(true);
    expect(matches("译abc")).toBe(false);
  });

  it("{date} 钉死为 YYYY-MM-DD 形状", () => {
    getPrefDynamicMock.mockReturnValue("{date} 译");
    const matches = translationTitleMatcher();
    expect(matches("2024-02-03 译")).toBe(true);
    expect(matches("2024-2-3 译")).toBe(false);
  });
});

describe("isPdfAttachment — PDF 判定", () => {
  it("attachmentContentType 是主信号", () => {
    expect(
      isPdfAttachment({
        attachmentContentType: "application/pdf",
        attachmentFilename: "x",
      }),
    ).toBe(true);
  });

  it("contentType 为空时回退文件扩展名（大小写不敏感）", () => {
    expect(
      isPdfAttachment({
        attachmentContentType: "",
        attachmentFilename: "PAPER.PDF",
      }),
    ).toBe(true);
    expect(isPdfAttachment({ attachmentFilename: "notes.Pdf" })).toBe(true);
    expect(
      isPdfAttachment({
        attachmentContentType: "",
        attachmentFilename: "notes.txt",
      }),
    ).toBe(false);
  });

  it("contentType 明确为 PDF 时没有文件名也成立", () => {
    expect(isPdfAttachment({ attachmentContentType: "application/pdf" })).toBe(
      true,
    );
  });

  it("空值与抛异常的条目都判 false（跨 realm 访问失败不外抛）", () => {
    expect(isPdfAttachment(null)).toBe(false);
    expect(isPdfAttachment(undefined)).toBe(false);
    const hostile = Object.defineProperty({}, "attachmentFilename", {
      get() {
        throw new Error("Permission denied");
      },
    });
    expect(isPdfAttachment(hostile)).toBe(false);
  });
});
