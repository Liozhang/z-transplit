/**
 * sidecarEnvInstallUi — 识别环境一键安装的进度窗口包装。
 *
 * 与 Python 运行时、JRE 的安装包装同一形状：安装在主包内跑，进度经
 * Zotero.ProgressWindow 显示在主窗口（设置面板跑在 Cu.Sandbox，拿不到主
 * 窗口，只能通过 Zotero.ZTransplit.sidecarEnv.install 调用到这里）。重复
 * 点击共享同一次安装——取件层已按目标去重，这里再挡一层，避免两个进度窗
 * 叠在一起。
 *
 * 一键安装的耗时结构（进度窗要撑住这么久）：解释器几十兆、依赖几百兆、
 * 模型权重几百兆，弱网下总共可能十几分钟。进度按阶段推进，下载段只有
 * 解释器那一段有百分比（依赖与模型由 pip / 引擎自己下载，拿不到粒度）。
 *
 * Host-coupled（ProgressReporter / Zotero 主窗口）。
 *
 * @module core/pdf/scan/sidecarEnvInstallUi
 */

import { getString } from "../../../utils/locale";
import { safeDebug } from "../../../utils/logger";
import { ProgressReporter } from "../../../utils/progressWindow";
import {
  installSidecarEnv,
  type SidecarEnvCallback,
  type SidecarEnvPhase,
  type SidecarEnvProgress,
} from "./sidecarEnv";

/** 并发安装请求共享一次运行，第二个点击只会拿到同一个 Promise。 */
let installUiInFlight: Promise<boolean> | null = null;

export function installSidecarEnvWithProgress(): Promise<boolean> {
  if (installUiInFlight) return installUiInFlight;
  installUiInFlight = runInstall().finally(() => {
    installUiInFlight = null;
  });
  return installUiInFlight;
}

function phaseMessage(phase: Exclude<SidecarEnvPhase, "failed">): string {
  switch (phase) {
    case "runtime":
      return getString("sidecar-progress-runtime");
    case "script":
      return getString("sidecar-progress-script");
    case "dependencies":
      return getString("sidecar-progress-dependencies");
    case "selftest":
      return getString("sidecar-progress-selftest");
    case "done":
      return getString("sidecar-progress-done");
  }
}

async function runInstall(): Promise<boolean> {
  const progress = new ProgressReporter({
    window: (Zotero as any).getMainWindow?.() || null,
    headline: getString("sidecar-progress-window"),
  });
  try {
    let lastPhase: SidecarEnvPhase | null = null;
    await installSidecarEnv({
      onProgress: (p: SidecarEnvProgress) => {
        try {
          if (p.phase === "runtime" && lastPhase === "runtime") {
            // 解释器下载有粒度：按百分比写进度条
            progress.fraction(p.percent, 100, phaseMessage("runtime"));
            return;
          }
          if (p.phase !== lastPhase) {
            lastPhase = p.phase;
            // failed 阶段不走这里：catch 里用错误详情呈现，阶段文案会把它盖掉
            if (p.phase !== "failed") progress.note(phaseMessage(p.phase));
          }
        } catch (e) {
          safeDebug("[Z-Transplit] sidecarEnvInstallUi: " + e);
          /* best-effort */
        }
      },
    });
    progress.settle(getString("sidecar-progress-done"), 10000);
    return true;
  } catch (e: any) {
    safeDebug("[Z-Transplit] sidecarEnvInstallUi: install failed: " + e);
    progress.fail(
      "✗ " + String(e?.message ?? e),
      20000,
    );
    // 与运行时安装同一契约：install() 只在成功时 resolve，失败抛出让编程面
    // 的调用方（设置面板的状态行）拿到细节。
    throw e;
  }
}

/** 修复入口：先清掉旧环境再装（与 install 共享在飞行去重）。 */
export async function repairSidecarEnvWithProgress(): Promise<boolean> {
  const { discardSidecarEnv } = await import("./sidecarEnv");
  await discardSidecarEnv();
  return installSidecarEnvWithProgress();
}

export type { SidecarEnvCallback, SidecarEnvProgress };
