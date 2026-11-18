/**
 * platformArch 测试（src/core/pdf/platformArch.ts）。
 *
 * 架构判定是运行时分发（JRE、Python 运行时）共用的原语：判错会让 ARM 设备
 * 装上跑不起来的运行时。四个探测来源逐层兜底，任一来源给出明确答案都算数；
 * 全部不可靠时按 x64（覆盖面最广）处理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isArm64Host } from "../../../../src/core/pdf/platformArch";

function installHost(opts: {
  sysinfoArch?: string;
  xpcomAbi?: string;
  navigatorPlatform?: string;
  isARM?: boolean;
  sysinfoThrows?: boolean;
  appinfoThrows?: boolean;
}): void {
  const classes: Record<string, any> = {};
  if (opts.sysinfoThrows) {
    classes["@mozilla.org/system-info;1"] = {
      getService: () => {
        throw new Error("no sysinfo");
      },
    };
  } else if (opts.sysinfoArch !== undefined) {
    classes["@mozilla.org/system-info;1"] = {
      getService: () => ({ get: (k: string) => (k === "arch" ? opts.sysinfoArch : "") }),
    };
  }
  if (opts.appinfoThrows) {
    classes["@mozilla.org/xre/app-info;1"] = {
      getService: () => {
        throw new Error("no appinfo");
      },
    };
  } else if (opts.xpcomAbi !== undefined) {
    classes["@mozilla.org/xre/app-info;1"] = {
      getService: () => ({ XPCOMABI: opts.xpcomAbi }),
    };
  }
  (globalThis as any).Components = {
    classes,
    interfaces: { nsIPropertyBag2: {}, nsIXULRuntime: {} },
  };
  // Node 22 的 navigator 是只读 getter，只能用 defineProperty 覆盖
  Object.defineProperty(globalThis, "navigator", {
    value: { platform: opts.navigatorPlatform ?? "" },
    configurable: true,
  });
  (globalThis as any).Zotero = { isARM: opts.isARM };
}

beforeEach(() => {
  installHost({});
});

afterEach(() => {
  delete (globalThis as any).Components;
  delete (globalThis as any).navigator;
  delete (globalThis as any).Zotero;
});

describe("isArm64Host", () => {
  it("系统信息服务的 arch 优先", () => {
    installHost({ sysinfoArch: "aarch64", xpcomAbi: "x86_64-pc-linux-gnu" });
    expect(isArm64Host()).toBe(true);
    installHost({ sysinfoArch: "arm64", xpcomAbi: "x86_64-pc-linux-gnu" });
    expect(isArm64Host()).toBe(true);
  });

  it("系统信息服务缺失时看 XPCOMABI（Linux 最可靠）", () => {
    installHost({ xpcomAbi: "aarch64-gnueabi-linux" });
    expect(isArm64Host()).toBe(true);
    installHost({ xpcomAbi: "x86_64-pc-linux-gnu" });
    expect(isArm64Host()).toBe(false);
  });

  it("前两层都缺失时看 navigator.platform", () => {
    installHost({ sysinfoThrows: true, appinfoThrows: true, navigatorPlatform: "Linux arm64" });
    expect(isArm64Host()).toBe(true);
  });

  it("最后看 Zotero.isARM", () => {
    installHost({ sysinfoThrows: true, appinfoThrows: true, isARM: true });
    expect(isArm64Host()).toBe(true);
  });

  it("全部来源都不可靠：按 x64（覆盖面最广）", () => {
    installHost({ sysinfoThrows: true, appinfoThrows: true });
    expect(isArm64Host()).toBe(false);
  });
});
