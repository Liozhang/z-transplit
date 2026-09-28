# z-transplit 移植报告

> 本报告基于 `D:\github_code\z-transplit` 工作区的**实际文件与命令结果**撰写，所有数字均由本会话读取/执行得出（命令与输出见 §6）。leadero 侧的事实来自任务书提供的各阶段清点结果，文中以「清点」标注。

---

## 1. 概述

### 1.1 z-transplit 是什么

`z-transplit` 是一个 **Zotero 7 插件**（manifest `strict_min_version: 7.0`、`strict_max_version: 7.*`，`addon/manifest.json:19-20`），只做两件事：

1. **文本翻译** —— 在阅读器/条目面板里翻译选中的文本；
2. **PDF 保排版翻译 + 分屏对照阅读** —— 把 PDF 译成保持原版式的译文，左右分屏对照阅读。

界面全部用 Zotero 原生 XUL/HTML 构建，**不引入 React、不用 iframe 桥**（`README.md:1-8`）。身份五件套在 `package.json:4-10`：

| 字段 | 值 |
| --- | --- |
| `addonName` | `Z-Transplit` |
| `addonID` | `ztransplit@zotero.org` |
| `addonRef` | `ztransplit` |
| `addonInstance` | `ZTransplit` |
| `prefsPrefix` | `extensions.zotero.ztransplit` |

运行期依赖只有三个（`package.json:24-28`）：`pdf-lib@^1.17.1`、`@pdf-lib/fontkit@^1.1.1`、`zod@^3.25.76`。

### 1.2 从 leadero 移植了什么（按功能域）

| 功能域 | 落地文件（本仓实际路径） | 规模 |
| --- | --- | --- |
| 文本翻译引擎 | `src/core/translation/translationEngines.ts`、`types.ts`、`prompts.ts`、`featureReadiness.ts`；`src/core/ai/openaiCompat.ts`；`src/core/tool/language.ts` | 1167 + 93 + 83 + 123 + 201 + 34 行 |
| PDF 解析后端 | `src/core/pdf/OpenDataLoaderPdfClient.ts`、`OpenDataLoaderJsonAdapter.ts`、`opendataloader-pdf-parser.ts`、`backendSelector.ts`、`PdfIR.ts`、`PdfParseError.ts`、`JavaRuntimeManager.ts`、`platform.ts` | 1211 + 853 + 199 + 205 + 205 + 66 + 659 + 281 行 |
| PDF 保排版翻译/渲染 | `src/core/pdf/translation/` 下 11 个文件（`translationIR`、`odlToAssembly`、`fontStyleParser`、`TextWrapper`、`ImageCompositor`、`LayoutPreservingRenderer`、`ZoteroPdfRasterizer`、`formulaExtractor`、`pdfMerge`、`translatedAttachment`、`translateParagraphs`、`opendataloaderSplitAdapter`） | 3293 行 |
| 分屏视图 | `src/core/pdf/splitview/` 6 个文件（`types`、`readerConfig`、`readerPaneAdapter`、`splitViewSync`、`splitViewCleanup`、`splitViewFactory`） | 2214 行 |
| 阅读器/条目面板 UI | `src/ui/translatePane.ts`、`src/modules/registerTranslateUI.ts` | 892 + 182 行 |
| 公共件 | `src/utils/{prefs,locale,logger,error,json,truncate}.ts`、`src/utils/Semaphore.ts` | 351 行 |
| 脚手架外壳 | `package.json`、`zotero-plugin.config.ts`、`tsconfig*.json`、`vitest.config.ts`、`addon/{manifest.json,bootstrap.js,prefs.js}`、`src/{index,addon,hooks}.ts`、`typings/` | 44 个 `src/**/*.ts`、合计 12456 行 |
| 品牌图标 | `addon/content/icons/` 6 个 SVG | 630～822 B |
| 本地化文案 | `addon/locale/en-US/ztransplit{,-preferences,-pane}.ftl` | 3 个文件 |
| 测试 | `tests/unit/` 6 个 + `tests/node/` 7 个 | 13 个测试文件 |

**未移植**（相对 leadero 的清点范围）：`ai` 引擎及其 ModelRouter / AIProviderRegistry / ConfigManager 三件套、MinerU 备后端及全部远程解析后端、React UI 体系（ChatSidebar / Hub 设置 / tailwind 构建链）、`src/core/agent/**` 其余部分、leadero 的自建 DB 表与 uninstall 清理、35 个 `check-*.cjs` 守卫脚本。

---

## 2. 架构

### 2.1 目录导览

```
z-transplit/
├── addon/                      静态资产，构建时原样复制
│   ├── manifest.json           WebExtension manifest（Zotero applications.id / 版本约束）
│   ├── bootstrap.js            XPI bootstrap：registerChrome + loadSubScript + 注册设置 pane
│   ├── prefs.js                18 个 pref() 默认值（唯一默认值真源）
│   ├── content/
│   │   ├── icons/              6 个 SVG（logo/明暗两版/主题无关 manifest 图标/translate 两尺寸）
│   │   ├── preferences.xhtml   Zotero 7 原生设置面板（XUL 片段）
│   │   ├── preferences.js      面板行为（字段显隐/密钥显示/maxChars 与解析超时校验/插件探测）
│   │   └── preferences.css     面板样式（全部规则收在 #zotero-prefpane-ztransplit 下）
│   ├── locale/en-US/           ztransplit.ftl / -preferences.ftl / -pane.ftl
│   └── scripts/ztransplit.js   ← 构建产物（src/index.ts 的 esbuild 输出）
├── src/
│   ├── index.ts                bundle 入口：_globalThis.addon = new Addon() 并挂 Zotero.ZTransplit
│   ├── addon.ts                Addon 单例（data/hooks/api + splitTranslate/splitView 测试槽）
│   ├── hooks.ts                生命周期：onStartup/onShutdown/onMainWindowLoad/Unload
│   ├── modules/registerTranslateUI.ts   条目面板 section 注册（能力门控）
│   ├── ui/translatePane.ts     阅读器翻译面板（原生 DOM）
│   ├── utils/                  prefs/locale/logger/error/json/truncate/Semaphore
│   ├── core/translation/       引擎派发器 + prompts + types + featureReadiness
│   ├── core/ai/openaiCompat.ts OpenAI 兼容 chat/completions 客户端
│   ├── core/tool/language.ts   语言码 → 语言名
│   └── core/pdf/               解析后端 + translation/ 渲染链 + splitview/ 分屏 + lib/*.jar
├── tests/unit/                 纯 Node vitest（含 2 个 jsdom DOM 测试）
├── tests/node/                 Node-only vitest（可用 node:fs 与真实 fixture）
├── tests/qa/                   结构守卫 fixture 与自测（structure-check）
├── typings/                    global.d.ts 手写；i10n.d.ts / prefs.d.ts 构建期生成
└── .scaffold/build/            zotero-plugin build 产物（z-transplit.xpi + update.json）
```

`src/` 共 44 个 TypeScript 文件、12456 行（`find src -name "*.ts" | wc -l` = 44；`find src -name "*.ts" -exec cat {} + | wc -l` = 12456）。

**入口与生命周期**：`src/index.ts:8-11` 创建 `Addon` 并挂到 `Zotero.ZTransplit`；`src/hooks.ts:11-51` 的 `onStartup` 依次等待 `Zotero.initializationPromise / unlockPromise / uiReadyPromise` → `initLocale()` → 动态 `import("./modules/registerTranslateUI")` 并调 `registerTranslateUI()`；`onShutdown`（`src/hooks.ts:73-86`）反向调 `unregisterTranslateUI()`。分屏/PDF 相关模块**没有**在 `hooks.ts` 里接线（见 §5 与 §6 未覆盖项）。

### 2.2 五种引擎与各自配置

派发总入口 `src/core/translation/translationEngines.ts`（1167 行）。五引擎，统一返回 `{success, translatedText?} | {success:false, error}`（文件头 :15-17）。默认引擎 `google`（`translationEngines.ts:58`）。

| 引擎 | 端点 | 凭据 pref | 就绪判定（`featureReadiness.ts`） |
| --- | --- | --- | --- |
| `google`（默认） | 带 key：`POST https://translation.googleapis.com/language/translate/v2?key=…`（:205）；免 key：`GET https://translate.googleapis.com/translate_a/single?client=gtx&…`（:218） | `translate.google.apiKey`（可选） | 恒就绪（:68-72，keyless + Bing web 兜底都免配置） |
| `bing`（Azure） | `POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from&to`（:256） | `translate.bing.apiKey`（必填）+ `translate.bing.region`（运行期回退 `"global"`，:614） | 缺 apiKey 则列 `readiness-reason-engine-key`（:73-83） |
| `deepl` | `api-free.deepl.com/v2/translate`（`useFree=true`）或 `api.deepl.com/v2/translate`（:477） | `translate.deepl.apiKey` + `translate.deepl.useFree` | 同 bing（:73-83） |
| `custom` | 用户端点，经 `src/core/ai/openaiCompat.ts` 归一化后打 `/chat/completions` | `translate.custom.apiUrl` + `translate.custom.apiKey` + `translate.custom.model`（空则回落 `gpt-3.5-turbo`，:61/:619） | apiUrl 与 apiKey 都必填（:84-100） |
| `zotero-pdf-translate` | 外部插件桥 `Zotero.PDFTranslate.api.translate(text, {pluginID:"ztransplit@zotero.org", langfrom, langto})`（`translationEngines.ts:551-573`） | 无（凭据在外部插件里） | 需 `Zotero.PDFTranslate.api.translate` 存在（`featureReadiness.ts:45-52`） |

**google 的内建兜底**（不可选引擎）：免 key 失败时自动抓 `https://www.bing.com/translator` 的 `params_AbusePreventionHelper[key,token,expiryMs]` 与 data-iid（:326-332），再 POST `{origin}/ttranslatev3?isVertical=1&IG=…&token=…`（:370）。所有免 key 端点统一 10s 超时（`KEYLESS_ENDPOINT_TIMEOUT_MS = 10000`，:117）。

**共用设施**：

- **LRU 缓存**：`TRANSLATION_CACHE`，上限 500 条（`translationEngines.ts:626-627`），键含 engineType/model/凭据/apiUrl/语言对/原文；**超过 5000 字符不走缓存**（:649-650）；`clearTranslationCache()` 可清空（:631）。
- **批量翻译**：`createAIBatchTranslator`（:1053 起）三级降级（结构化 JSON → Markdown 抽 JSON → 逐段），三档超时常量 180000/120000/60000 ms（:1049-1151），空闲预算在非流式下降级为总超时。
- **公式保护**：只有 `custom` 引擎拿得到 `formulaPreservingPrompt`（文件头 :15-17 明说），`{v0}/{v1}` 占位符仅此路径保证。
- **语言映射**：`src/core/tool/language.ts`（34 行，`getLanguageName`），以及引擎内 `toApiSourceLang/toApiTargetLang/toDeepLTargetLang/toBingWebLang`。

### 2.3 文本翻译执行链

```
阅读器/条目面板 (src/ui/translatePane.ts)
  └─ 动态 import src/core/translation/translationEngines
       └─ createTranslator()                      ← 每次调用读一次 pref（:603-621）
            └─ switch(engineType)                 ← 未知 engineType 回落 custom（core 阶段改写）
                 ├─ translateWithGoogle           → 失败自动 translateWithBingWeb
                 ├─ translateWithBing
                 ├─ translateWithDeepL
                 ├─ translateWithCustom           → openaiCompat.chat()
                 └─ translateWithZoteroPdfTranslate
  └─ PDF 侧另有 createAIBatchTranslator()          → openaiCompat.chatJson()（zod 校验 + 一次重试）
```

`openaiCompat`（`src/core/ai/openaiCompat.ts`，201 行）是整个翻译核心里除经典 MT 端点外**唯一**的网络客户端：`chat()` 返回 `{content, usage?}`，`chatJson()` 做 JSON 解析 + zod 校验 + 一次重试；`signal` / `timeoutMs` 直接转发给 `fetch`（文件头 :19-21）。apiKey 为空时不发 `Authorization` 头（core 阶段改写）。

### 2.4 PDF 分屏翻译流水线

总编排 `src/core/pdf/translation/opendataloaderSplitAdapter.ts#translateAndSplitWithOpenDataLoader`（:221）。开跑前先 `assertEngineReady()`（:203，走 `checkTranslationReadiness()`），引擎未就绪时抛出列明缺哪个 pref 的人话错误，而不是在数分钟的解析中途才失败。

```
① ODL 解析      parsePdfWithOpenDataLoader()           src/core/pdf/backendSelector.ts
                → java -jar opendataloader-pdf-cli.jar  src/core/pdf/OpenDataLoaderPdfClient.ts
                → JSON 适配为 PdfDocumentAnalysis       src/core/pdf/OpenDataLoaderJsonAdapter.ts
② 版面装配      odlAnalysisToAssembly()                translation/odlToAssembly.ts
                （bbox 直通、字号钳制、旋转文本跳过、公式块标记、图片抽取）
③ 公式处理      公式块 → LaTeX（视觉模型）或截图回贴      translation/formulaExtractor.ts
                rasterizeRegionToDataURL()             translation/ZoteroPdfRasterizer.ts
④ 段落翻译      translateParagraphs() / translateAllPagesBatched()  translation/translateParagraphs.ts
                （跨页 token 预算分批、并发、一次重试、原文回退）
⑤ 保排版渲染    renderOverlayTranslated()              translation/LayoutPreservingRenderer.ts
                （白 mask 盖原文、CJK/Latin 分 run 绘制、字号与行高双杠杆收缩、公式截图合成）
                或 renderLayoutPreserving() 白底单页模式
⑥ 合并          mergePageBytes()                      translation/pdfMerge.ts（pdf-lib copyPages）
⑦ 译文附件      importTranslatedBytes()               translation/translatedAttachment.ts
                （临时文件 → Zotero.Attachments.importFromFile 挂到原父条目下）
⑧ 分屏          openSplitView()                       splitview/splitViewFactory.ts:89
```

分屏侧依赖：`splitview/readerConfig.ts`（构造 `reader.html` + `createReader`）、`splitview/readerPaneAdapter.ts`（把 `<browser>` 包装成 `ReaderPaneAdapter`）、`splitview/splitViewSync.ts`（双窗格缩放/分数镜像同步）、`splitview/splitViewCleanup.ts`（找兄弟译文附件 + 回收资源）。字体解析在 `src/core/pdf/platform.ts`（按 zh/ja/ko/latin 枚举系统字体），用户可放 `{DataDir}/ztransplit/translation-assets/` 覆盖（`opendataloaderSplitAdapter.ts:93-95`）。Java 运行时由 `JavaRuntimeManager.ts` 管理，解压到 `{DataDir}/ztransplit/java-runtime/`（:101）。

**运行期 jar**：`src/core/pdf/lib/opendataloader-pdf-cli.jar`，24,102,188 字节（`stat -c %s` 实测）。本会话实跑 `sha256sum` 得 `516ce47832a6726e87cb17db77c20174ca8cabbe9a6b56db1418babc7c9ddcba`，与 `src/core/pdf/lib/PROVENANCE.json` 第 6 行的 `sha256` 及第 7 行 `bytes: 24102188` **完全一致**。该 glob 由 `zotero-plugin.config.ts:17` 的 `assets` 保证进 xpi（已在产物中核实，见 §7）。

---

## 3. UI

### 3.1 阅读器翻译面板交互契约

实现：`src/ui/translatePane.ts`（892 行，原生 DOM + `createElementNS` XHTML 命名空间）+ `src/modules/registerTranslateUI.ts`（182 行）。

**注册门控**（`registerTranslateUI.ts:59-85`）：`getPref("translate.enabled")` 为真**且** `checkTranslationReadiness()` 就绪，才调 `Zotero.ItemPaneManager.registerSection`；任一不满足则不注册（paneID `ztransplit-translate`，:29）。header/sidenav 用 `ztransplit-pane.ftl` 的本地化键与 `chrome://ztransplit/content/icons/translate.svg` / `translate-20.svg`（:96-105）。`onItemChange` 仅 `tabType === "reader"` 时启用（:113-119）。`onDestroy` 调 pane 的 `destroy()`（abort 在途请求 + 移除监听 + 移除 DOM 与注入的 `<style>`，`translatePane.ts:849-861`）。

**面板行为契约**（`translatePane.ts` 文件头 :8-34）：

- 挂载即读当前阅读器选区：`reader._internalReader._primaryView._selectionRanges`（:305-321，多段以空行拼接；`_primaryView` 缺失时退回 `_secondaryView`）。
- 三段式：源文本区（含「刷新选区」）→ 语言栏（源=自动检测 → 目标语言输入框，默认 `Zotero.locale`，Enter 触发、IME 合成期不触发）→ 结果区。
- 结果区四态：`loading`（CSS 骨架呼吸线）、`error`（消息 + 重试）、`success`（译文 + 复制）、`idle`（选区就绪但 auto 关 → 给「翻译」按钮，**不**复读「请选择文本」）。
- `translate.auto` **实时读**（每次 refresh 时读 pref），不缓存。
- 翻译在 chrome realm 直接动态 import 引擎模块，不走任何桥。
- **失败 ≠ 空态**：引擎模块加载失败、译文为空、引擎未就绪、超出 `translate.maxChars`（:689-703，显式拒绝并报字数）都给出明确错误。
- 重渲染：Zotero 对同 tab 新 item 会再次 `onRender`，`mountTranslatePane` 按 body 做 WeakMap 幂等（:427/:436-442），命中则 `refresh()`。
- 取消语义受限：`createTranslator` 不接受 AbortSignal，AbortController 只能丢弃过期结果（core/ui 阶段均记录此限制）。

对应的能力披露键（leadero 不可能有）：`pane-translate-no-reader`、`pane-translate-selection-unsupported`（`addon/locale/en-US/ztransplit-pane.ftl:44-45`）。

### 3.2 分屏翻译入口

`src/core/pdf/splitview/splitViewFactory.ts` 导出菜单注册能力，由 `src/hooks.ts#onStartup` 接线（`registerSplitViewMenu()` + `registerOpenDataLoaderMenu()`，`src/hooks.ts:59-61`），`onShutdown` 里按 handler 引用反注册（`src/hooks.ts:101-103`）：

| 导出 | 行 | 作用 |
| --- | --- | --- |
| `registerSplitViewMenu()` | 352 | 注册阅读器空白区右键「分屏对照（不翻译）」 |
| `unregisterSplitViewMenu()` | 470 | 反注册（按 handler 引用） |
| `registerOpenDataLoaderMenu()` | 632 | 注册「翻译并分屏打开」 |
| `unregisterOpenDataLoaderMenu()` | 811 | 反注册 |
| `openSplitView()` | 89 | 分屏总装（容器克隆 + 两个 reader browser + resizer + 并行 attach + installSync） |
| `friendlyOdlError()` / `isJavaMissingError()` | 489 / 537 | 错误人话化 / Java 缺失识别 |

**流程**（`registerOpenDataLoaderMenu` 的 handler，:632-808）：优先复用已有译文附件（`splitViewCleanup.findLatestTranslation`）→ 否则弹 `Zotero.ProgressWindow`（headline `Z-Transplit: OpenDataLoader 翻译中…`，:718）→ 动态 import adapter → `new AbortController()` 存入模块级 `activeTranslationController`（:624）→ `onProgress` 逐条 `addDescription`（:727-736）→ 完成提示 attachment id；取消哨兵是字符串 `"翻译已取消"`（:753）→ Java 缺失走 `handleMissingJava()`（:551，ProgressWindow + 下载 JRE）→ 其它错误 `friendlyOdlError` + nsIPromptService alert。

**取消查重**：菜单项仅在 `activeTranslationController` 非空时追加「取消进行中的翻译」（:643-650），点击即 `controller.abort()`（:647）；`finally` 里清空（:795）。

### 3.3 Zotero 设置界面 pane 结构与每个设置项

入口：**编辑 → 设置 → Z-Transplit**。注册在 `addon/bootstrap.js:23-54`（`registerPreferences` → `Zotero.PreferencePanes.register({pluginID:"ztransplit@zotero.org", src:"content/preferences.xhtml", scripts, stylesheets, id:"zotero-prefpane-ztransplit"})`）。注意 `addon/prefs.js` 里只能写默认值——Zotero 用 `loadSubScriptWithOptions(..., {target:{pref(){}}})` 执行它，作用域里只有 `pref()`（`addon/prefs.js:13-16` 的注释已核实说明）。

pane 本体 `addon/content/preferences.xhtml`（XUL 为默认命名空间，HTML 标签写 `html:` 前缀），行为 `addon/content/preferences.js`，样式 `addon/content/preferences.css`，文案 `addon/locale/en-US/ztransplit-preferences.ftl`。三个分区：

**① 常规**（xhtml:35-107）

| 控件 | preference | 默认 | 说明 |
| --- | --- | --- | --- |
| checkbox 启用文本翻译 | `extensions.zotero.ztransplit.translate.enabled` | `false` | 面板注册的总闸 |
| checkbox 自动翻译 | `…translate.auto` | `false` | 需 enabled；面板实时读 |
| html:input 单次请求字符上限 | `…translate.maxChars` | `10000` | 范围 100–50000；**未挂 preference 属性**，由脚本读→校验→写（空串会让 INT pref 抛异常） |

**② 翻译引擎**（xhtml:109-404）

- `menulist` 引擎选择 → `…translate.engineType`，5 个选项：`engine-google` / `engine-bing` / `engine-deepl` / `engine-custom` / `engine-zotero-pdf-translate`（xhtml:127-160）。
- 按引擎条件显隐的字段组（脚本切 `hidden`，两段状态文案走 `data-l10n-id` 本地化）：
  - google：`…translate.google.apiKey`（可选升级 Cloud API）+「显示密钥」checkbox；
  - bing：`…translate.bing.apiKey`（必填）+ `…translate.bing.region`；
  - deepl：`…translate.deepl.apiKey`（必填）+ `…translate.deepl.useFree` checkbox；
  - custom：`…translate.custom.apiUrl` + `…translate.custom.apiKey` + `…translate.custom.model`（空回落 `gpt-3.5-turbo`）；
  - zotero-pdf-translate：pane 内直接探测 `Zotero.PDFTranslate`（与 `featureReadiness.ts#hasPDFTranslatePlugin` 同一判定），未安装时 menuitem 标签追加「（未安装）」——文案放在 xhtml 隐藏节点由 Fluent 本地化，因为构建只给 xhtml 的 `data-l10n-id` 加前缀、JS 里的字符串 id 不加。
- 「显示密钥」用 checkbox 而非按钮，避免按钮文案在两种本地化状态间切换。

**③ PDF 分屏翻译**（xhtml:406-566）

| 条目 | 内容 |
| --- | --- |
| Java 依赖 | 说明需要 Java 11+，缺失时由「翻译并分屏」菜单触发检测并引导下载便携 JRE |
| 字体覆盖目录 | 显示 `{数据目录}/ztransplit/translation-assets`（由 `Zotero.DataDirectory.dir` 运行时拼出，与 `opendataloaderSplitAdapter.ts:94` 真正读取的路径一致） |
| 译文语言 | `html:input` → `…translation.targetLanguage`（BCP-47 语言码；留空跟随 Zotero 界面语言，`opendataloaderSplitAdapter.ts` 的回落链为 pref → `Zotero.locale` → `zh-CN`） |
| OpenDataLoader 解析选项 | 5 个 `pdfParser.opendataloader.*` 键全部有控件：`enabled` checkbox（解析后端总闸）、`tableEnable` menulist（default/cluster）、`useStructTree` checkbox、`timeout` 数字输入（30–3600 秒，**未挂 preference 属性**，脚本读→校验→写）、`returnImages` checkbox |

每个控件都带 `data-l10n-id`，且都保留了一份静态中文兜底文案（FTL 取不到时面板仍可读）。

---

## 4. Logo

**设计概念「裂页双语」**（`addon/content/icons/ztransplit-light.svg` / `-dark.svg`，各 814 字节，48×48 viewBox）：一页文档沿中缝错位裂成两半——左半页承载拉丁字母 **A**、用中性色，右半页承载汉字「文」、用青色主色；垂直错位即「分屏对照」，A/文对置即「翻译」。整套只用圆角矩形页面 + 2～2.7px 圆头线条、三色体系，16px 仍可靠「裂口双页」剪影辨认。

**暗亮策略**（两个变体几何完全相同，只换三色）：

| 元素 | light | dark |
| --- | --- | --- |
| 背景圆角方块 `rx="10.5"` | `#F1F1F4` | `#26262D` |
| 左半页 + A 字 | `#26252C` | `#ECECF1` |
| 右半页 + 「文」 | `#0E8C7C` | `#3FC9B6` |

manifest 的 `icons` 字段（`addon/manifest.json:8-11`）两个尺寸键都指向主题无关变体 `content/icons/ztransplit-any.svg`（48×48 viewBox，756 B）——Zotero 取插件图标是**纯尺寸匹配**（`Zotero.PreferencePanes` 请求 24px 时恒落到 48 键，`AddonManager.getPreferredIconURL` 不接受主题参数），所以按尺寸分放 light/dark 两变体在暗色主题下会显示亮色方块。该变体去掉不透明底圆角、改用中性 `#7E7E88` + 青 `#1F9E8D` 的中色调，对亮/暗两类背景的对比度均 ≥3:1；几何与另外两个变体完全一致，两个品牌变体仍随仓库交付（README / 设计说明用）。

其余图标：`translate.svg`（24×24，633 B）、`translate-20.svg`（20×20，几何严格为 translate.svg 的 20/24，630 B）、`logo.svg`（128 画布，复用 manifest 暗色变体母版几何与三色，822 B）。

---

## 5. 相对 leadero 的裁剪与改写清单

按域汇总各移植者的 deviations（引号内为原文要点）。

### 5.1 引擎与依赖（core 阶段）

1. **去掉 `ai` 引擎**及其 ModelRouter / AIProviderRegistry / types-ai 依赖：`custom` = OpenAI 兼容端点，经新建的 `src/core/ai/openaiCompat.ts` 承接公式保护 prompt 与批量 JSON 职责；未知 engineType 回退 `custom`（leadero 回退 `ai`），`featureReadiness` 的 default 分支同样按 custom 处理。
2. **custom 单段 prompt 改用 `formulaPreservingPrompt`**（leadero 的 custom 引擎用普通 prompt）；移植测试的相应断言已改写。
3. **token 预算**从 provider 内省改为本地常量 128000/4096 起步；charsPerToken 的 EMA 自校准做成 `translationEngines.ts` 内模块私有（leadero 的 `src/core/agent/TokenBudgetEstimator` 不在所有权内，未搬），故无导出 reset 钩子。
4. **`getString` 参数风格**：leadero 是 `{args:{...}}` 嵌套，z-transplit 的 `src/utils/locale.ts#getString` 收平铺 args，调用处已适配。
5. **openaiCompat 非流式**：空闲预算退化为总超时；保留 `raceAbort` / `executeWithIdleTimeout` 与 180000/120000/60000 三档超时常量。
6. **一级降级的重试合并进 `chatJson` 内置的"一次重试"**，不再套外层 2 次尝试循环（叠加会变 4 次；由移植测试的 fetch 次数断言钉住）。
7. **apiKey 为空时不发 `Authorization` 头**（leadero 的 custom 会发出字面量 `"Bearer undefined"`）。
8. **zotero-pdf-translate 桥的 pluginID** 由 `"leadero@zotero.org"` 改为 `"ztransplit@zotero.org"`（`translationEngines.ts:567`），并加 `typeof Zotero === "undefined"` 守卫。
9. **`LANGUAGE_NAMES` 收敛**到 `src/core/tool/language.ts` 的 `getLanguageName` 并由引擎 import（leadero 在 translationEngines.ts 内联复制了两份）。
10. **测试差异**：移除 ModelRouter/translateParagraphs 模块 mock；pref 锚点 `"ai"`→`"custom"`；单测自行安装 `globalThis.Zotero`（无共享 vitest setup）；node spec 的 prefs 改用 `vi.mock` 模块 mock；`translateParagraphs` 相关用例整体移除（归 PDF 阶段）。
11. **FTL**：随 `ai` 引擎移除 `translation-error-ai-*` 两个键；新增 `engine-zotero-pdf-translate` 与 `readiness-reason-engine-plugin`。

### 5.2 脚手架（scaffold 阶段）

1. 仓库内加 `.npmrc`（`legacy-peer-deps=true`）规避 npm 10.9.2 的 arborist `edgesOut` 崩溃（vitest@4 可选 peer 集触发）；未升级全局 npm。
2. `zotero-plugin.config.ts` 加 `build.fluent.prefixLocaleFiles=false`（FTL 源文件名已带 `ztransplit-` 前缀，避免双前缀）；消息 id 前缀保持默认 true。
3. `addon/prefs.js` 的键写成完整 `extensions.zotero.ztransplit.*`（Zotero 的 `setDefaultPrefs` 原样写入 default 分支）。
4. prefs.js 里的 pane 说明写成注释块而非可执行代码（该作用域只有 `pref()`）。
5. 新增 4 个清单外文件：`typings/global.d.ts`、`src/modules/registerTranslateUI.ts`、`tests/unit/utils.test.ts`、`.npmrc`。
6. `tsconfig.json` 用显式 `composite:false + noEmit:true`（不沿用 leadero 的 incremental/tsBuildInfoFile）。
7. `vitest.config.ts` 不设 `setupFiles`（不搬 leadero 的 `tests/node/vitest-setup.ts`）。
8. `formatRelativeTime` 超过 7 天改用 ISO 日期，不搬 leadero 的本地化长日期。
9. `package.json` 的 `repository.url` / `homepage` 用占位 `https://github.com/example/z-transplit`；`updateURL` / `xpiDownloadLink` 仍是 `{{owner}}/{{repo}}` 模板（发布前需填真值）。

### 5.3 PDF 流水线（pdf 阶段）

1. **MinerU 及全部远程后端按任务砍掉**：`backendSelector.ts` 只剩 OpenDataLoader 本地 jar 路径，无 fallback 级联、无 MinerU client/quota store/`pdfParser.mineru.*`；导出 `parsePdfWithOpenDataLoader`（保留 `parsePdfWithFallback` 别名），`fellBack` 恒 false；adapter 里 `backend==="mineru"`/`fellBack`/`skipFormulaVLM` 分支随之删除；`PdfIR` 的 `source` 联合类型收窄为 `"tier2-opendataloader-pdf"`。
2. **未移植的测试**：`odl-integration.spec.ts`（必须真实 Java + jar + 样例 PDF，`JAVA_EXE` 写死 `D:/IGV_2.17.3/jdk-17/bin/java.exe` 且 `describe.skipIf` 静默跳过）；`render-fidelity.spec.ts` 及 `tests/zotero/**`（需真实 Zotero 运行时或 17MB NotoSansSC.ttf、a.pdf/b.pdf 等不在夹具清单里的文件）；`translation-chain.spec.ts` 先前已落地。
3. **formulaExtractor 视觉通路改为本地 OpenAI 兼容客户端**（leadero 的 `AIProviderRegistry.getProviderForFeature("vision")` 不存在），凭据读 `translate.custom.*`——即"custom 端点即视觉端点"的折中，无新 pref。
4. **`translateParagraphs.ts` 的类型与 prompt 去重**：类型从 `src/core/translation/types.ts` 引入并再导出，`formulaPreservingPrompt` 从 `prompts.ts` 再导出。
5. **`OpenDataLoaderPdfClient` 的 `log` 通道映射为 logger 的 dev 门 `debug`**（本仓 logger 无 `log` 导出）。
6. **`opendataloader-pdf-parser.ts` 从 `src/core/tool/builtin/atomic/` 提到 `src/core/pdf/` 下**，消掉跨子系统反向依赖；其 `pdfParser.opendataloader.enabled` 门改为仅显式 `false` 才禁用。
7. **品牌/路径改名**：`{DataDir}/leadero/translation-assets`→`ztransplit/translation-assets`、`leadero/java-runtime`→`ztransplit/java-runtime`、`leadero-*` 临时前缀→`ztransplit-*`、`[Leadero]` 日志前缀→`[Z-Transplit]`、`setProducer/setCreator/docTitle`→`Z-Transplit`、addonID 兜底值→`ztransplit@zotero.org`。
8. **分屏 resizer 类名改为 `ztransplit-split-resizer`，但 leadero 的 `leadero-splitview.css` 未移植**（addon/** 红线），resizer 当前无样式（仍是可用 flex 元素）。
9. `split-sync.spec.ts` 保持从 `splitViewFactory` 导入 `viewStateToInternal/statesDiffer/doSyncCheck`，因此 factory 顶部对 `splitViewSync/splitViewCleanup` 的 re-export 段原样保留（测试零改动）。

### 5.4 UI（ui 阶段）

1. **样式不进 `addon/**`**：面板样式以 `<style>` 注入 section body、destroy 时移除；未新增 `addon/content/css/*.css`（leadero 走独立样式表）。
2. **未移植 `applyBrandColor` 品牌色步骤**，图标沿用 Zotero 原生 section 的 currentColor。
3. **新增 maxChars 硬性拦截**（`pane-translate-error-too-long`），leadero 面板没有这道闸。
4. **新增两个能力披露**：`pane-translate-no-reader`、`pane-translate-selection-unsupported`。
5. **复制失败的呈现强于 leadero**（进入 error 态并带失败原因；三级回退链本身与 leadero 一致）。
6. **重渲染策略不同于 React remount**：按 body 做 WeakMap 幂等，命中则 refresh。
7. **abort 语义与 leadero 一致地受限**（`createTranslator` 不接受 AbortSignal）。
8. **IME 判别去掉 nativeEvent 分支**，改为 `compositionstart/end` + `isComposing/keyCode===229` 双查。
9. `ztransplit-pane.ftl` 中原有占位英文值一并译成中文（键名与消息结构未动；这些键目前 `src/` 下尚无代码引用）。

### 5.5 设置界面（settings 阶段）

1. **pane 无法写进 `addon/prefs.js`**（作用域只有 `pref()`，已在 zotero 源码 `chrome/content/zotero/xpcom/plugins.js:507-536` 核实），拆成 `addon/content/preferences.{xhtml,js,css}`，注册改到 `addon/bootstrap.js`。
2. **manifest icons 改为主题无关变体**：Zotero 按尺寸选图标（无主题参数），按尺寸分放 light/dark 会在暗色主题显示亮色方块；改为 `"48"`/`"96"` 都指向新增的 `ztransplit-any.svg`（透明底 + 中色调，两类背景对比度均 ≥3:1），几何与品牌两变体一致。
3. **字体覆盖目录显示 `ztransplit/translation-assets`**（跟着代码真正读取的路径走，而非任务描述里的 `z-transplit/`）。
4. **「（未安装）」标签**改由 xhtml 隐藏节点 + Fluent 本地化，脚本只切 `hidden`（JS 里的字符串 id 不会被打前缀）。
5. **maxChars 输入框不挂 preference 属性**，脚本读→校验→写，避免空串打到 INT pref 上抛异常。
6. 「显示密钥」用 checkbox 而非按钮。

### 5.6 清点阶段已识别、本仓按此执行的改写

`translationEngines.ts` 头部的 LeaderoAPI/Leadero 字样改写；`translateParagraphs.ts` 的 LeaderoAPI 叙述改为 ParagraphTranslator 注入契约；`LayoutPreservingRenderer.ts:485-486` 的 `setProducer/setCreator("Leadero")` 改为 Z-Transplit；`prefs.ts` 的 `PREFS_PREFIX` 与 `logger.ts#debugPrefEnabled` 换成新 prefsPrefix；`locale.ts` 的 FTL 清单钉死为 `ztransplit{,-preferences,-pane}.ftl` 三个文件（`src/utils/locale.ts:12-16`）；`bootstrap.js` 的 uninstall 段大幅删减为只删 prefs 分支（无自建 DB 表）。

---

## 6. 验证状态

### 6.1 本会话（报告撰写时）实际执行的命令

| 命令 | 结果 |
| --- | --- |
| `find src -name "*.ts" \| wc -l` | `44` |
| `find src -name "*.ts" -exec cat {} + \| wc -l` | `12456` |
| `find tests/unit tests/node -name "*.test.ts" -o -name "*.spec.ts" \| wc -l` | `13` |
| `sha256sum src/core/pdf/lib/opendataloader-pdf-cli.jar` | `516ce47832a6726e87cb17db77c20174ca8cabbe9a6b56db1418babc7c9ddcba`，与 `PROVENANCE.json:6` 一致 |
| `stat -c %s src/core/pdf/lib/opendataloader-pdf-cli.jar` | `24102188`，与 `PROVENANCE.json:7` 一致 |
| `grep -c "^pref(" addon/prefs.js` | `18` |
| `grep -c "^pref(" .scaffold/build/addon/prefs.js` | `12` ← **不一致，见 6.4** |
| `diff <(grep "^pref(" addon/prefs.js) <(grep "^pref(" .scaffold/build/addon/prefs.js)` | 缺 6 个键：`translation.targetLanguage` + 5 个 `pdfParser.opendataloader.*` |
| `python -c "…zipfile…" .scaffold/build/z-transplit.xpi` | 24 条目；`core/pdf/lib/opendataloader-pdf-cli.jar` = 24,102,188 B 在包内；manifest 占位符已全部替换 |

按红线，本会话**未运行** `npm run test:unit` 与 `npm run build`。

### 6.2 工作流门控结果（由各阶段上报，本会话未复跑）

- `unitOk: true`（第 2 轮通过）、`buildOk: true`（第 1 轮通过）——见任务书 `gates` 段。

### 6.3 各移植阶段实跑过的检查（按其自报）

| 阶段 | 命令 | 上报结果 |
| --- | --- | --- |
| core | `npx vitest run` 指定 4 个文件 | 59 用例全过 |
| core | `npx tsc -p tsconfig.node.json --noEmit`、仅覆盖自己 src 的临时 tsconfig | exit 0 |
| pdf | `npx vitest run` 全量 11 文件 | 127 测试通过；其中移植的 7 个 spec 共 68 个测试通过 |
| pdf | esbuild transform（23 个移植文件） | 全部通过（纯语法层） |
| scaffold | `npm install`（从零，144 包，约 3 分钟） | 成功 |
| scaffold | `npx tsc --noEmit` | exit 0，无输出 |
| scaffold | `npm run test:unit` | 1 文件 10 测试全过 |
| scaffold | `npm run build` | 0.261s 产出 `z-transplit.xpi`；manifest 的 7 个 `__placeholder__` 全部被 define 替换；prefs.js 12 键前缀不变；三个 FTL 消息 id 加 `ztransplit-` 前缀；bundle 含 `_globalThis`/console/Buffer banner |

注意：pdf 阶段那次「全量 11 文件」发生时 ui/settings 的两个 DOM 测试（`tests/unit/ui/translatePane.dom.test.ts`、`tests/unit/ui/preferencesPane.dom.test.ts`）尚未落地，当前 `tests/` 下共 13 个测试文件；这两个 DOM 测试我未找到任何阶段上报过运行结果。

### 6.4 已发现的实物不一致

**`.scaffold/build` 是旧产物**：构建时间 11:53，而 `addon/prefs.js` 的修改时间是 11:55:57（`stat` 实测）。因此当前 xpi 内的 `prefs.js` 只有 12 个键，缺 `translation.targetLanguage` 与 5 个 `pdfParser.opendataloader.*`（diff 见 6.1）。**重新 build 后才会一致**；不重新构建就安装，PDF 解析相关 pref 不会进 default 分支。

### 6.5 未覆盖项（均未验证）

1. **真实 Zotero 运行时**：本机无 Zotero 可执行体（只有源码树 `D:/github_code/zotero` 与 profile 数据目录）。因此：section 注册与 DOM 渲染、设置 pane 是否真出现在设置窗口侧栏、Fluent `translateFragment` 是否命中、`_selectionRanges` 读取、剪贴板三级回退链、分屏 `Zotero_Tabs`/`Reader` 交互，全部没有实机验证。
2. **真实翻译 API**：所有引擎走 stub/mock fetch；google/bing/deepl/custom/zotero-pdf-translate 五条真实 HTTP 路径未打通过。zotero-pdf-translate 桥只用 stub 验证过成功路径。
3. **Java ODL 端到端**：`odl-integration.spec.ts` 未移植（其 `JAVA_EXE` 写死本机不存在的路径且 `describe.skipIf` 会静默跳过）；`java -jar` 子进程、JRE 下载/解压、nsIProcess 进程树 kill 均未跑过。jar 与 PROVENANCE 的 sha256 一致只证明"文件没坏"，不证明"能解析 PDF"。
4. **zotero-pdf-translate 桥**：pluginID 已改为 `ztransplit@zotero.org`，但真实插件的调用方归属行为未测（该插件本机未安装）。
5. **FTL 未经解析器验证**：无 FTL lint；键名与 `{ $status }` / `{ $googleError }` / `{ $bingError }` 等占位符语法只能等构建门控确认。
6. **tsc 全量类型检查在 pdf 阶段未跑**（`npm run build` 前半段被门控占）；pdf 阶段只做了 esbuild transform + vitest。ui/settings 阶段的 TS 也未找到上报的 tsc 记录。
7. **`odl-to-assembly.spec.ts` 的 overlay 用例**依赖未移植的 `tests/zotero/fixtures/a.pdf` 与 `NotoSansSC.ttf`，按文件内 early-return 静默跳过（vitest 计通过、实际零断言）。
8. **分屏菜单接线**（复核后修复）：`registerSplitViewMenu` / `registerOpenDataLoaderMenu` 原先无调用方，现由 `src/hooks.ts:59-61`（onStartup）注册、`:101-103`（onShutdown）反注册；`src/addon.ts:29,32` 的 `splitTranslate?: any` / `splitView?: any` 两个测试槽**仍为空**（无集成测试使用，运行期入口走菜单而非这两个槽）。
9. **注册是启动期一次性行为**：`translate.enabled` 与引擎就绪只在 `onStartup` 读一次，改设置后需重启 Zotero 才出现面板（Zotero 7 无「重新注册 section」事件）。
10. **`typings/i10n.d.ts` 是构建期生成**：新增的 pane 消息 id 要等一次构建才进去；不影响编译（`getString` 收 string）。

---

## 7. 构建与安装

### 7.1 从零构建

```bash
npm install        # 144 包；本机 npm 10.9.2 需要 .npmrc 的 legacy-peer-deps=true
npm run build      # = tsc --noEmit && zotero-plugin build
```

要求 Node.js ≥ 22.8（`zotero-plugin-scaffold@0.8` 的 engines 约束）。`.npmrc` 里的 `legacy-peer-deps=true` 是针对 npm 10.9.2 arborist `edgesOut` 崩溃的规避（vitest@4 可选 peer 集触发，在干净目录 + 干净 cache 下复现两次）；换 npm ≥ 11 后应删掉该文件恢复严格 peer 解析。

### 7.2 产物路径

| 路径 | 内容 |
| --- | --- |
| `.scaffold/build/z-transplit.xpi` | 22,541,994 字节，24 个条目（zip 实测） |
| `.scaffold/build/addon/manifest.json` | 666 字节；`__addonName__`/`__buildVersion__`/`__description__`/`__homepage__`/`__author__`/`__addonID__`/`__updateURL__` 全部已被 define 替换（实测读取） |
| `.scaffold/build/addon/content/scripts/ztransplit.js` | 216,679 字节（`src/index.ts` 的 esbuild 输出） |
| `.scaffold/build/addon/core/pdf/lib/opendataloader-pdf-cli.jar` | 24,102,188 字节（`zotero-plugin.config.ts:17` 的 jar glob 生效） |
| `.scaffold/build/addon/content/preferences.{xhtml,js,css}` | 20,542 / 11,674 / 4,154 字节 |
| `.scaffold/build/addon/locale/en-US/*.ftl` | 3 个文件，3,583 / 8,230 / 3,393 字节 |
| `.scaffold/build/update.json`、`update-beta.json` | 各 571 字节，含 `strict_min_version 7.0` / `strict_max_version 7.*` |

⚠️ 该 xpi 是 11:53 的产物，**prefs.js 缺 6 个键**（见 §6.4）。安装前请重新 `npm run build`。

### 7.3 装进 Zotero 7

1. `npm run build` 得到 `.scaffold/build/z-transplit.xpi`。
2. Zotero 7 → **工具 → 附加组件（Add-ons）** → 右上角齿轮 → **Install Add-on From File…** → 选择该 `.xpi` → 确认安装并重启 Zotero。
3. 安装后：**编辑 → 设置 → Z-Transplit** 打开设置面板（三分区：常规 / 翻译引擎 / PDF 分屏翻译）。
4. 开启「启用文本翻译」并配好引擎（默认 `google` 免 key 可用）后**重启 Zotero**，阅读器里才会出现「翻译」条目面板 section（启动期一次性注册，见 §6.5-9）。
5. PDF 分屏翻译：在阅读器空白处右键 →「翻译并分屏打开」；需要 Java 11+，缺失时会提示下载便携 JRE。该菜单由 `src/hooks.ts#onStartup` 注册（见 §3.2），安装插件并重启 Zotero 后即可用。

开发期热重载：`npm run dev`（`zotero-plugin serve`）。

### 7.4 发布前待办

- `package.json` 的 `repository.url` / `homepage` 是占位 `https://github.com/example/z-transplit`；`zotero-plugin.config.ts:10-14` 的 `updateURL` / `xpiDownloadLink` 仍是 `{{owner}}/{{repo}}` 模板——填真值后再出 release。
- 24MB jar 直接入库的分发策略（clone 体积）沿用 leadero 的未决问题，见 `src/core/pdf/lib/PROVENANCE.json` 的 `openQuestion` 字段。
- `PROVENANCE.json` 的 `howToUpdate` 引用 `node scripts/check-jar-provenance.cjs`，该脚本未随移植进入本仓（悬空引用）。（2026-09-24 更新：脚本已补上，`npm run check:jar`。）
