/**
 * platformDescriptor 测试（src/core/pdf/JavaRuntimeManager.ts）。
 *
 * platformDescriptor 决定托管 JRE 从 Adoptium 的哪个目录取件——下载地址由
 * {feature}/jre/{arch}/{os}/{packageName} 拼出，架构判定错了会下载一个跑不
 * 起来的运行时。历史上 Linux 固定返回 x64，ARM 设备（能跑 Zotero 的 ARM 笔
 * 记本、开发板）会拿到不可用的 JRE；本文件锁住 win/mac/linux × x64/aarch64
 * 的判定矩阵，用最小宿主桩直接驱动导出的纯判定函数。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { platformDescriptor } from "../../../../src/core/pdf/JavaRuntimeManager";

const saved: Record<string, unknown> = {};

interface HostSpec {
  os: "win" | "mac" | "linux";
  /** 三处架构信号（按 isArm64 的探测顺序，null = 不给该信号）。 */
  sysinfoArch?: string;
  xpcomAbi?: string;
  navigatorPlatform?: string;
  zoteroIsARM?: boolean;
}

function installHost(spec: HostSpec): void {
  const osFlag =
    spec.os === "win" ? { isWin: true, isMac: false, platform: "win32" } : spec.os === "mac"
      ? { isWin: false, isMac: true, platform: "macosx" }
      : { isWin: false, isMac: false, platform: "linux" };
  (globalThis as any).Zotero = {
    ...osFlag,
    ...(spec.zoteroIsARM === undefined ? {} : { isARM: spec.zoteroIsARM }),
  };
  (globalThis as any).Components = {
    classes: {
      "@mozilla.org/xre/app-info;1": {
        getService: () => ({
          OS:
            spec.os === "win" ? "WINNT" : spec.os === "mac" ? "Darwin" : "Linux",
          ...(spec.xpcomAbi === undefined ? {} : { XPCOMABI: spec.xpcomAbi }),
        }),
      },
      "@mozilla.org/system-info;1": {
        getService: () => ({
          get: (k: string) => (k === "arch" ? (spec.sysinfoArch ?? "") : ""),
        }),
      },
    },
    interfaces: {},
    results: { NS_NOINTERFACE: {} },
  };
  if (spec.navigatorPlatform !== undefined) {
    (globalThis as any).navigator = { platform: spec.navigatorPlatform };
  } else {
    delete (globalThis as any).navigator;
  }
}

beforeEach(() => {
  for (const k of ["Zotero", "Components", "navigator"]) {
    saved[k] = (globalThis as any)[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete (globalThis as any)[k];
    else (globalThis as any)[k] = v;
  }
});

describe("platformDescriptor：托管 JRE 的平台与架构判定", () => {
  it("Windows 恒为 x64 zip", () => {
    installHost({ os: "win", xpcomAbi: "x86_64-gnu-win" });
    expect(platformDescriptor()).toEqual({
      os: "windows",
      arch: "x64",
      archive: "zip",
    });
  });

  it("macOS Apple Silicon：系统信息给出 aarch64", () => {
    installHost({ os: "mac", sysinfoArch: "aarch64" });
    expect(platformDescriptor()).toEqual({
      os: "mac",
      arch: "aarch64",
      archive: "tar.gz",
    });
  });

  it("macOS Intel：x86-64 判为 x64", () => {
    installHost({ os: "mac", sysinfoArch: "x86-64" });
    expect(platformDescriptor()).toEqual({
      os: "mac",
      arch: "x64",
      archive: "tar.gz",
    });
  });

  it("Linux x64：XPCOMABI 给出 x86_64", () => {
    installHost({ os: "linux", xpcomAbi: "x86_64-gnu-linux" });
    expect(platformDescriptor()).toEqual({
      os: "linux",
      arch: "x64",
      archive: "tar.gz",
    });
  });

  it("Linux ARM64：XPCOMABI 给出 aarch64（回归：不再固定下载 x64）", () => {
    installHost({ os: "linux", xpcomAbi: "aarch64-gnueabi-linux" });
    expect(platformDescriptor()).toEqual({
      os: "linux",
      arch: "aarch64",
      archive: "tar.gz",
    });
  });

  it("Linux ARM64：系统信息与 ABI 都缺失时落到 navigator.platform", () => {
    installHost({ os: "linux", navigatorPlatform: "Linux aarch64" });
    expect(platformDescriptor().arch).toBe("aarch64");
  });

  it("Linux ARM64：所有探测源都缺失时落到 Zotero.isARM", () => {
    installHost({ os: "linux", zoteroIsARM: true, navigatorPlatform: "" });
    expect(platformDescriptor().arch).toBe("aarch64");
  });
});
