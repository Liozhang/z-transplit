/**
 * friendlyOdlError / isJavaMissingError / isJavaMissingCause — 用户可见的
 * 错误分类契约。
 *
 * 关键行为：
 *   - HTTP 状态码优先：401/403 → 密钥文案、429 → 配额文案、其余 → 状态码
 *     加响应摘要，不再透出原始英文；
 *   - Java 判定基于启动失败签名，而非裸 "java" 子串 —— java.lang.* 堆栈、
 *     含 "javascript" 的 URL 等不得误入「需要安装 Java」分支；
 *   - isJavaMissingCause 优先读 PdfParseError.reason（结构化），消息文本只
 *     作回退——管道错误在传播中被外壳包装 / 本地化替换，文本匹配会漏。
 *
 * vitest 环境无 Localization，getString 返回 `ztransplit-<key>` 本身，
 * 断言按 key 前缀进行。
 */
import { describe, it, expect } from "vitest";
import {
  friendlyOdlError,
  isJavaMissingError,
  isJavaMissingCause,
} from "../../../../src/core/pdf/splitview/splitViewFactory";
import { PdfParseError } from "../../../../src/core/pdf/PdfParseError";

const KEY = (id: string) => `ztransplit-${id}`;

describe("friendlyOdlError — HTTP 状态码分类", () => {
  it("401/403 映射到密钥无效文案", () => {
    expect(friendlyOdlError("HTTP 401: Unauthorized")).toBe(
      KEY("odl-error-http-auth"),
    );
    expect(friendlyOdlError("Request failed: HTTP 403 (forbidden)")).toBe(
      KEY("odl-error-http-auth"),
    );
  });

  it("429 映射到配额/限流文案", () => {
    expect(friendlyOdlError("HTTP 429: Too Many Requests")).toBe(
      KEY("odl-error-http-rate"),
    );
  });

  it("其他 HTTP 错误保留状态码并截断原始信息", () => {
    const long = "HTTP 500: " + "x".repeat(300);
    const out = friendlyOdlError(long);
    expect(out.startsWith(KEY("odl-error-http-other"))).toBe(true);
    expect(out.length).toBeLessThan(KEY("odl-error-http-other").length + 130);
  });
});

describe("friendlyOdlError / isJavaMissingError — Java 启动失败签名", () => {
  const missing = [
    "Java runtime not found. Please install Java 11+ and add it to PATH.",
    "OpenDataLoader requires Java 11+. Install Java, make sure `java` is on PATH, then retry.",
    "Error: java: command not found",
    "'java' is not recognized as an internal or external command",
    "需要安装 Java 11+",
    "需要安裝 Java",
    "A JVM was not found on this system",
  ];
  it.each(missing)("识别为缺 Java：%s", (msg) => {
    expect(isJavaMissingError(msg)).toBe(true);
    expect(friendlyOdlError(msg)).toBe(KEY("odl-error-java-missing"));
  });

  const notMissing = [
    // 运行中 JVM 的堆栈是运行时错误，不是「未安装」
    "java.lang.NullPointerException at com.example.Translate",
    // URL/模型名里恰好含 "java" 子串
    "GET https://api.example.com/models?filter=javascript failed",
    "java.util.concurrent.TimeoutException while awaiting response",
  ];
  it.each(notMissing)("不误判为缺 Java：%s", (msg) => {
    expect(isJavaMissingError(msg)).toBe(false);
  });

  // 修复「一次安装失败后弹窗再也不出现」时补上的漏网文案：这些错误此前
  // 不匹配任何签名，catch 里只弹普通错误框，用户失去唯一的安装入口。
  const previouslyMissed = [
    // err-java-too-old（zh-CN）：只说"需要 Java 11+"，没有"安装"
    "检测到 Java 8，但 OpenDataLoader 需要 Java 11+。请从 https://adoptium.net 安装较新版本。",
    // 健康预检外壳（err-java-unavailable）
    "Java 不可用：java -version failed",
    "Java unavailable: Error occurred during initialization of VM",
    // checkHealth 探测失败的兜底串
    "java -version failed",
  ];
  it.each(previouslyMissed)("修复后可识别为缺 Java：%s", (msg) => {
    expect(isJavaMissingError(msg)).toBe(true);
    expect(friendlyOdlError(msg)).toBe(KEY("odl-error-java-missing"));
  });

  it("新签名不误伤运行时 JVM 堆栈与 java 子串 URL", () => {
    for (const msg of notMissing) {
      expect(isJavaMissingError(msg)).toBe(false);
    }
  });
});

describe("friendlyOdlError — 组件 jar 错误的两类文案", () => {
  it("jar 确实缺失时提示重新安装", () => {
    expect(
      friendlyOdlError(
        "JAR file not found at C:\\ext\\core\\pdf\\lib\\opendataloader-pdf-cli.jar. Please ensure opendataloader-pdf-cli.jar is present.",
      ),
    ).toBe(KEY("odl-error-jar-missing"));
    expect(
      friendlyOdlError(
        "OpenDataLoader JAR is missing. Reinstall Z-Transplit to restore opendataloader-pdf-cli.jar.",
      ),
    ).toBe(KEY("odl-error-jar-missing"));
  });

  it("jar 存在但 Java 无法访问时给出带路径的不可读文案", () => {
    // JVM 启动器的原文带路径：文案据此引导排查路径字符（系统代码页外的
    // 表情符号等），而不只是一句「检查权限」。
    expect(
      friendlyOdlError(
        "Error: Unable to access jarfile C:\\ext\\core\\pdf\\lib\\opendataloader-pdf-cli.jar",
      ),
    ).toBe(KEY("odl-error-jar-unreadable-path"));
  });

  it("不带路径的不可读文案（err-jar-load 外壳被截断时）仍归类为不可读", () => {
    expect(friendlyOdlError("无法读取解析组件 jar 文件")).toBe(
      KEY("odl-error-jar-unreadable"),
    );
  });

  it("损坏的组件文件指向重新下载，而不是透出 JVM 原文", () => {
    expect(
      friendlyOdlError(
        "java exited with code 1\nstderr: Error: Invalid or corrupt jarfile C:\\x\\opendataloader-pdf-cli.jar",
      ),
    ).toBe(KEY("odl-error-jar-corrupt"));
  });

  it("解析被关闭时指向设置入口，而不是透出英文提示", () => {
    expect(
      friendlyOdlError(
        "OpenDataLoader parsing failed: OpenDataLoader PDF is not enabled. Enable it in Z-Transplit preferences.",
      ),
    ).toBe(KEY("odl-error-parse-disabled"));
  });

  it("解析超时与翻译端点超时分开：解析超时给调大设置的指引", () => {
    expect(friendlyOdlError("OpenDataLoader parsing timed out (300s).")).toBe(
      KEY("odl-error-parse-timeout"),
    );
    expect(friendlyOdlError("Parse timed out (300s)")).toBe(
      KEY("odl-error-parse-timeout"),
    );
    // 翻译端点的超时措辞不同，仍归网络类。
    expect(friendlyOdlError("Request timed out after 30000ms")).toBe(
      KEY("odl-error-network"),
    );
  });

  it("仅提到 jar 字样的运行时错误不再误报组件缺失", () => {
    // 旧实现用裸 includes("jar") 判定，这条会被改写成「解析组件缺失」
    const msg =
      'Exception in thread "main" java.lang.IllegalStateException while reading entry';
    expect(friendlyOdlError(msg)).toBe(msg);
  });
});

describe("isJavaMissingCause — 结构化 reason 优先，文本签名回退", () => {
  it("PdfParseError(java-missing) 判真，即使消息被改写成不匹配的文本", () => {
    const e = new PdfParseError("java-missing", "Java 不可用：任意细节");
    e.message = "被上游重包装过的任意文本";
    expect(isJavaMissingCause(e)).toBe(true);
  });

  it.each(["timeout", "parse-failed", "jar-missing", "no-text"] as const)(
    "PdfParseError(%s) 判假",
    (reason) => {
      expect(isJavaMissingCause(new PdfParseError(reason))).toBe(false);
    },
  );

  it("非 PdfParseError 回退到消息签名匹配", () => {
    expect(isJavaMissingCause(new Error("需要安装 Java 11+"))).toBe(true);
    expect(isJavaMissingCause(new Error("Java 不可用：java -version failed"))).toBe(
      true,
    );
    expect(isJavaMissingCause(new Error("java.lang.NullPointerException"))).toBe(
      false,
    );
    expect(isJavaMissingCause("java executable not found")).toBe(true);
    expect(isJavaMissingCause(undefined)).toBe(false);
  });
});

describe("friendlyOdlError — 其余既有分类不受影响", () => {
  it("超时归入网络错误", () => {
    expect(friendlyOdlError("Request timed out after 30000ms")).toBe(
      KEY("odl-error-network"),
    );
  });

  it("未配置归入配置引导", () => {
    expect(friendlyOdlError("翻译未配置：请先选择引擎")).toBe(
      KEY("odl-error-not-configured"),
    );
    expect(friendlyOdlError("AI engine not configured")).toBe(
      KEY("odl-error-not-configured"),
    );
  });

  it("含 Java 子串的 HTTP 错误仍按 HTTP 分类（优先级）", () => {
    expect(friendlyOdlError("HTTP 401: unauthorized java client")).toBe(
      KEY("odl-error-http-auth"),
    );
  });
});
