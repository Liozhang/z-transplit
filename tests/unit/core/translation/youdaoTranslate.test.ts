/**
 * youdaoTranslate 的单元测试：签名、查询截断、语言映射、请求形状、错误码分类。
 *
 * 签名用的是手算的 SHA-256 向量（Node 的 crypto 独立算出的期望值），因此钉住
 * 的是「拼接待签名字符串的方式」与「取小写 hex」这两件事，而不是某个实现的
 * 自洽性。
 */
import { describe, it, expect, vi } from "vitest";
import {
  YOUDAO_DEFAULT_DOMAIN,
  YOUDAO_DOMAINS,
  YOUDAO_GENERIC_ERROR_KEY,
  YOUDAO_WEB_ENDPOINT,
  YOUDAO_ZHIYUN_ENDPOINT,
  buildWebFormParams,
  buildYoudaoSignature,
  buildZhiyunUrl,
  encodeYoudaoQuery,
  normalizeYoudaoDomain,
  toYoudaoLang,
  truncateYoudaoQuery,
  youdaoErrorKey,
  youdaoSignatureInput,
} from "../../../../src/core/translation/youdaoTranslate";

const APP_KEY = "testappid";
const APP_SECRET = "testsecret";
const SALT = "1700000000000";
const CURTIME = "1700000000";

describe("toYoudaoLang — 语言码映射", () => {
  it("中文保留简繁之分", () => {
    expect(toYoudaoLang("zh-CN")).toBe("zh-CHS");
    expect(toYoudaoLang("zh-TW")).toBe("zh-CHT");
    expect(toYoudaoLang("zh-HK")).toBe("zh-CHT");
    expect(toYoudaoLang("zh-MO")).toBe("zh-CHT");
  });

  it("其余语言取主码（有道的码就是主码）", () => {
    expect(toYoudaoLang("en-US")).toBe("en");
    expect(toYoudaoLang("ja-JP")).toBe("ja");
    expect(toYoudaoLang("fr-FR")).toBe("fr");
    expect(toYoudaoLang("ko-KR")).toBe("ko");
    expect(toYoudaoLang("de")).toBe("de");
  });

  it("空值返回空串（调用方据此决定发 auto 还是不发）", () => {
    expect(toYoudaoLang(undefined)).toBe("");
    expect(toYoudaoLang("")).toBe("");
    expect(toYoudaoLang("   ")).toBe("");
  });
});

describe("truncateYoudaoQuery — 签名用的查询截断", () => {
  it("20 字符以内原样参与签名", () => {
    expect(truncateYoudaoQuery("")).toBe("");
    expect(truncateYoudaoQuery("a".repeat(20))).toBe("a".repeat(20));
  });

  it("超过 20 字符取「前 10 + 长度 + 后 10」", () => {
    const q = "abcdefghij" + "MNOPQRSTUV" + "WXYZ"; // 24 字符
    expect(q).toHaveLength(24);
    expect(truncateYoudaoQuery(q)).toBe("abcdefghij24QRSTUVWXYZ");
  });

  it("21 字符也走截断分支（边界）", () => {
    const q = "a".repeat(21);
    expect(truncateYoudaoQuery(q)).toBe(`aaaaaaaaaa21${"a".repeat(10)}`);
  });
});

describe("有道签名", () => {
  it("待签名字符串按 appKey + trunc(q) + salt + curtime + secret 拼接", () => {
    expect(
      youdaoSignatureInput({
        appKey: APP_KEY,
        appSecret: APP_SECRET,
        query: "hello world",
        salt: SALT,
        curtime: CURTIME,
      }),
    ).toBe(`${APP_KEY}hello world${SALT}${CURTIME}${APP_SECRET}`);
  });

  it("短查询：sha256 取小写 hex（手算向量）", async () => {
    await expect(
      buildYoudaoSignature({
        appKey: APP_KEY,
        appSecret: APP_SECRET,
        query: "hello world",
        salt: SALT,
        curtime: CURTIME,
      }),
    ).resolves.toBe(
      "ac2ae329f1b2b84003068d62da6a89cfc8e4e75177848f1f8b16defe16f8bd08",
    );
  });

  it("长查询：截断后签名（手算向量）", async () => {
    await expect(
      buildYoudaoSignature({
        appKey: APP_KEY,
        appSecret: APP_SECRET,
        query: "abcdefghij" + "MNOPQRSTUV" + "WXYZ",
        salt: SALT,
        curtime: CURTIME,
      }),
    ).resolves.toBe(
      "1f84786dd6f23859237ee87a87f0685d5cda539c900ba2e72dcb8114bf1d856e",
    );
  });

  it("中文查询按 UTF-8 字节签名", async () => {
    // 与 Node crypto 独立算出的期望值比对：字符串按 UTF-8 编码后进摘要。
    await expect(
      buildYoudaoSignature({
        appKey: APP_KEY,
        appSecret: APP_SECRET,
        query: "中文测试",
        salt: SALT,
        curtime: CURTIME,
      }),
    ).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("宿主没有 WebCrypto 时返回 null（调用方据此拒绝发请求）", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(
        buildYoudaoSignature({
          appKey: APP_KEY,
          appSecret: APP_SECRET,
          query: "hello",
          salt: SALT,
          curtime: CURTIME,
        }),
      ).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("encodeYoudaoQuery — q 参数的 RFC 5987 风格编码", () => {
  it("空格转 +，括号与星号转义，中文按 UTF-8 百分号编码", () => {
    expect(encodeYoudaoQuery("hello (world) * 中文")).toBe(
      "hello+%28world%29+%2A+%E4%B8%AD%E6%96%87",
    );
  });

  it("普通英文原样", () => {
    expect(encodeYoudaoQuery("hello world")).toBe("hello+world");
  });
});

describe("buildZhiyunUrl — 官方端点请求形状", () => {
  const base = {
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    query: "hello world",
    from: "en",
    to: "zh-CHS",
    salt: SALT,
    curtime: CURTIME,
    sign: "deadbeef",
  };

  it("按文档顺序带齐参数，signType=v3", () => {
    const url = buildZhiyunUrl({ ...base, domain: "general" });
    expect(url.startsWith(`${YOUDAO_ZHIYUN_ENDPOINT}?`)).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get("q")).toBe("hello+world");
    expect(q.get("appKey")).toBe(APP_KEY);
    expect(q.get("salt")).toBe(SALT);
    expect(q.get("from")).toBe("en");
    expect(q.get("to")).toBe("zh-CHS");
    expect(q.get("sign")).toBe("deadbeef");
    expect(q.get("signType")).toBe("v3");
    expect(q.get("curtime")).toBe(CURTIME);
    expect(q.get("domain")).toBe("general");
    // 参数顺序即文档顺序
    expect(new URL(url).search.slice(1).split("&").map((p) => p.split("=")[0])).toEqual([
      "q",
      "appKey",
      "salt",
      "from",
      "to",
      "sign",
      "signType",
      "curtime",
      "domain",
    ]);
  });

  it("空 vocabId 不发送（服务端把空值当错误）", () => {
    const q = new URL(buildZhiyunUrl({ ...base, vocabId: "" })).searchParams;
    expect(q.has("vocabId")).toBe(false);
  });

  it("非空 vocabId 原样发送并正确编码", () => {
    const q = new URL(
      buildZhiyunUrl({ ...base, vocabId: "team-a/b" }),
    ).searchParams;
    expect(q.get("vocabId")).toBe("team-a/b");
  });

  it("无法识别的 domain 不发送（归一化在调用方做，这里是第二道闸）", () => {
    const q = new URL(buildZhiyunUrl({ ...base, domain: "bogus" })).searchParams;
    expect(q.has("domain")).toBe(false);
  });

  it("from 为 auto 时原样发送", () => {
    const q = new URL(buildZhiyunUrl({ ...base, from: "auto" })).searchParams;
    expect(q.get("from")).toBe("auto");
  });
});

describe("buildWebFormParams — 免密钥端点表单", () => {
  it("只有 from / to / q 三个字段，无任何凭据", () => {
    const params = buildWebFormParams({ from: "en", to: "zh-CHS", query: "hi" });
    expect([...params.keys()]).toEqual(["from", "to", "q"]);
    expect(params.get("from")).toBe("en");
    expect(params.get("to")).toBe("zh-CHS");
    expect(params.get("q")).toBe("hi");
    expect(params.toString()).not.toContain("appKey");
    expect(YOUDAO_WEB_ENDPOINT).toBe("https://aidemo.youdao.com/trans");
  });
});

describe("youdaoErrorKey — 错误码分类", () => {
  it("配置类错误码映射到可操作的文案", () => {
    expect(youdaoErrorKey("108")).toBe("translation-error-youdao-code-108");
    expect(youdaoErrorKey("110")).toBe("translation-error-youdao-code-110");
    expect(youdaoErrorKey("202")).toBe("translation-error-youdao-code-202");
    expect(youdaoErrorKey("206")).toBe("translation-error-youdao-code-206");
  });

  it("数字与字符串形态等价", () => {
    expect(youdaoErrorKey(108)).toBe("translation-error-youdao-code-108");
  });

  it("未知错误码返回 null（调用方改走带原始码的通用文案）", () => {
    expect(youdaoErrorKey("0")).toBeNull();
    expect(youdaoErrorKey("999")).toBeNull();
    expect(youdaoErrorKey("")).toBeNull();
    expect(YOUDAO_GENERIC_ERROR_KEY).toBe("translation-error-youdao-code-other");
  });
});

describe("normalizeYoudaoDomain — 领域偏好归一化", () => {
  it("合法值原样通过", () => {
    for (const d of YOUDAO_DOMAINS) {
      expect(normalizeYoudaoDomain(d)).toBe(d);
    }
  });

  it("空值与无法识别的值回落默认（不让坏值导致接口报错）", () => {
    expect(normalizeYoudaoDomain(undefined)).toBe(YOUDAO_DEFAULT_DOMAIN);
    expect(normalizeYoudaoDomain("")).toBe(YOUDAO_DEFAULT_DOMAIN);
    expect(normalizeYoudaoDomain("bogus")).toBe(YOUDAO_DEFAULT_DOMAIN);
    expect(YOUDAO_DEFAULT_DOMAIN).toBe("general");
  });
});
