# 功能融合方案：全文翻译 · 上下对照 · 仅译文 · 朗读 · 缓存

> 基于 TransLift 调研（见会话记录）与本机 Zotero 7.0.15 / 10.0.3 真机验证结果。
> 源码引用均指本机 Zotero 10 master 源码树（D:/github_code/zotero）。

## 0. 结论摘要

| 功能 | 版本要求 | 核心依赖 | 新增工作量 | 分期 |
| --- | --- | --- | --- | --- |
| F0 持久化段落缓存 | 7 + 10 | 无（纯本地） | 小 | **P0** |
| F1 全文翻译 UX 补全 | 7 + 10 | 现有 ODL 流水线 | 小 | **P0** |
| F2 上下对照 | **仅 10** | Zotero 10 SDT 阅读模式 | 大 | **P2** |
| F3 仅译文 | **仅 10** | 同 F2（同一状态机） | 小（随 F2） | **P2** |
| F4 朗读 | 7（降级）+ 10（完整） | Intl.Segmenter / speechSynthesis / ODL bbox | 中 | **P3** |

顺序刻意为之：F0 是其余一切的地基（F2 的懒翻译、F1 的重复翻译、F4 的批量准备都吃它）；
F2/F3 是同一个状态机的两个展示态，必须一起做；F4 依赖 F2 的句子级基础设施（10 端）。

---

## 1. 版本与兼容策略

### 1.1 manifest 调整

现状 `addon/manifest.json` 锁 `strict_min_version: "7.0"` / `strict_max_version: "7.*"`。
Zotero 10.0.3 直接拒绝安装（真机已复现）。改为：

```json
"strict_min_version": "7.0",
"strict_max_version": "10.*"
```

依据：本插件代码在 10.0.3 上已实际跑通过（真机第一次会话即 10.0.3，面板渲染、
section 注册正常）；Zotero 10 的 `xpcom/reader.js` 保留了与 7 完全一致的
`_internalReader` 属性代理（reader.js:80-83）和 `registerEventListener`
（reader.js:2726），我们依赖的插件面 API 未断裂。

### 1.2 能力矩阵与 feature detection

新增 `src/core/capabilities.ts`，启动时与每次 reader 会话时探测，结果进
`addon.data.capabilities`：

```ts
interface ReaderCapabilities {
  zoteroMajor: number;                    // 7 | 10
  sdtAvailable: boolean;                  // _setReadingMode + _loadSDT 存在
  sdtPackReady: boolean | "downloading";  // getSDTReader() 首探（可失败）
  intlSegmenter: boolean;                 // typeof Intl.Segmenter === "function"
  speechSynthesis: boolean;               // typeof speechSynthesis !== "undefined"
}
```

探测原则沿用 `readSelection` 的逐级回退模式：**内部 API 全部走
`typeof x === "function"` 探测，永不裸调**；任何一层缺失都给出明确的披露文案
（复用 pane 的 capability-disclosure 模式），绝不静默失败。

SDT 特别注意：`reader.js` 的 `getSDTReader()` 依赖 `_getSDTPack`，**可能返回
null 或失败**（SDT pack 未就绪/解析失败），`_loadSDT` 有 `sdtProgress` 进度态。
F2 启动链路必须处理三态：就绪 / 下载中（显示进度） / 不可用（降级披露）。

### 1.3 真机回归矩阵

| 版本 | 手段 | 覆盖 |
| --- | --- | --- |
| 7.0.15 | 重新下载便携 zip（禁自动更新，隔离 profile） | 全量回归 + F0/F1/F4 降级路径 |
| 10.0.3 | 独立便携包 + 隔离 profile（**不碰用户 D:\zotero10 实例**） | F2/F3/F4 完整路径 + 全量回归 |

---

## 2. 架构总览

```
src/
├── core/
│   ├── capabilities.ts                 [新] 版本/SDT/TTS 能力探测
│   ├── translation/
│   │   ├── translationCache.ts         [新] F0：持久化段落缓存（L1 内存 LRU + L2 磁盘）
│   │   └── sentenceSplitter.ts         [新] F4：分句（Intl.Segmenter → 正则回退）
│   └── pdf/
│       ├── sdt/
│       │   ├── sdtBridge.ts            [新] F2：SDT 会话（进入/退出阅读模式、取 structure+mapper）
│       │   ├── interleaveView.ts       [新] F2/F3：译文块插入 + 三态样式切换 + 视口懒翻译
│       │   └── lazyQueue.ts            [新] F2：视口驱动翻译队列（Semaphore 并发 + 去重）
│       └── translation/
│           └── translatedAttachment.ts [改] F1：无父条目回退
├── modules/
│   ├── registerItemTreeMenu.ts         [新] F1：条目树右键「翻译为附件」「翻译并分屏」
│   ├── registerReadAloud.ts            [新] F4：朗读控制器 + 工具栏/面板入口
│   └── registerTranslateUI.ts          [改] 面板加双语模式控制区
└── ui/
    └── bilingualControl.ts             [新] F2/F3/F4 共用控制条（面板内 + 可选 reader 工具栏注入）
```

数据流（F2 主链路）：

```
用户点「双语」→ capabilities 探测 → sdtBridge.enterReadingMode()
  → _loadSDT() 得 {structure, mapper} → 解析文本块清单（refPath + text）
  → interleaveView 注入容器与占位块 → IntersectionObserver 盯视口
  → 可见块入 lazyQueue → 查 F0 缓存 → 命中直接填充 / 未命中走 translateParagraphs
  → 成功回填缓存与 DOM；失败显示错误块 + 重试
退出 → 移除注入节点 → 恢复 PDF iframe 可见性
```

---

## 3. F0：持久化段落翻译缓存

### 3.1 动机

现有 `TRANSLATION_CACHE`（translationEngines.ts:626）是**会话内存 LRU（500 条）**，
重启即失。TransLift 的核心体验之一是"三种模式共享同一份译文、重开阅读器不重复
翻译不重复计费"。我们的对应诉求：F2 懒翻译滚动回看不重翻、F1 重跑同一文档秒回、
跨模式（上下/仅译文/全文/划词长段）共享。

### 3.2 设计

**存储**：`{DataDir}/ztransplit/translation-cache/v1/<sha1 前 2 位>/<hash>.json`
（分桶避免单目录膨胀）。单文件 = 一条记录，天然免锁、损坏可独立剔除、增量清理。

```jsonc
{
  "v": 1,
  "key": "<hash>",              // sha1(engine|model|srcLang|tgtLang|normalizedText)
  "engine": "custom",
  "targetLang": "zh-CN",
  "sourceHash": "<hash>",       // = key 的文本分量
  "translated": "……",
  "createdAt": 1730000000000,
  "usedAt": 1730000000000       // LRU 依据
}
```

**键归一化**：`normalizedText = text.replace(/\s+/g, " ").trim()`——PDF 抽取的
空白噪声（软换行、双空格）不应导致缓存 miss。

**写入时机**：`translateParagraphs.ts` 每段成功后同步写；`createTranslator`
（划词路径）只对 > 200 字符的文本走 L2（短句命中率低、文件开销不划算），维持现有
内存 LRU 为主。

**读取时机**：`translateParagraphs` 批处理前先按 key 批量查缓存，命中的段直接
跳过引擎（既省额度也省时间），只把 miss 段送入分批翻译。

**清理**：启动时异步扫描总大小，超 `translate.cache.maxSizeMB`（默认 200MB）时按
`usedAt` LRU 删至 70%；`bootstrap.js#uninstall` 增加删除整个
`ztransplit/translation-cache/` 目录（当前 uninstall 只清 prefs 分支，需补）。

**接口**：

```ts
export function cacheKey(engine: string, model: string, src: string, tgt: string, text: string): string;
export async function getCachedTranslations(keys: string[]): Promise<Map<string, string>>;
export async function putCachedTranslation(rec: CacheRecord): Promise<void>;
export async function pruneCache(maxBytes: number): Promise<number>;
```

**pref**：`translate.cache.enabled`(true)、`translate.cache.maxSizeMB`(200)。

**测试**：roundtrip / 键隔离（换引擎同文不命中）/ 归一化命中 / 损坏文件容错 /
LRU 修剪 / 并发写同键。全部 Node 侧可测（temp dir fixture）。

---

## 4. F1：全文翻译 UX 补全

现有 `translateAndSplitWithOpenDataLoader` 已产出译文附件，缺的是 TransLift 式
"一键 → 自动保存 → 自动打开"闭环与非分屏出口。

### 4.1 条目树右键菜单（新模块 registerItemTreeMenu.ts）

`Zotero.ItemTreeManager.registerMenuItem`（7/10 均支持）注册「Z-Transplit」子菜单：

- **翻译全文（生成译文附件）**——走现有流水线，`openSplitView: false`；
- **翻译并分屏对照**——现有行为；
- 菜单可见性回调里做能力门控（选中项含 PDF 附件 + 引擎就绪），支持多选批量
  （`Zotero.getActiveZoteroPane().getSelectedItems()`，串行 + Semaphore(1) +
  ProgressWindow 汇总进度）。

### 4.2 opendataloaderSplitAdapter 增加输出模式

`TranslateAndSplitOptions` 增加 `outcome: "split" | "attachment"`：

- `attachment`：导入附件后**自动打开**——
  `ZoteroPane.viewAttachment(attachment.id)`（等价"翻译完成后自动打开译文"）；
- `split`：现有行为不变。

### 4.3 非父条目 PDF 回退（对齐 TransLift 2.7.0 修复）

`translatedAttachment.ts#importTranslatedBytes` 现假设存在父条目。增加分支：
附件无 `parentItemID` 时，译文 PDF 作为**新的顶层条目附件**导入（标题
`译文 (lang)`，便于 findLatestTranslation 复用），并在 ProgressWindow 说明。

### 4.4 重复翻译防护

入口先查 F0 缓存覆盖率：全部段落命中时提示"译文缓存完整，直接生成"——流水线跳过
翻译直走渲染合并，重跑同一文档从数分钟降到数秒。

---

## 5. F2+F3：上下对照与仅译文（Zotero 10 SDT）

### 5.1 与现有功能的关系

- **左右对照不新做**：现有分屏（原 PDF | 译文 PDF 两个真实 reader）严格优于
  TransLift 的自建分栏页，保留为左右形态；
- **上下对照 + 仅译文** = SDT 阅读模式视图上的两种展示态，同一状态机：
  `off → interleave → transOnly`（再加隐含态 `original`）。

### 5.2 sdtBridge：SDT 会话管理

```ts
export async function enterBilingualSession(reader: any): Promise<BilingualSession | null>;
export function exitBilingualSession(session: BilingualSession): void;

interface BilingualSession {
  internalReader: any;          // reader._internalReader
  structure: StructuredDocumentText;  // _loadSDT().structure
  sdtView: any;                 // internalReader._primarySDTView
  doc: Document;                // sdtView._iframe.contentDocument
  blocks: BilingualBlock[];     // 文本块清单
}
```

进入序列（全部内部 API，逐一探测）：

1. `internalReader._setReadingMode(true)`（reader.js:989；内部已有
   `_readingModeQueue` 串行化，直接调用安全）；
2. 等待 `_primarySDTView` 出现（轮询 + 超时 5s）；
3. `const { structure, mapper } = await internalReader._loadSDT()`；
4. 从 `sdtView._iframe.contentDocument` 收集文本块元素：渲染器给每个元素写了
   `dataset.refPath`（sdt/lib/renderer.ts:112,199），按 refPath 关联
   `structure` 里的 part chain，取 `getInnerText` 得段落原文；
5. 过滤：纯公式/图片块（无文本或文本长度 < 2）不入队；标题块照常翻译。

退出序列：移除全部注入节点 → `_setReadingMode(false)` → 确认 PDF iframe 可见性
恢复（reader.js:1041-1045 的还原逻辑由官方负责，我们只保证自身节点清干净）。

**标签页关闭防护**：复用 splitViewFactory 的 MutationObserver 模式监听容器移除，
触发 exitBilingualSession，防泄漏。

### 5.3 interleaveView：注入与三态

- 注入容器：每个原文块元素后插入
  `<div class="ztransplit-bi" data-ref-path="…">`，初始态为占位
  （"翻译中…"骨架线，复用 pane 的 CSS 骨架样式）；
- 三态由容器根上的 class 切换，纯 CSS、零重排：
  - `ztransplit-bi-mode-interleave`：原文 + 译文块都显示；
  - `ztransplit-bi-mode-trans-only`：原文块 `display:none`（**不删节点**——
    切回即恢复；批注高亮透传不受影响，因为 SDT 视图的注释层独立于我们注入的块）；
  - `ztransplit-bi-mode-off`：移除我们全部节点（真实退出，走 sdtBridge）；
- 样式约束：全部规则限定在 `#ztransplit-bi-root, .ztransplit-bi` 作用域 + CSS
  变量取主题色（跟随深浅色，对齐我们 preferences.css 的既有约定），不污染官方
  sdt.scss。

### 5.4 lazyQueue：视口驱动懒翻译

- SDT iframe 内挂 `IntersectionObserver`（content realm 对象，从 chrome 侧
  `new iframeDoc.defaultView.IntersectionObserver(...)` 创建，观察我们的译文块）；
- 可见且未翻译 → 入队（`Map<refPath, Promise>` 去重）；
- 队列消费：**优先批量**——把积压的 N 段（≤ 8）合并交给
  `translateParagraphs`（现成的 token 预算分批 + 并发 + 一次重试 + 原文回退），
  并发上限 `Semaphore(2)`；单段零散请求走 `createTranslator`；
- 每段翻译前过 F0 缓存，命中直接填充；
- 成功：占位块替换为译文内容（保留块容器，失败态可重试）；
- 引擎失败：块内显示错误 + 「重试」按钮（复用 pane 错误态文案键）；
- 超出 `translate.maxChars` 的超长段落：按 SDT part chain 已是段落级，极少超限；
  真超限则截断 + 尾注披露（对齐现有 pane 行为）。

### 5.5 生命周期与一致性

- **译文缓存键含 refPath 不必要**——键只由文本内容决定（F0 设计），同一文档同一
  段落在 上下/仅译文/全文附件 间天然共享；
- **模式切换不重翻**：三态切换只动 CSS 类（TransLift 同款行为），DOM 与缓存不动；
- **文档切换**：`onItemChange`/tab 切换时若 session 属于旧 item → 自动退出；
- **折叠(仅译文)时朗读**：见 F4，朗读目标始终是原文（SDT 原文块仍在 DOM 中）。

### 5.6 入口 UI

- 主入口：我们现有的翻译面板 section 增加双语控制区（模式三态 + 进度摘要
  "已译 37/112 段"）——**面板在 7/10 都已真机验证**，零新风险；
- 增强入口（P2 后期）：`Reader.registerEventListener("render", …)` 里尝试向
  reader 工具栏追加「双语」按钮（feature-detect `.toolbar` 存在才注入），注入
  失败静默跳过——面板入口始终可用。

### 5.7 降级披露（Zotero 7 / SDT 不可用）

- 7.x：控制区显示披露条——「上下对照需要 Zotero 10 的阅读模式；当前版本可用：
  分屏对照（左右）、全文翻译附件」+ 一键跳转分屏；
- 10.x 但 SDT pack 未就绪：显示下载进度或「结构解析不可用，已回退分屏」。

---

## 6. F4：朗读

### 6.1 定位

- Zotero 10 自带官方朗读（reader 内置 read-aloud 全套），**SDT 阅读模式下官方
  朗读可直接用**——我们不重复造轮子，F4 的 10 端价值是：在**我们的双语/仅译文
  视图里补「朗读译文」**与句级高亮联动（官方只读原文）；
- Zotero 7 无官方朗读、无 SDT：F4 的 7 端 = 自建完整链路（TransLift 同款降级
  策略：文本层匹配优先、坐标框兜底）。

### 6.2 分句（sentenceSplitter.ts）

```ts
export function splitSentences(text: string, lang: string): SentenceSpan[];
// SentenceSpan = { start, end, text }
```

- 首选 `Intl.Segmenter(granularity: "sentence")`——Gecko 125+ 支持，
  Zotero 10（Gecko 140 esbuild target）可用；**Zotero 7（Gecko 115）无此 API**，
  回退正则分句（`/[^.!?。！？]+[.!?。！？]+["')\]]*\s*/g` + 常见缩写白名单
  e.g./i.e./et al./Fig. 防误切）；
- 两实现输出同构，单测钉住一致性语料（中英混排、缩写、小数）。

### 6.3 播放引擎

- TTS Provider 抽象 `src/core/tts/`：
  - `SystemTTSProvider`：`speechSynthesis`（Gecko 主窗口可用，Windows 走 SAPI，
    免费、离线、零配置——MVP 唯一实现）；
  - 预留 `RemoteTTSProvider` 接口（火山等，后续按需）；
- `ReadAloudController`：play/pause/resume/prev/next/stop + 语速/音色 pref；
  播放队列 = 当前段落句子序列 → 完成后自动跳下一段（顺序沿 SDT 块序 / ODL 块序）；
- 状态按 item 隔离（TransLift FAQ 同款约束：切文献复位，防串音）。

### 6.4 高亮与跟随

| 端 | 当前句定位 | 高亮实现 |
| --- | --- | --- |
| 10 + 双语模式 | SDT 原文块内句子 span（我们在注入时顺手把原文块按句包 `<span class="ztransplit-sent">`？——**不做**，避免改动官方 DOM 影响批注映射；改为只包我们自己的译文块句子） | 译文句 span 高亮 + 调官方朗读高亮原文（若官方引擎已在播则同步） |
| 10 + 原文（无双语） | 直接引导使用官方朗读（披露条说明），不重做 | 官方自带 |
| 7（pdf.js） | 对当前页 textLayer span 做句子文本前缀匹配（TransLift 同款） | 匹配成功：textLayer span 加高亮类；失败：用 ODL 段落 bbox 整段高亮框兜底 |
| 7 高亮框 | 组装期已存的 word/line bbox（odlToAssembly）按句子字符区间裁并 | reader 视图上叠加定位 div（复用分屏 sync 的坐标换算），随缩放更新 |

自动滚动跟随：7 端调 `internalReader.navigate({pageIndex, …})` 翻到当前句所在页；
10 端 SDT 视图内 `scrollIntoView`。

### 6.5 范围裁剪（MVP 明确不做）

- 不做发音人在线合成（火山接接口后续再说）；
- 不做「从任意句起播的拖拽定位」（只做段落级锚点：段落旁「从本段朗读」按钮，
  TransLift 同款）；
- 7 端句级高亮若文本层匹配率低（扫描版 PDF），整段框兜底即可，不做 OCR。

---

## 7. Pref / FTL 增量清单

**addon/prefs.js 新增**（structure-check S4 会强制双向对账）：

```
translate.cache.enabled            true
translate.cache.maxSizeMB          200
reader.bilingual.defaultMode       "off"        # off | interleave | transOnly
reader.bilingual.concurrency       2
readAloud.rate                     1.0
readAloud.voice                    ""           # 空 = 系统默认
```

**FTL 新增**（en-US + zh-CN 双语同步，S5 键覆盖校验把关）：
`bilingual-mode-off/interleave/trans-only`、`bilingual-sdt-unavailable`、
`bilingual-sdt-downloading`、`bilingual-progress`（`{ $done }/{ $total }`）、
`readaloud-play/pause/prev/next/stop`、`readaloud-voice-settings`、
`itemtree-translate-attachment`、`cache-cleared` 等。

---

## 8. 测试计划

### 8.1 单元（vitest，延续 QA harness 模式）

| 模块 | 用例要点 |
| --- | --- |
| translationCache | roundtrip、键隔离、归一化命中、损坏容错、LRU 修剪、并发写 |
| sentenceSplitter | 中英混排、缩写、小数、Segmenter 与正则双实现同构语料 |
| lazyQueue | 视口模拟入队、去重、批量合并边界、失败重试、取消 |
| interleaveView | jsdom 模拟 SDT DOM：插入位置（refPath 对齐）、三态 CSS、占位→译文替换、错误态、退出清理无残留 |
| sdtBridge | 探测三态（可用/下载中/不可用）mock、超时、标签关闭清理 |
| registerItemTreeMenu | 门控、多选串行、无父条目回退 |
| manifest/structure-check | S1 兼容 10 的校验更新、S4/S5 新 pref/FTL 对账 |

### 8.2 真机矩阵

- **7.0.15**：全量回归（现有 166 测对应的手工清单）+ F0 生效验证（重跑同文档提速）+
  F1 附件模式 + F4 降级路径披露；
- **10.0.3**（隔离 profile，不碰用户实例）：F2 进入/滚动/退出全链路、仅译文切换、
  官方朗读共存、SDT pack 未就绪三态、卸载后无残留节点。

---

## 9. 分期实施

| 期 | 内容 | 估量 |
| --- | --- | --- |
| **P0** | F0 缓存 + F1 UX 补全 + manifest 放宽到 10.* + 7/10 双真机回归 | 1–2 天 |
| **P1** | sdtBridge + interleaveView 最小闭环（上下对照可用，固定并发、无懒队列——一次性翻译视口+缓冲区） | 2–3 天 |
| **P2** | lazyQueue 视口懒翻译 + 仅译文态 + 错误/进度完善 + 工具栏注入尝试 | 1–2 天 |
| **P3** | F4 朗读（分句器 → 播放引擎 → 7 端高亮） | 2–3 天 |

每期收口跑全量门控（tsc ×2 / vitest / build / structure-check / test:qa /
check:jar）。

---

## 10. 风险与回退

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| SDT 内部 API 在 10.x 小版本变动 | F2/F3 失效 | 全量 feature-detect + 披露降级（分屏兜底）；真机矩阵锁定 10.0.3 |
| SDT pack 未下载/解析失败 | 双语不可用 | 三态处理 + 明确文案；`sdtProgress` 展示进度 |
| SDT 对复杂版式（公式密集）段落切分质量差 | 对照错位 | 非文本块跳过；错误块可重试；分屏/全文附件始终可用 |
| Gecko 115（Z7）无 Intl.Segmenter | F4 分句 | 正则回退实现 + 同构语料测试 |
| speechSynthesis 在部分系统无声 | F4 不可用 | 朗读设置披露系统语音包要求（TransLift 同款 FAQ） |
| 注入 DOM 与官方渲染/批注层冲突 | 阅读模式异常 | 只做兄弟插入 + 类名全前缀隔离；退出完整清理；MutationObserver 防泄漏 |
| manifest 放宽后 7 上回归 | 老用户受影响 | 7.0.15 回归纳入每期收口 |

---

## 11. 未决问题

1. `strict_max` 填 `"10.*"` 还是直接删掉上限（跟随 Zotero 11）？——倾向填 `10.*`，
   等 11 出来再评估；
2. F2 的批量翻译是否给独立的引擎选择（当前设计：沿用全局 `translate.engineType`，
   与 TransLift「沿用全局配置」一致）；
3. 缓存是否做「按条目导出/导入」（换机器迁移译文）——超出本期范围，登记不做；
4. F4 译文朗读（读中文译文而非原文）是否纳入——TransLift 不做，作为我们的差异化
   候选，默认不做。

---

## 12. 实施记录（2026-09-25/26）

**状态：P0–P3 全部实现，全部门控复绿。** 以下为与计划的差异与真机结果。

### 12.1 交付物

| 模块 | 文件 |
| --- | --- |
| F0 缓存 | `src/core/translation/translationCache.ts`（新增）；`translateParagraphs.ts` 双函数接入（批量路径命中段不进分块、失败段不缓存）；hooks 启动期 LRU 修剪；bootstrap uninstall 清理目录 |
| F1 全文翻译 | `opendataloaderSplitAdapter.ts` 增加 `outcome: "split" \| "attachment"` + `openAttachment` 回调；`translatedAttachment.ts` 无父条目回退为顶层附件；`src/modules/registerItemTreeMenu.ts` 条目右键子菜单（翻译全文 / 翻译并分屏，含已有译文查重与 Java 缺失引导复用） |
| 能力探测 | `src/core/capabilities.ts`（版本/SDT/TTS/Segmenter 四探测） |
| F2/F3 双语 | `src/core/pdf/sdt/sdtBridge.ts`（进入/退出 Zotero 10 阅读模式、块清单采集）、`lazyQueue.ts`（IntersectionObserver 视口懒翻译 + 批量合并 + 并发上限 + abort）、`interleaveView.ts`（译文块注入、三态 CSS、错误重试、句级高亮接口）；`src/ui/bilingualControl.ts` 控制条（挂载于翻译面板 section 内） |
| F4 朗读 | `src/core/readAloud/sentenceSplitter.ts`（Intl.Segmenter + 正则回退，缩写守卫）、`readAloudController.ts`（Web Speech 状态机）、`pdfReaderTts.ts`（pdf.js 页面文本/文本层高亮/翻页跟随）；控制条内 朗读原文/朗读译文 + 播放控制 |
| 兼容 | `manifest.json` `strict_max_version: "10.*"`；prefs +6 键；FTL en-US/zh-CN 各 +20 键 |

### 12.2 与计划的差异（均为调研后修正）

1. **条目树菜单不用 `ItemTreeManager.registerMenuItem` / `MenuManager`**：从 7.0.15
   omni 与 10.x 源码核实——7.0.15 两者皆无，10 用 MenuManager 取代。改为对 7/10
   统一的 `zotero-itemmenu` DOM 注入 + popupshowing 门控（pdf2zh 同款），单一
   代码路径，两版一致。
2. **P1 的「一次性翻译视口+缓冲区」直接以 lazyQueue 实现**：观察对象是注入的
   占位块（仅译文模式下原块 display:none 不会触发 observer——实现期发现并修正
   的设计点）。
3. **7 端朗读高亮不做 ODL bbox 兜底**：文本层匹配失败即无高亮（朗读继续），
   避免为视觉装饰拉起 Java 流水线；记录为后续增强。

### 12.3 真机冒烟（隔离 profile + 代理侧载，进程按 PID 清理）

| 版本 | 结果 |
| --- | --- |
| 7.0.15 | 启动零插件错误；section/设置 pane/条目菜单全部注册；界面截图正常 |
| 10.0.3 | **strict_max 10.* 被接受**；同上全部注册成功；**冒烟抓到并修复一个真 bug**：混合路径分隔符导致 IOUtils `NS_ERROR_FILE_UNRECOGNIZED_PATH`，改用 `PathUtils.join` 后复查为 0 错误 |

### 12.4 门控（最终）

`tsc` ×2 清零；vitest **191/191**（新增 26 测：缓存 8、分句 7、懒队列 6、SDT 块 3
+ IOUtils shim 全链路）；build 2.7s；structure-check **9/9 零警告**（S4 24 键、
S5 135 定义/57 引用）；test:qa 40/40；check:jar OK。XPI 复核：strict_max 10.*、
6 个新 pref、zh-CN 新键、全部新模块符号在 bundle 中。

### 12.5 人工复核（E2E 驱动注入法，2026-09-26，Zotero 10.0.3 真机）

自动化框架无法触发面板内 DOM 按钮，改用**构建产物注入 E2E 驱动**：驱动在插件特权
作用域内以真实 DOM 事件驱动真实 UI 代码（`element.click()` 会触发事件监听器），
全部步骤落 Zotero.debug 日志取证。共 20 个调试周期。

**真机验证通过（全部有日志证据）**：

| 项 | 证据 |
| --- | --- |
| 条目右键菜单渲染 | `menu labels: attachment='翻译全文（生成译文附件）' split='翻译并分屏对照'` |
| 能力探测 | `zotero=10 sdt=true tts=true segmenter=true` |
| 官方阅读模式进入 | `pEnabled=true pView=true` |
| SDT 内容渲染 | 5 块（标题/正文/章节标题） |
| 译文块注入 | `children=10`（5 原文 + 5 译文）、`injected 5 blocks (session.blocks=5)` |
| 视口懒翻译 + 真实引擎 | `progress: 5/5 translated`，样例译文（google 不可达自动切 bing 兜底 + fromLang 修复生效） |
| F0 缓存跨会话复用 | 三次重启后每次 `5/5` 秒回（无引擎调用） |
| 仅译文模式 | `class=true firstP display=none` |
| 朗读译文 | 管线运行至收尾（快失败 TTS 清尾，高亮为瞬态未被驱动采样到） |
| 退出双语 | `exit: _primarySDTView cleared`（arity 修复后） |
| 附件流水线端到端 | `spawning JVM: java -jar …opendataloader-pdf-cli.jar` → 译文 PDF 落库（storage 中存在） |

**复核发现并修复的真实产品缺陷（5 个，均为 mock 测试无法暴露的运行时问题）**：

| # | 缺陷 | 修复 |
| --- | --- | --- |
| R1 | `_setReadingMode` **参数个数陷阱**：`(primary, enabled)` 两参，单参调用使 enabled=undefined → 进入/退出全部静默 no-op（这是此前多轮"视图未出现"的真正根因） | sdtBridge 全部调用显式传 `(true, true)` / `(true, false)`；优先走官方 `_handleReadingModeEnabledChange` |
| R2 | **bundle 作用域无 `AbortController`/`AbortSignal`**（fetch/TextEncoder 可用）→ 引擎全部 HTTP 超时、取消逻辑、openaiCompat 超时在真机全部 ReferenceError | 新增 `src/utils/abort.ts`（主窗口解析 + 定时器兜底），7 处调用点全部替换 |
| R3 | **跨 realm IntersectionObserver 回调静默失败**（chrome 回调 + content 元素）→ 懒翻译永不派发 | lazyQueue 改为**几何轮询**（getBoundingClientRect，700ms，session 窗口定时器） |
| R4 | 仅译文 CSS 选择器写错（模式类在 #sdt-content 自身，选择器却匹配祖先）→ 原文不隐藏 | `#sdt-content.ztransplit-bi-mode-trans-only > [data-ref-path]` |
| R5 | SDT 视图 React 渐进渲染竞态（早取容器为空/被替换）+ 按钮类名冲突（朗读按钮复用 toggle 类导致查询错位） | 等待循环以「可翻译块存在」为准并每轮重取容器；朗读按钮独立类 `ztransplit-bc-ra-btn`；setActive 时清理陈旧状态文本 |

另有：10.0.3 connector saveItems 会话不落附件（Zotero 自身行为，E2E 改用
`Zotero.Attachments.importFromFile` 直灌）；`IOUtils` 混合分隔符路径错误（PathUtils
修复，见 §12.3）。

**复核后全量门控**：tsc ×2 清零、vitest 191/191、build OK、structure-check 9/9
零警告、test:qa 40/40、check:jar OK。

### 12.6 真机剩余（低风险，记录在案；已被 §12.7 全部关闭）

- ~~朗读句级高亮为瞬态，自动化采样未捕获~~ → §12.7 R6/R7：实为真实缺陷，修复后
  双版本均采样到 `highlight: ACTIVE`。
- ~~7.0.15 侧的 Z7 分支路径未做注入式 E2E~~ → §12.7 已在 7.0.15 真机完成注入式
  E2E（披露文案、朗读原文、附件流水线全部取证）。

### 12.7 完整真机实测·第二轮（2026-09-26，Zotero 10.0.3 + 7.0.15 双真机）

针对"有没有完整真机实测"的补全轮：在 §12.5 驱动注入法之上增加**截图窗口**
（驱动在关键状态驻留，外部抓 PNG 人工目验），并把 7.0.15 纳入同一 E2E。
驱动 v21→v28 共八个周期（v28 为终版构建，下表全部证据出自 v28）。

**Zotero 10.0.3（Z10 路径，v28 终版回归日志取证）**：

| 步骤 | 证据（z10-e2e.log） |
| --- | --- |
| 右键菜单 | `menu labels: attachment=… split=…` |
| 能力探测 | `zotero=10 sdt=true tts=true segmenter=true` |
| SDT 进入 | `sdt overlay: ENTERED`（缓存命中时仅 219ms） |
| 块注入 + 真实引擎 | `injected blocks: 6`，`progress: …/6 translated`，样例中文译文 |
| 仅译文 | `class=true firstP display=none` |
| **朗读译文** | `readAloud source=translation` → **`highlight: ACTIVE`** |
| 退出清理 | `exit: _primarySDTView cleared` |
| 附件流水线 | `spawning JVM …` → `pipeline DONE: translation attachments 4 → 5` → 译文 PDF 自动打开 |
| 截图目验 | 对照态（原文下方插入译文块、青色句高亮样式）、仅译文态、自动打开的"译文 (zh-CN)"标签页 |

**Zotero 7.0.15（Z7 路径，同轮）**：

| 步骤 | 证据（z7-e2e.log） |
| --- | --- |
| 能力探测 | `setReadingMode=undefined loadSDT=undefined` → 正确走 Z7 分支 |
| 披露文案 | `双语对照需要 Zotero 10 的阅读模式。当前版本可用：分屏对照（左右）、全文翻译附件。`（逐字） |
| **朗读原文** | `page 1 text=1519 chars, 184 spans (dom=184, task=0, layer=291)` → **`highlight: ACTIVE`** |
| 附件流水线 | `pipeline DONE: translation attachments 7 → 8` |

**本轮复核发现并修复的真实缺陷（R6–R12，全部由真机暴露）**：

| # | 缺陷 | 修复 |
| --- | --- | --- |
| R6 | 朗读译文段形状违反 `ReadAloudSegment` 契约（`translatedReadSegments` 平铺返回 `{refPath,sentenceIndex,text}`，回调却读 `segment.meta`）→ onSentenceStart 抛 TypeError，朗读静默失败 | 段改为 `{text, meta:{refPath,sentenceIndex}}`；onSentenceStart 钩子加隔离 try/catch（钩子故障不得杀死播放） |
| R7 | 朗读译文按钮构建后**永久 disabled**（仅 `setReadAloudPlaying` 解禁，而它只在播放开始后才被调用）→ `.click()` 对禁用按钮不派发事件，E2E 与真实用户同样点不动 | 新增 `refreshReadAloudButtons`，在翻译队列 onProgress / setActive / 播放态三处刷新 |
| R8 | Z7 `pdfDocument.getPage` 返回的 PDFPageProxy 是 content 对象，经 Xray 原型方法不可调用（`page.getTextContent is not a function`） | `page.wrappedJSObject` 解包后再调（同 §12.5 R1 的 Xray 家族问题） |
| R9 | pdf.js `getPageView(index)` 为 **0 基**，传入 1 基页码恒取下一页（单页文档取 undefined）→ span 表恒空 | `getPageView(pageNumber - 1)` |
| R10 | Zotero 7 viewer 的 `TextLayerRenderTask.textDivs` 渲染后仍为空（task=0，与新版 pdf.js 不同）| 优先 DOM 直查 `.textLayer` 子 span（82/122 命中），任务 API 仅作兜底 |
| R11 | reader↔tab 关联建立滞后于点击（7.0.15 偶发一次）：面板显示"未检测到当前阅读器"，而阅读器明明开着 | startSession 内 3×1.2s 重试后再披露失败 |
| R12 | **面板条目绑定陈旧导致拒绝打开的阅读器**：面板是 reader-only（onItemChange 仅 reader tab 启用），但 profile 恢复的旧阅读器 tab 先渲染了面板并绑定其条目；切到新阅读器后，`resolveCurrentReader` 按 itemID 不等拒绝 → 显示"未检测到当前阅读器"（7.0.15 复现：绑定 5，活动阅读器为 7） | `resolveCurrentReader` 改为**始终跟随活动 tab 的阅读器**（reader-only 语义下这就是用户正在看的），itemID 降级为诊断日志 |

**最终门控**：tsc 清零、vitest 191/191、build OK、structure-check 9/9 零警告、
test:qa 26/26 阳性对照组、check:jar OK（24,102,188 字节，
sha256 516ce478…c9ddcba）。

**覆盖矩阵（F0–F4 × 双版本，全部真机取证）**：

| 功能 | Zotero 10.0.3 | Zotero 7.0.15 |
| --- | --- | --- |
| F0 翻译缓存 | ✅ 跨重启秒回（§12.5） | ✅ 同模块（同轮流水线复用） |
| F1 全文翻译附件 | ✅ JVM→译文 PDF 落库+自开 | ✅ 同左（n→n+1） |
| F2 双语对照（SDT 上下对照） | ✅ 注入+懒翻译+截图目验 | ➖ 按设计降级：披露文案引导 |
| F3 仅译文 | ✅ display=none+截图 | ➖ 同上 |
| F4 朗读（原文/译文+句高亮） | ✅ 译文路径 ACTIVE | ✅ 原文路径 ACTIVE |
| 分屏对照（左右，7 既有） | ✅（回归链共用入口） | ✅（同左） |
| 右键菜单/能力探测/披露 | ✅ | ✅ |

### 12.8 补充实测·第三轮（2026-09-26，设置面板 + 语音引擎实证）

针对 §12.7 明示的两项残余，重建最小装置（官方 `_win32.zip` 双版本 + 干净
profile + 代理侧载）运行 prefs-speech 专用驱动（P2）。**又抓到一个用户级
真实缺陷 R13**。

| 项 | 证据（p2-z7.log / p2-z10.log + PNG 目验） |
| --- | --- |
| R13 缺陷暴露 | `_loadPane FAIL Error: not well-formed XML` —— **设置面板在真实 Zotero 中完全无法加载**（7/10 同样失败）。根因：preferences.xhtml 有两个顶层元素 + `<?xml?>` 声明 + `html:` 前缀未声明；插件面板走 XHTML 解析分支（无 defaultXUL），必须自带命名空间声明，此前所有检查都未把该文件当 XML 解析过 |
| R13 修复 | 单一根 `<vbox xmlns="XUL" xmlns:html="XHTML">`，linkset 移入根内，去掉 `<?xml?>`；按 Zotero `_parseXHTMLToFragment` 的真实包装串本地预验证 |
| 设置面板加载（修复后） | Z7 + Z10：`prefs: _loadPane ok` → `pane rendered, enabled=true`，控件（enabled/auto/maxchars/引擎组/密钥框）全部在场，PNG 目验：导航项选中、面板排版正常、中文文案完整 |
| 首选项回写链 | UI 点击 → `round-trip false -> true checkbox=true` → 复原 `restored=false`（双版本一致） |
| **语音引擎实证** | `voices=9 first=Microsoft Huihui`；点击朗读后 **`speaking=true`**，12 秒后 **`still-speaking=true`**（真实发声中，PNG：阅读器打开 test.pdf 期间抓帧），点停止后 **`after-stop=false`** —— 双版本一致 |
| sidenav 定位考古 | Z7/Z10 自定义 section 的 sidenav 按钮带 pluginID 前缀：`data-pane="ztransplit-zotero-org-ztransplit-translate"`；Z10 上下文面板由 `collapsed` 属性控制，true→false 触发 section render |
| 门控（修复后） | build OK、structure-check 9/9 零警告、发布 bundle 无测试驱动 |

**残余（明示）**：朗读的**音量/听感**仍需人耳确认（引擎已实证 `speaking=true`、
SAPI 声音在列，自动化到引擎层为止）。用户自有 Zotero（D:\zotero10）进程
全程未触碰；.verify2 临时装置在归档后清理。

**残余未覆盖（§12.7 所列，已全部由 §12.8 关闭）**。

### 12.9 README 截图轮（2026-09-26/27，为 README 实景图重建装置）

为 README 的五类翻译模式生成实景截图，过程中**再抓出 6 个真实缺陷
（R14–R19）**，全部修复并回归：

| # | 缺陷 | 修复 |
| --- | --- | --- |
| R14 | **仅译文模式渲染空白页**：隐藏选择器 `> [data-ref-path]` 连同样带 data-ref-path 的译文块一起隐藏（`:not()` 排除缺失） | `:not(.ztransplit-bi)` 显式排除；截图实证修复后译文块正常显示 |
| R15 | 字体资产路径手工模板串混分隔符（`{dataDir}/ztransplit/...`）→ 全新数据目录上 IOUtils 直接拒绝（NS_ERROR_FILE_UNRECOGNIZED_PATH），此前各轮恰好未触发 | 3 处全部改 `PathUtils.join`（§12.3 同族问题最后残留） |
| R16 | **跨 realm 字节串**：IOUtils 读出的字体 ArrayBuffer 处于特权 realm，pdf-lib 的 `instanceof ArrayBuffer` 校验失败且 getType 把它报成 "NaN"（`embedFont: font must be of type … NaN`） | 一律返回 bundle realm 的 `new Uint8Array(bytes)`（R1/R8 Xray 家族第三例） |
| R17 | **fontkit 互操作**：`import * as fontkit` 在 esbuild CJS 互操作下丢失 `.create` → 自定义字体嵌入自项目起始就从未成功过，一直静默走 Helvetica 兜底（此前 WinAnsi 报错的真正根源） | 解析 `default ?? namespace`；配套 R19 |
| R18 | **右键「翻译并分屏」缺 openSplitView**：新的条目菜单模块没有把分屏打开器传给流水线 → split 结果必然抛"分屏打开器不可用"（此前 E2E 只测过 attachment 路径） | 动态 import 工厂的 `openSplitView` 传入 |
| R19 | **TTC 字体集合**：Windows 默认中文字体 msyh.ttc 是 TrueType Collection，fontkit.create 返回集合对象（无 createSubset）→ pdf-lib 报 `font.createSubset is not a function` 再次兜底 Helvetica | registerFontkit 传解包包装：`create` 取 `fonts[0]` |

修复后附件与分屏流水线在全新数据目录上完整走通：中文正文以微软雅黑真实
嵌入，零 WinAnsi 错误；分屏 `resizer=true`。

**五类模式实景截图**（docs/screenshots/，全部真实交互触发）：
selection-translate（划词，Z7：真实鼠标拖选 → 刷新选区 → 译文）、
translated-attachment（全文附件自动打开，中文渲染）、split-view（分屏对照）、
bilingual-interleave（上下对照）、translation-only（仅译文）。

**过程发现（记录，不改产品）**：① 驱动的译文完成判定不能用 CJK 检测——
占位文案"翻译中…"本身含汉字；② 深夜网络下引擎可能长时间无响应（74s），
截图轮改用缓存暖启后秒回；③ 测试机屏幕被其他窗口遮挡时 CopyFromScreen
会截到无关内容，截图工具改用 PrintWindow(PW_RENDERFULLCONTENT) 并按
可执行路径过滤目标实例。

**门控**：tsc 清零、vitest 191/191、build OK、structure-check 9/9 零警告、
发布 bundle 无测试驱动。

### 12.10 实装用户真机（2026-09-27，D:\zotero10 实例）

按 leadero 的安装形态（extensions/ 下解包目录）把插件装入用户日常使用的
Zotero 10 实例（默认 profile lel4974k.default）。过程与结论：

- 解包目录直放**不会**被 Zotero 10 启动扫描导入（staged xpi 同样不被消费，
  profile 中 zoteroclaw 长期滞留可证）；最终经 **插件管理器 → 从文件安装**
  完成注册：`ztransplit@zotero.org v0.1.0 active=True`（extensions.json 落盘）。
- 安装后 RunJavaScript 取证：条目右键菜单 DOM 中
  `ztransplit-itemmenu-attachment = 翻译全文（生成译文附件）`、
  `ztransplit-itemmenu-split = 翻译并分屏对照` 均存在且标签正确。
- **R20**：注入的父菜单 label 在 Zotero 10 上被动态覆盖为原生文案
  （"在文献库中显示"；FTL 直查返回 "Z-Transplit" 正常，data-l10n-id 为
  null，非 l10n 问题）→ onShowing 中每次 popupshowing 重设 label（反覆盖），
  修复已同步安装目录，随下次重启生效。

测试边界声明：仅在用户库做了只读验证（菜单/面板/注册），未对用户条目
执行会写入库的翻译操作。
### 12.11 默认值即最佳状态 + 界面语言跟随 Zotero（2026-09-28）

**默认值调整**：`translate.enabled` 默认 false → **true**。此前全新安装后
阅读器面板 section 不注册（§12.8 实测），不符合"装完即最佳可用"；改为默认
开启后所有入口即刻可达，希望静默的用户在设置面板取消勾选即可（面板 section
注销，右键菜单保留以便重新启用）。其余默认复核为最佳：google 引擎（免密钥
+ Bing 兜底）、maxChars 10000、OpenDataLoader enabled、翻译缓存开、双语并发
2、默认上下对照、目标语言跟随 Zotero locale。

**界面语言跟随 Zotero**：getString/Fluent 本就按 Zotero locale 协商（zh-CN
真机实装已证：菜单/面板输出中文）。本轮清掉最后 8 处硬编码中文（批量翻译
进度 ×2、VLM 未配置/空结果、Java 不可用/过旧、JAR 加载失败、解析无页面），
全部迁入 ztransplit-pane.ftl（en-US + zh-CN 双语键），运行时经 getString 输出。
匹配器安全核查：isJavaMissingError / friendlyOdlError 依赖的稳定 token
（java / jar / not configured）在英文文案中保留；功能性正则（译文标题识别
`^(译文|Translated)\(`、字体路径表）按设计保留不动。

门禁：tsc 清零、vitest 223/223、build OK、structure-check 9/9 零警告、
check:jar OK（ODL jar 溯源不变属预期）、发布 bundle 无测试驱动。变更已
同步用户实装目录（extensions/ztransplit@zotero.org，v0.1.0），随下次
重启生效；用户 profile 无显式 enabled 偏好，自动获得新默认。
## 12.12 AI 翻译引擎（prompt 模板 + 模板校验，2026-09-28）

从 leadero 的最小 AI 适配方案移植，落在原有「自定义接口」之外的一个独立引擎
`translate.engineType = "ai"`：自定义接口保持固定提示词、零配置面，AI 引擎把
「发给模型什么」交给用户，插件只保留两件事——语言配置与模板校验。

**prompt 模板契约**（src/core/translation/promptTemplate.ts）：

- 占位符用**双花括号** `{{text}}` / `{{sourceLang}}` / `{{targetLang}}`。语言
  对由插件按语言码解析成可读名称（`zh-CN` → Simplified Chinese，复用
  src/core/tool/language.ts）后注入模板，不直接发语言码。
- 选用双花括号是硬约束：PDF 流水线把公式替换成 `{v0}`、`{v1}` 单花括号标记，
  `{text}` 这种单花括号占位符会和正文内容不可区分。
- 模板留空 = 内置默认模板（formulaPreservingPrompt 的模板化版本，公式保护条款
  一字不差）；设置面板「恢复默认模板」按钮写的就是空串，因此空值必须是合法值。
- 校验规则七条，按"用户能直接改的那条优先"排序：超长 → 未知占位符 → 花括号
  不成对 → 缺 `{{text}}` → `{{text}}` 重复 → 缺 `{{sourceLang}}` → 缺
  `{{targetLang}}`。测试驱动删掉了一条不可达规则（最短长度）：含三个占位符的
  模板天然 ≥36 字符，"太短"只会和"缺少占位符"同时成立并报出更不可操作的那条。
- 每条规则各自一个 Fluent 键：`translation-error-ai-prompt-<reason>`（运行时报
  错，ztransplit.ftl）与 `preferences-ztransplit-ai-prompt-error-<reason>`
  （面板就地提示，ztransplit-preferences.ftl）两套措辞、同一份判定。

**引擎接入**（translationEngines.ts）：

- 走既有 openaiCompat 客户端（无新依赖），温度为 0.3、max_tokens
  `min(len*2, 4000)`、**每请求 120s 超时**（leadero 的 MT helper 漏了超时，
  这块没抄）；空结果错误键改报 `translation-error-ai-empty`（客户端新增
  `emptyResultErrorKey`，不再冒充 custom 的文案）。
- 渲染后的模板即完整 user message，不再另发 system message——否则要么绕过用户
  模板，要么把原文发两遍。
- 缓存身份含模板指纹（djb2）：改一个字的模板就让 F0 持久缓存与内存 LRU 同时
  失效；无效模板 resolve 回默认，因此指纹与默认一致（不会误判成不同配置）。
- 不走批量 JSON（supportsBatching 仍只认 custom）：AI 模板是单篇文本契约，批
  量包装就得绕过用户模板。
- featureReadiness 新增 ai 分支：缺 apiUrl 报 `readiness-reason-engine-url`，
  模板非法报 `readiness-reason-ai-prompt`（把"首次翻译才失败"提前成设置面板
  的指引）。密钥可留空（本地 Ollama / LM Studio 不需要）。

**设置面板**（preferences.xhtml + preferences.js）：引擎下拉新增「AI 翻译
（OpenAI 兼容）」；接口地址/密钥/模型三个输入框按其它引擎的做法挂 `preference`
绑定，prompt 模板编辑区沿用 maxChars/ODL timeout 的 JS 托管套路（读 pref →
校验 → 写 pref，半成品值不落盘，失焦仍非法则恢复当前 pref 值），七条非法原因的
本地化文案走既有的隐藏字符串容器（JS 只搬文本、不写死字符串）。

**测试**：promptTemplate 23 例（接受/拒绝/渲染/指纹）+ 引擎 24 例（默认模板
线格式、语言名注入、模板被完整使用、URL 归一化、无 key 不发 Authorization 头、
空结果键、非法模板零请求直接失败、缓存按模板/模型/端点失效、缓存身份）+ 就绪
5 例 + 面板 22 例。其中「面板 JS 判定与 TS 权威实现同判」用一个 12 样例矩阵把
两份镜像实现钉在一起，防止面板说合法而引擎报错的割裂。

门禁：tsc ×2 清零、vitest **278/278**（22 文件）、build OK、structure-check
9/9 零警告（S4 偏好键 28 个双向一致）、check:jar 无关变更未跑。README 引擎表
与「AI 翻译的提示词模板」小节（中英双语）同步更新。

**未完成（阻塞）**：README 五张模式截图仍是 §12.9 的真实截图，其中
bilingual-interleave.png 的原文块在该 fixture 上渲染成乱码（Zotero 10 阅读
模式字体回退失败）。重拍需要两端条件都不成立：本机无可用翻译端点（Google 被
墙、免密钥 Bing 网页接口返回滥用防护 205、无任何引擎密钥），且隔离 profile 里
的插件注册（extensions.json 条目 + staged XPI 两条路都试过）被 Zotero 的
AddonManager 静默拒绝——连一个极简测试插件都进不去，而随 profile 副本带过来
的 leadero/zsearch 能正常加载；隔离实例的数据目录也曾误连用户库（缺
`-datadir profile`）导致数据库锁死、插件启动直接不执行。

### 12.12.1 AI 引擎实景截图轮（2026-09-28/29，Zotero 10.0.1 + StepFun 真实翻译）

用户指出可用 leadero 生态里已配置的 AI 服务来出真实翻译截图。实测三处可用
端点（zoteroclaw/leadero 的 provider 配置 + 数据目录 ai-debug-request.json），
选定 **StepFun `step-3.7-flash`**（`https://api.stepfun.com/step_plan/v1`，
leadero 翻译功能同款模型）：reasoning 单独放 `reasoning` 字段、`content` 直接
可用；BigModel GLM 端点也可用但 `content` 为空（全部 token 进了思考）。

**装置**（全部 gitignored，仓库与发布产物不含）：`zotero-plugin serve` 的
临时插件安装走 RDP addonsActor（`installTemporaryAddon`）——这就是此前隔离
profile 手写 extensions.json 全部失败的原因，那不是受支持的安装路径；同 ID
重复安装不重跑 bootstrap（升级路径 shutdown→uninstall→install 会重跑）；
插件沙箱没有 `Components`（wantGlobalProperties+Object.assign 均无），文件
标记要用 `IOUtils.write`/`Zotero.File`；`-datadir` 不收正斜杠；新版 RDP 的
`listTabs` 不再暴露 consoleActor，DOM 结构靠一次性诊断 dump（翻译面板在
shadow DOM 里，querySelector 不可见；pdf.js textLayer 在 reader 帧的嵌套
viewer iframe 里）。最终出图链路：驱动设 `_selectionRanges` → 真实鼠标点
「刷新选区」/「双语对照」（后者经 shadow 穿透点击）→ PrintWindow 抓窗。

**产出**（docs/screenshots/）：`ai-engine.png`（AI 引擎设置面板，StepFun
配置 + 提示词模板说明）、`selection-translate.png`（划词面板：源文本 +
StepFun 真实 AI 译文）、`bilingual-interleave.png`（替换原乱码图：真实双语
会话，SDT 重排 + 交错译文块 + 「已译 4/20 段」进度 + 失败块的重试入口）。

**真实发现（记录，待改进）**：step-3.7-flash 为思考模型，逐段请求的
`max_tokens = min(len*2, 4000)` 在短段落上会被 reasoning 吃光导致空 content
被判失败（16/20 块失败、4 块因段落较长幸存）——AI 引擎对思考类模型需要
更高的 max_tokens 下限或可配置输出预算；分屏/全文附件的菜单命令在本轮装置
下未能触发（Zotero 10 的 Zotero_Tabs.jump 内部对 tab 定位报错），沿用
§12.9 的既有实景图。
