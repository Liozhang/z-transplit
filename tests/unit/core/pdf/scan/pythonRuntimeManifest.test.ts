/**
 * pythonRuntimeManifest 测试（src/core/pdf/scan/pythonRuntimeManifest.ts）。
 *
 * 清单是分发链路的第一环：选错平台、漏一个平台、拼错地址，都会在用户的
 * 下载里才爆炸。本文件钉住：
 *   1. 结构校验从严——任何字段缺失/类型不对/平台重复/平台不齐都判无效；
 *   2. 平台映射与选件（含未覆盖平台的 null）；
 *   3. 来源表顺序：镜像在前、规范源殿后，规范源由校验和地址推导；
 *   4. SHA256SUMS 行解析（含 "*" 二进制前缀、大小写、找不到）；
 *   5. 随包清单本身通过解析（数据与解析器不漂移）。
 *
 * 纯函数测试，不碰宿主。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  artifactForPlatform,
  artifactSources,
  canonicalBaseUrl,
  parsePythonRuntimeManifest,
  parseSha256Sums,
  pythonPlatformFor,
  PYTHON_PLATFORMS,
} from "../../../../../src/core/pdf/scan/pythonRuntimeManifest";

const SUMS_URL =
  "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/SHA256SUMS";

function validManifest(): Record<string, unknown> {
  return {
    schema: "ztransplit-python-runtime/1",
    name: "CPython 运行时",
    upstream: "astral-sh/python-build-standalone",
    license: "MIT",
    release: "20261110",
    pythonVersion: "3.12.16",
    verifiedAt: "2026-11-18",
    sha256Sums: SUMS_URL,
    mirrors: [{ id: "cernet-pbs", base: "https://mirrors.cernet.edu.cn/python-build-standalone" }],
    artifacts: PYTHON_PLATFORMS.map((p) => ({
      platform: p,
      file: `cpython-3.12.16+20261110-${p}.tar.gz`,
      executable: p.startsWith("win-") ? "python/python.exe" : "python/bin/python3",
    })),
    howToUpdate: ["第一步"],
    consumedBy: "src/core/pdf/scan/pythonRuntime.ts",
  };
}

describe("parsePythonRuntimeManifest", () => {
  it("合法清单原样解析", () => {
    const m = parsePythonRuntimeManifest(validManifest());
    expect(m).not.toBeNull();
    expect(m!.release).toBe("20261110");
    expect(m!.pythonVersion).toBe("3.12.16");
    expect(m!.artifacts).toHaveLength(6);
    expect(m!.mirrors[0].id).toBe("cernet-pbs");
  });

  it("schema 不符判无效", () => {
    const raw = validManifest();
    raw.schema = "ztransplit-python-runtime/2";
    expect(parsePythonRuntimeManifest(raw)).toBeNull();
  });

  it("缺任一必填字段判无效", () => {
    for (const key of [
      "name",
      "upstream",
      "license",
      "release",
      "pythonVersion",
      "verifiedAt",
      "consumedBy",
      "sha256Sums",
      "artifacts",
    ]) {
      const raw = validManifest();
      delete (raw as Record<string, unknown>)[key];
      expect(parsePythonRuntimeManifest(raw), key).toBeNull();
    }
  });

  it("校验和地址必须是 https", () => {
    const raw = validManifest();
    raw.sha256Sums = "http://example.com/SHA256SUMS";
    expect(parsePythonRuntimeManifest(raw)).toBeNull();
  });

  it("平台不齐判无效（漏一个平台该平台用户装不上）", () => {
    const raw = validManifest();
    (raw.artifacts as Array<{ platform: string }>).pop();
    expect(parsePythonRuntimeManifest(raw)).toBeNull();
  });

  it("平台重复判无效（选件会随机）", () => {
    const raw = validManifest();
    (raw.artifacts as Array<{ platform: string }>)[1].platform = "win-x64";
    expect(parsePythonRuntimeManifest(raw)).toBeNull();
  });

  it("覆盖表外的平台判无效", () => {
    const raw = validManifest();
    (raw.artifacts as Array<{ platform: string }>)[0].platform = "sunos-sparc";
    expect(parsePythonRuntimeManifest(raw)).toBeNull();
  });

  it("文件名带路径分隔符判无效（会拼出越界地址）", () => {
    const raw = validManifest();
    (raw.artifacts as Array<{ file: string }>)[0].file = "../evil.tar.gz";
    expect(parsePythonRuntimeManifest(raw)).toBeNull();
  });

  it("可执行路径带 .. 判无效", () => {
    const raw = validManifest();
    (raw.artifacts as Array<{ executable: string }>)[0].executable = "../../python.exe";
    expect(parsePythonRuntimeManifest(raw)).toBeNull();
  });

  it("mirrors 缺 id 或缺 base 判无效；缺整个字段合法", () => {
    const noId = validManifest();
    delete (noId.mirrors as Array<Record<string, unknown>>)[0].id;
    expect(parsePythonRuntimeManifest(noId)).toBeNull();
    const noBase = validManifest();
    delete (noBase.mirrors as Array<Record<string, unknown>>)[0].base;
    expect(parsePythonRuntimeManifest(noBase)).toBeNull();
    const noMirrors = validManifest();
    delete (noMirrors as Record<string, unknown>).mirrors;
    expect(parsePythonRuntimeManifest(noMirrors)).not.toBeNull();
  });

  it("镜像 base 末尾斜杠被归一（拼 URL 不出双斜杠）", () => {
    const raw = validManifest();
    (raw.mirrors as Array<{ base: string }>)[0].base =
      "https://mirrors.cernet.edu.cn/python-build-standalone/";
    const m = parsePythonRuntimeManifest(raw)!;
    expect(m.mirrors[0].base).toBe("https://mirrors.cernet.edu.cn/python-build-standalone");
  });

  it("非对象输入判无效", () => {
    expect(parsePythonRuntimeManifest(null)).toBeNull();
    expect(parsePythonRuntimeManifest("x")).toBeNull();
    expect(parsePythonRuntimeManifest([])).toBeNull();
  });
});

describe("pythonPlatformFor", () => {
  it("六个组合全部有键", () => {
    expect(pythonPlatformFor("windows", "x64")).toBe("win-x64");
    expect(pythonPlatformFor("windows", "aarch64")).toBe("win-arm64");
    expect(pythonPlatformFor("mac", "x64")).toBe("mac-x64");
    expect(pythonPlatformFor("mac", "aarch64")).toBe("mac-arm64");
    expect(pythonPlatformFor("linux", "x64")).toBe("linux-x64");
    expect(pythonPlatformFor("linux", "aarch64")).toBe("linux-arm64");
  });
});

describe("artifactForPlatform", () => {
  it("按平台键取件", () => {
    const m = parsePythonRuntimeManifest(validManifest())!;
    expect(artifactForPlatform(m, "mac-arm64")!.file).toContain("mac-arm64");
    expect(artifactForPlatform(m, "win-x64")!.executable).toBe("python/python.exe");
  });
});

describe("artifactSources / canonicalBaseUrl", () => {
  it("镜像在前、规范源殿后，规范源由校验和地址推导", () => {
    const m = parsePythonRuntimeManifest(validManifest())!;
    expect(canonicalBaseUrl(m)).toBe(
      "https://github.com/astral-sh/python-build-standalone/releases/download",
    );
    const sources = artifactSources(m, artifactForPlatform(m, "linux-x64")!);
    expect(sources.map((s) => s.id)).toEqual(["cernet-pbs", "upstream"]);
    expect(sources[0].url).toBe(
      "https://mirrors.cernet.edu.cn/python-build-standalone/20261110/cpython-3.12.16%2B20261110-linux-x64.tar.gz",
    );
    expect(sources[1].url).toBe(
      "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-linux-x64.tar.gz",
    );
  });

  it("文件名里的 + 被编码（URL 里裸 + 会被当成空格）", () => {
    const m = parsePythonRuntimeManifest(validManifest())!;
    const sources = artifactSources(m, artifactForPlatform(m, "win-x64")!);
    for (const s of sources) {
      expect(s.url).toContain("%2B");
      expect(s.url).not.toMatch(/[^%2]\+/);
    }
  });
});

describe("parseSha256Sums", () => {
  const text = [
    "5ca7e23bbcc8933a75f4ae9c3a5e5d1ffae5fd143aec9a9d77cf5124cc6e0eef  cpython-3.11.18+20261110-x86_64-pc-windows-msvc-install_only.tar.gz",
    "e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b *cpython-3.12.16+20261110-x86_64-pc-windows-msvc-install_only.tar.gz",
  ].join("\n");

  it("两种分隔格式都能取到（含 * 二进制前缀）", () => {
    expect(
      parseSha256Sums(text, "cpython-3.11.18+20261110-x86_64-pc-windows-msvc-install_only.tar.gz"),
    ).toBe("5ca7e23bbcc8933a75f4ae9c3a5e5d1ffae5fd143aec9a9d77cf5124cc6e0eef");
    expect(
      parseSha256Sums(text, "cpython-3.12.16+20261110-x86_64-pc-windows-msvc-install_only.tar.gz"),
    ).toBe("e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b");
  });

  it("找不到返回 null；大小写不敏感（返回统一小写）", () => {
    expect(parseSha256Sums(text, "not-there.tar.gz")).toBeNull();
    const upper = "E23FE5B16926DE1D81661B1A97352E89FB167549C55A6825796CCD0F32EC7F1B  x.tar.gz";
    expect(parseSha256Sums(upper, "x.tar.gz")).toBe(
      "e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b",
    );
  });
});

describe("随包清单（src/core/pdf/lib/PYTHON-RUNTIME.json）", () => {
  const filePath = path.resolve(
    __dirname,
    "../../../../../src/core/pdf/lib/PYTHON-RUNTIME.json",
  );

  it("是合法 JSON 且通过解析器", () => {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const m = parsePythonRuntimeManifest(raw);
    expect(m, "随包清单必须通过结构校验").not.toBeNull();
    expect(m!.schema).toBe("ztransplit-python-runtime/1");
    expect(m!.artifacts.map((a) => a.platform).sort()).toEqual([...PYTHON_PLATFORMS].sort());
    expect(m!.howToUpdate.length).toBeGreaterThan(0);
  });

  it("每个平台都有可执行路径，且 Windows 与 Unix 布局各一致", () => {
    const m = parsePythonRuntimeManifest(
      JSON.parse(readFileSync(filePath, "utf-8")),
    )!;
    const byPlatform = new Map(m.artifacts.map((a) => [a.platform, a]));
    for (const p of ["win-x64", "win-arm64"]) {
      expect(byPlatform.get(p as never)!.executable).toBe("python/python.exe");
    }
    for (const p of ["mac-x64", "mac-arm64", "linux-x64", "linux-arm64"]) {
      expect(byPlatform.get(p as never)!.executable).toBe("python/bin/python3");
    }
    // 构件名必须带发行标签与平台三元组，且指向 install_only_stripped
    for (const a of m.artifacts) {
      expect(a.file).toContain(m.release);
      expect(a.file).toContain("install_only_stripped.tar.gz");
    }
  });

  it("来源表可拼出六个平台的 https 地址（含镜像）", () => {
    const m = parsePythonRuntimeManifest(
      JSON.parse(readFileSync(filePath, "utf-8")),
    )!;
    for (const a of m.artifacts) {
      const sources = artifactSources(m, a);
      expect(sources.length).toBeGreaterThanOrEqual(2);
      for (const s of sources) expect(s.url.startsWith("https://")).toBe(true);
    }
  });
});
