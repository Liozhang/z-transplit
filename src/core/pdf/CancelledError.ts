/**
 * ZTransplitCancelledError — 用户取消的统一错误。
 *
 * 取消不是失败：进度窗、状态行、汇总账目都要把它和"装坏了 / 翻译失败了"分开
 * 呈现。调用方必须按 name 识别（`ZTransplitCancelled`），不能按消息文本比较
 * ——消息走 FTL 本地化，硬编码字符串在切语言后就会失效。zh/en 文案刻意保留
 * 已取消 / cancelled，backendSelector.isInfraError 也据此归类为用户取消。
 *
 * 放在这一层（不依赖任何宿主组件）是为了让翻译管线、识别运行时安装、识别
 * 环境安装共用同一个类——各处自定义一份，消息与名字必然漂移。
 *
 * @module core/pdf/CancelledError
 */

import { getString } from "../../utils/locale";

export class ZTransplitCancelledError extends Error {
  constructor() {
    super(getString("odl-progress-cancelled"));
    this.name = "ZTransplitCancelled";
  }
}
