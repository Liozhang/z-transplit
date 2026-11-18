/**
 * platformArch — CPU 架构判定（x64 vs ARM64）。
 *
 * 从 JavaRuntimeManager 的私有实现抽取：运行时分发（JRE、Python 运行时）
 * 都要按机器架构取件，固定下载 x64 会让 ARM 设备（Apple Silicon、aarch64
 * Linux、Windows on ARM）装上跑不起来的运行时。判定逻辑只有一份，避免两处
 * 漂移。
 *
 * 探测顺序：系统信息服务的 arch → XPCOM ABI（Linux 上最可靠，形如
 * "aarch64-gnueabi-linux"）→ navigator.platform → Zotero.isARM。全部来源
 * 都不可靠时按 x64 处理（保守方向：x64 构件覆盖面最广，且 ARM 设备上
 * Windows/macOS 普遍能跑 x64）。
 *
 * Host-coupled（Components / navigator / Zotero）——宿主边界在
 * tests/unit/core/pdf/platformArch.test.ts 中伪造。
 *
 * @module core/pdf/platformArch
 */

import { safeDebug } from "../../utils/logger";

/** ARM64（含 Apple Silicon 与 aarch64 Linux）vs x64。 */
export function isArm64Host(): boolean {
  try {
    const sysinfo = (Components as any).classes[
      "@mozilla.org/system-info;1"
    ]?.getService?.((Components as any).interfaces?.nsIPropertyBag2);
    // macOS machine model / arch hints
    const arch = (sysinfo?.get?.("arch") as string) || "";
    if (/aarch64|arm64/i.test(arch)) return true;
  } catch (e) {
    safeDebug("[Z-Transplit] platformArch: " + e);
    /* ignore */
  }
  try {
    const appinfo = (Components as any).classes[
      "@mozilla.org/xre/app-info;1"
    ]?.getService?.((Components as any).interfaces?.nsIXULRuntime);
    const abi = ((appinfo as any)?.XPCOMABI as string) || "";
    if (/aarch64|arm64/i.test(abi)) return true;
    if (/x86_64|amd64/i.test(abi)) return false;
  } catch (e) {
    safeDebug("[Z-Transplit] platformArch: " + e);
    /* ignore */
  }
  try {
    if (/aarch64|arm64/i.test(navigator?.platform || "")) return true;
  } catch (e) {
    /* ignore */
  }
  // Fallback: Zotero 7+ may expose isARM
  if ((Zotero as any).isARM) return true;
  return false;
}
