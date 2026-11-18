/**
 * pythonRuntimeInstallUi — 识别运行时安装的进度窗口包装。
 *
 * 与 Java 运行库的 installManagedJavaWithProgress 同一形状：下载/解包在主包
 * 内跑，进度经 Zotero.ProgressWindow 显示在主窗口（设置面板跑在 Cu.Sandbox，
 * 拿不到主窗口，只能通过 Zotero.ZTransplit.python.install 调用到这里）。重复
 * 点击共享同一次安装——取件层已按目标去重，这里再挡一层，避免两个进度窗叠在
 * 一起。
 *
 * Host-coupled（ProgressReporter / Zotero 主窗口）。
 *
 * @module core/pdf/scan/pythonRuntimeInstallUi
 */

import { getString } from "../../../utils/locale";
import { safeDebug } from "../../../utils/logger";
import { ProgressReporter } from "../../../utils/progressWindow";
import {
  installPythonRuntime,
  pythonInstallMessage,
  type PythonInstallProgress,
} from "./pythonRuntime";

/** 并发安装请求共享一次运行，第二个点击只会拿到同一个 Promise。 */
let installUiInFlight: Promise<boolean> | null = null;

export function installPythonRuntimeWithProgress(): Promise<boolean> {
  if (installUiInFlight) return installUiInFlight;
  installUiInFlight = runInstall().finally(() => {
    installUiInFlight = null;
  });
  return installUiInFlight;
}

async function runInstall(): Promise<boolean> {
  const progress = new ProgressReporter({
    window: (Zotero as any).getMainWindow?.() || null,
    headline: getString("py-progress-window"),
  });
  try {
    // 下载按网络分片上报（几十 MB 会有上百次），只报阶段切换与整数十档，
    // 且始终写同一行——否则进度窗会刷出几十行近似文案。
    let lastDownloadStep = -1;
    await installPythonRuntime({
      onProgress: (p: PythonInstallProgress) => {
        try {
          if (p.phase === "downloading") {
            const step = Math.floor((p.percent || 0) / 10) * 10;
            if (step === lastDownloadStep) return;
            lastDownloadStep = step;
            progress.fraction(
              p.percent || 0,
              100,
              pythonInstallMessage(p),
            );
            return;
          }
          progress.note(pythonInstallMessage(p));
        } catch (e) {
          safeDebug("[Z-Transplit] pythonRuntimeInstallUi: " + e);
          /* best-effort */
        }
      },
    });
    progress.settle(getString("py-progress-done"), 8000);
    return true;
  } catch (e: any) {
    safeDebug("[Z-Transplit] pythonRuntimeInstallUi: install failed: " + e);
    progress.fail(
      "✗ " +
        getString("py-error-install-failed") +
        `（${String(e?.message ?? e)}）`,
      15000,
    );
    // 进度窗已经呈现过失败，但编程面的调用方（设置面板的状态行）还要靠
    // 这个 rejection 拿细节——与 installOdlJar 的契约一致：install() 只在
    // 成功时 resolve。
    throw e;
  }
}
