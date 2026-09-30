/**
 * prefMigrations — 版本化偏好迁移（自 leadero 的 src/utils/prefMigrations.ts
 * 移植）。
 *
 * addon/prefs.js 只为**缺失的键**补默认值，无法在配置结构跨版本变化时改写
 * **已存在**的键的形态（改名、量纲切换、退役清理都属此类）。本模块补上这个
 * 缺口：
 *
 *   - `prefSchemaVersion` 偏好记录已执行到的最新迁移步骤；
 *   - 启动时 migratePrefs() 依序执行 MIGRATIONS 中所有 `from` ≥ 已存版本的
 *     步骤，每步成功后立即写入版本号——中途失败时下次启动从同一步重试，
 *     已完成的步骤不会重复执行；
 *   - 迁移步骤必须防御式编写：读取当前值、变换、写回，遇到畸形输入只记录
 *     并跳过，绝不抛出（迁移永远不能拖垮启动）。
 *
 * 新增迁移：向 MIGRATIONS 追加下一步（版本号顺延），并把 CURRENT_PREF_VERSION
 * 提到该步的 `to`。
 */

import { getPrefDynamic, setPrefDynamic } from "./prefs";
import { safeDebug } from "./logger";

/**
 * 当前偏好结构版本。追加迁移时随之递增。
 * 版本键名以字面量形式写在下方两处调用里（结构检查 S4 按字面量清点偏好键，
 * 常量间接引用会让它误报「声明未读取」）；改动键名时两处同步。
 */
export const CURRENT_PREF_VERSION = 1;

/**
 * 单个迁移步骤。`from` 是本步执行前的版本，`to` 是执行后的版本；按数组
 * 顺序执行。
 */
interface PrefMigration {
  from: number;
  to: number;
  description: string;
  run: () => void;
}

/**
 * 有序迁移步骤表。保持每步可重入、尽量非破坏（改写前先保留回滚余地，
 * 确认稳定后再在后续步骤清理）。
 */
const MIGRATIONS: PrefMigration[] = [
  // ── v0 → v1（基线）────────────────────────────────────────────────────
  // 无结构变化，只是版本标记：首次启动给老安装补写 prefSchemaVersion = 1。
  // 之后真实的偏好结构变化（如批大小从字符量纲改 token 量纲）从这里追加。
  {
    from: 0,
    to: 1,
    description: "Baseline: stamp prefSchemaVersion on pre-existing installs",
    run: () => {
      /* 基线标记，无操作 */
    },
  },
];

/**
 * 执行全部待运行的迁移。每次启动调用都安全：已存版本等于
 * CURRENT_PREF_VERSION 时是空操作。必须在 Zotero 应用完 prefs.js 默认值之后
 * 调用（src/hooks.ts#onStartup 已等 Zotero 初始化完成，时机正确）。
 */
export function migratePrefs(): void {
  try {
    const stored = readStoredVersion();
    if (stored >= CURRENT_PREF_VERSION) return;

    safeDebug(
      `[Z-Transplit] Pref migration: ${stored} → ${CURRENT_PREF_VERSION}`,
    );

    for (const m of MIGRATIONS) {
      if (m.from < stored) continue; // 已应用
      if (m.from >= m.to) continue; // 畸形步骤，跳过
      try {
        safeDebug(
          `[Z-Transplit] Pref migration step ${m.from}→${m.to}: ${m.description}`,
        );
        m.run();
        setPrefDynamic("prefSchemaVersion", m.to);
      } catch (e) {
        // 单步失败不能中断后续独立步骤，也不能损坏状态：记录后停在这里，
        // 下次启动从同一版本重试（失败步骤不会被标记为已应用）。
        safeDebug(
          `[Z-Transplit] Pref migration step ${m.from}→${m.to} FAILED: ${e} — will retry next launch`,
        );
        return;
      }
    }

    safeDebug(`[Z-Transplit] Pref migration complete at v${CURRENT_PREF_VERSION}`);
  } catch (e) {
    // 迁移永远不能破坏启动：偏好处于任何意外状态都只记录。
    safeDebug(`[Z-Transplit] Pref migration aborted (non-fatal): ${e}`);
  }
}

function readStoredVersion(): number {
  const raw = getPrefDynamic("prefSchemaVersion");
  if (raw === undefined || raw === null) return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}
