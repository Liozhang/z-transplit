/**
 * pythonRuntimeManifest — Python 运行时构件清单的解析与选件（纯函数）。
 *
 * 清单描述"哪个平台该取哪个构件、校验和从哪拿"（见
 * src/core/pdf/lib/PYTHON-RUNTIME.json）。与 jar 的 PROVENANCE 不同，这里
 * 不存单构件指纹：信任锚是上游随发行版一起发布的 SHA256SUMS，安装时现取
 * 现校——同一发行版有六个平台的构件，逐个人工登记指纹只会让人懒得更新，
 * 而"更新时漏登记一个平台"比"不登记"更危险（那会让该平台静默用旧版）。
 *
 * 本模块只做三件事：校验清单结构（任何不符都判无效，宁可装不上也不用错
 * 构件）、按当前平台选件、拼出来源表（镜像在前，规范源殿后）。
 *
 * 纯模块：不碰宿主，可在 Node 单测。
 *
 * @module core/pdf/scan/pythonRuntimeManifest
 */

/** 清单结构版本。解析器只接受这一个值。 */
export const PYTHON_RUNTIME_MANIFEST_SCHEMA = "ztransplit-python-runtime/1";

/** 分发覆盖的平台键（os-arch）。 */
export type PythonPlatform =
  | "win-x64"
  | "win-arm64"
  | "mac-x64"
  | "mac-arm64"
  | "linux-x64"
  | "linux-arm64";

export const PYTHON_PLATFORMS: readonly PythonPlatform[] = [
  "win-x64",
  "win-arm64",
  "mac-x64",
  "mac-arm64",
  "linux-x64",
  "linux-arm64",
];

export interface PythonRuntimeArtifact {
  platform: PythonPlatform;
  /** 发行版里的构件文件名（SHA256SUMS 的第二列即此名）。 */
  file: string;
  /** 解压后相对运行时根目录的可执行文件。 */
  executable: string;
}

export interface PythonRuntimeMirror {
  id: string;
  base: string;
}

export interface PythonRuntimeManifest {
  schema: string;
  name: string;
  upstream: string;
  license: string;
  /** 上游发行标签（如 "20261110"）。 */
  release: string;
  /** CPython 版本号（如 "3.12.16"），仅用于展示。 */
  pythonVersion: string;
  verifiedAt: string;
  /** 校验和清单地址（信任锚，规范源）。 */
  sha256Sums: string;
  mirrors: PythonRuntimeMirror[];
  artifacts: PythonRuntimeArtifact[];
  howToUpdate: string[];
  consumedBy: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isHttpsUrl(v: unknown): v is string {
  return isNonEmptyString(v) && /^https:\/\//i.test(v.trim());
}

/**
 * 校验并归一化清单。任何结构问题都返回 null——调用方（安装入口）据此报
 * "清单不可用"，而不是拿着半份数据去拼下载地址。
 */
export function parsePythonRuntimeManifest(
  raw: unknown,
): PythonRuntimeManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.schema !== PYTHON_RUNTIME_MANIFEST_SCHEMA) return null;
  if (
    !isNonEmptyString(m.name) ||
    !isNonEmptyString(m.upstream) ||
    !isNonEmptyString(m.license) ||
    !isNonEmptyString(m.release) ||
    !isNonEmptyString(m.pythonVersion) ||
    !isNonEmptyString(m.verifiedAt) ||
    !isNonEmptyString(m.consumedBy)
  ) {
    return null;
  }
  if (!isHttpsUrl(m.sha256Sums)) return null;

  const mirrors: PythonRuntimeMirror[] = [];
  if (Array.isArray(m.mirrors)) {
    for (const item of m.mirrors) {
      if (!item || typeof item !== "object") return null;
      const { id, base } = item as Record<string, unknown>;
      if (!isNonEmptyString(id) || !isHttpsUrl(base)) return null;
      mirrors.push({ id: id.trim(), base: base.trim().replace(/\/+$/, "") });
    }
  } else if (m.mirrors !== undefined) {
    return null;
  }

  if (!Array.isArray(m.artifacts)) return null;
  const artifacts: PythonRuntimeArtifact[] = [];
  const seen = new Set<string>();
  for (const item of m.artifacts) {
    if (!item || typeof item !== "object") return null;
    const { platform, file, executable } = item as Record<string, unknown>;
    if (typeof platform !== "string" || !PYTHON_PLATFORMS.includes(platform as PythonPlatform)) {
      return null;
    }
    if (seen.has(platform)) return null; // 同平台两条记录：选件会随机
    if (!isNonEmptyString(file) || !isNonEmptyString(executable)) return null;
    // 文件名里的路径分隔符会让拼出的 URL 指向别处；可执行路径同理。
    if (/[\\/]/.test(file)) return null;
    if (executable.includes("..")) return null;
    seen.add(platform);
    artifacts.push({
      platform: platform as PythonPlatform,
      file: file.trim(),
      executable: executable.trim(),
    });
  }
  // 六个平台必须齐：缺一个，该平台的用户装不上，且失败点在后半夜的下载里。
  if (artifacts.length !== PYTHON_PLATFORMS.length) return null;

  const howToUpdate: string[] = [];
  if (Array.isArray(m.howToUpdate)) {
    for (const step of m.howToUpdate) {
      if (typeof step === "string") howToUpdate.push(step);
    }
  }

  return {
    schema: m.schema as string,
    name: m.name.trim(),
    upstream: m.upstream.trim(),
    license: m.license.trim(),
    release: m.release.trim(),
    pythonVersion: m.pythonVersion.trim(),
    verifiedAt: m.verifiedAt.trim(),
    sha256Sums: m.sha256Sums.trim(),
    mirrors,
    artifacts,
    howToUpdate,
    consumedBy: m.consumedBy.trim(),
  };
}

/** 操作系统名 → 平台键前缀（"windows" 缩写为 "win"，与构件三元组对齐）。 */
const OS_PREFIX: Record<"windows" | "mac" | "linux", string> = {
  windows: "win",
  mac: "mac",
  linux: "linux",
};

/** 架构名 → 平台键后缀（探针给的 "aarch64" 在键里写 "arm64"）。 */
const ARCH_SUFFIX: Record<"x64" | "aarch64", string> = {
  x64: "x64",
  aarch64: "arm64",
};

/** os-arch → 平台键。不在覆盖表内（如 32 位 Windows）返回 null。 */
export function pythonPlatformFor(
  os: "windows" | "mac" | "linux",
  arch: "x64" | "aarch64",
): PythonPlatform | null {
  const key = `${OS_PREFIX[os]}-${ARCH_SUFFIX[arch]}`;
  return (PYTHON_PLATFORMS as readonly string[]).includes(key)
    ? (key as PythonPlatform)
    : null;
}

export function artifactForPlatform(
  manifest: PythonRuntimeManifest,
  platform: PythonPlatform,
): PythonRuntimeArtifact | null {
  return manifest.artifacts.find((a) => a.platform === platform) ?? null;
}

/** 规范源基础地址：由校验和清单地址去掉末尾两级（/<标签>/SHA256SUMS）。 */
export function canonicalBaseUrl(manifest: PythonRuntimeManifest): string {
  const cut = manifest.sha256Sums.replace(/\/+$/, "").lastIndexOf("/");
  if (cut <= "https://".length) return manifest.sha256Sums;
  const withoutFile = manifest.sha256Sums.slice(0, cut);
  const cut2 = withoutFile.lastIndexOf("/");
  return cut2 <= "https://".length ? withoutFile : withoutFile.slice(0, cut2);
}

/**
 * 候选来源表：镜像在前（境内友好），规范源殿后（全球兜底）。字节对不上
 * 指纹就换下一个——地址只是"从哪拿"，不是信任边界。
 */
export function artifactSources(
  manifest: PythonRuntimeManifest,
  artifact: PythonRuntimeArtifact,
): Array<{ id: string; url: string }> {
  const file = encodeURIComponent(artifact.file);
  const release = encodeURIComponent(manifest.release);
  const sources: Array<{ id: string; url: string }> = [];
  for (const mirror of manifest.mirrors) {
    sources.push({ id: mirror.id, url: `${mirror.base}/${release}/${file}` });
  }
  sources.push({
    id: "upstream",
    url: `${canonicalBaseUrl(manifest)}/${release}/${file}`,
  });
  return sources;
}

/**
 * 从 SHA256SUMS 文本里取某个文件名的指纹。格式是 GNU coreutils 的
 * "<64 位十六进制>  <文件名>"，文件名可能带 "*" 二进制前缀标记。找不到
 * 返回 null——调用方必须把它当"无法验证"，拒绝安装。
 */
export function parseSha256Sums(
  text: string,
  fileName: string,
): string | null {
  if (typeof text !== "string" || !fileName) return null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    if (match[2].trim() === fileName) return match[1].toLowerCase();
  }
  return null;
}
