# z-transplit 全面测试报告

> 测试对象：从 leadero 移植而来的独立 Zotero 7 插件 z-transplit（当前 workspace）。
> 测试日期：2026-09-24。测试环境：Windows + Node 22 + vitest 4 + jsdom；**无 Zotero 运行时**。

## 总结论

插件通过本环境可执行的全部测试层：**类型检查 2/2 清零、单元测试 165/165、构建产物 22.5MB XPI、
结构校验 9/9 无警告、QA 资产自测 40/40**。测试过程中发现并修复了 **14 个真实缺陷**（6 个源码类型
错误、6 个移植遗漏、2 个测试基建缺陷），全部修复后复跑确认。真实 Zotero 运行时、真实翻译 API、
Java ODL 端到端、设置 pane 视觉渲染属于本环境无法覆盖项，已在第 6 节逐条列明，未冒充已验证。

## 1. 测试分层与方法

| 层 | 内容 | 判定方式 |
|---|---|---|
| L1 确定性门控 | tsc ×2、vitest、zotero-plugin build | 退出码 + 输出 |
| L2 结构完整性 | S1–S9 九项包结构校验（自研脚本） | 逐项 PASS/FAIL/WARN + 证据 |
| L3 行为测试 | B1–B17 行为矩阵（mock Zotero/fetch/DOM） | 逐用例断言 |
| L4 QA 资产自测 | harness 14 项 + 正控 26 组 | 自举验证（证明测试工具本身可信） |

「全面」的执行口径：L1–L3 全绿 + L4 证明测试工具可信 + 每条 FAIL 必附 `file:line` 或命令输出；
第 4 层不可覆盖项写入 notCovered 而非略过。

## 2. 门控结果（全部实跑）

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| G1 | `npx tsc --noEmit` | ✅ 0 错误 | 修复 5 个移植类型错误后清零（见第 5 节） |
| G2 | `npx tsc -p tsconfig.node.json --noEmit` | ✅ 0 错误 | 修复 6 个测试文件类型错误 + fixtures 排除（见第 5 节） |
| G3 | `npx vitest run` | ✅ **165/165 通过，15 个文件** | 127 个移植测试 + 38 个本次新增 |
| G4 | `npm run build` | ✅ 2.7s 完成 | `.scaffold/build/z-transplit.xpi`，22,542,579 字节 |
| G5 | `node scripts/structure-check.mjs` | ✅ **9/9，0 FAIL 0 WARN** | S1–S9 全 PASS（见第 3 节） |
| G6 | `node --experimental-strip-types tests/qa/harness-smoke.mjs` | ✅ 14/14 | Zotero mock 6 项 + fetch mock 8 项 |
| G7 | `node tests/qa/structure-check-selftest.mjs` | ✅ 26/26 | 1 个好插件 + 25 个各带缺陷的坏插件正控 |

## 3. 结构校验 S1–S9（对最终插件全 PASS）

| 项 | 校验内容 | 结果 |
|---|---|---|
| S1 | manifest 合法（Zotero 7 布局：id 在 applications.zotero 下；构建产物版本与 package.json 一致） | PASS |
| S2 | manifest 声明的亮/暗两个图标文件存在且非空（双形态路径解析） | PASS |
| S3 | addon/prefs.js `node --check` 语法合法 | PASS |
| S4 | 偏好键双向一致：代码/pane 绑定读取的 18 个键全部在 defaults 声明，无死键 | PASS |
| S5 | FTL 覆盖：代码引用的 50 个键全部有定义（共定义 119 个） | PASS |
| S6 | chrome://ztransplit/content/... URL 全部解析到真实文件 | PASS |
| S7 | 5 个 SVG：manifest 图标显式配色、chrome:// 引用的 UI 图标用 currentColor、品牌图不约束 | PASS |
| S8 | XPI 产物存在且体积正常（22,014 KB） | PASS |
| S9 | 无 leadero 可执行引用（import/require/chrome://）；80 处注释溯源为允许的署名 | PASS |

## 4. 行为矩阵 B1–B17 覆盖映射

| # | 行为 | 覆盖测试（文件: 用例数） | 结果 |
|---|---|---|---|
| B1 | 五引擎分发 | translationEngines.test.ts(29) + translation-chain.spec.ts(12) | ✅ |
| B2 | Google keyed v2 请求体 | translationEngines.test.ts「google with API key」 | ✅ |
| B3 | Google→Bing web 兜底链 + token 过期刷新 | 「google failure falls back」「bing web rejection refreshes」「unreachable Google AND Bing」 | ✅ |
| B4 | Bing Azure 头/体 | 「bing: subscription headers」 | ✅ |
| B5 | DeepL 语言映射/free-pro 端点 | 「deepl: zh-CN→ZH mapping」「pro host by default」 | ✅ |
| B6 | custom OpenAI 兼容（URL 补全/模型/温度/截断） | 「custom endpoint: URL normalized…」+ chain「带公式保护 prompt」 | ✅ |
| B7 | zotero-pdf-translate 桥（含插件缺失不崩） | 「delegates via the plugin API」+ chain「缺插件报配置错误」 | ✅ |
| B8 | LRU 缓存（命中/清空/超长不缓存/换 key 失效/语言对隔离） | 5 个专用用例 | ✅ |
| B9 | maxChars 预算 | **translatePane.dom.test.ts「超 maxChars 显式拒绝且带上限值」** | ✅ 新增 |
| B10 | 错误分类（quota/未配置/HTTP 透出） | chain + engines 用例 | ✅ |
| B11 | featureReadiness 矩阵 | featureReadiness.test.ts(8) | ✅ |
| B12 | 批量四级降级 + 空译回退 + 取消 | 「exposes token budgets」「empty→originals」「per-paragraph then originals」「aborted signal cancels」 | ✅ |
| B13 | openaiCompat 客户端 | chain「调用 chat/completions」「URL 不重复拼接」「HTTP 透出」 | ✅ |
| B14 | 公式占位符保护（$…$/{vn}） | pdf-translation-slice.spec.ts(3) + engines「maps zh-CN to a language name」 | ✅ |
| B15 | 分屏译文查重（复用不重译） | **splitViewCleanup.test.ts(7) 新增**：译文优先/无译文回退最新/英文标题识别/多译文取新/非 PDF 排除/excludeItemID/空值防御 | ✅ |
| B16 | 阅读器面板 DOM 行为 | **translatePane.dom.test.ts(14) 新增**：选区读取(auto 开/关)/Enter 与 IME/刷新选区/超限拒绝/网络失败+retry/空译披露/未就绪点名/destroy 清理/幂等挂载 | ✅ |
| B16b | 面板注册门控 | **registerTranslateUI.test.ts(7) 新增**：enabled+就绪才注册/任一不满足不注册/幂等/反注册/仅 reader 启用/宿主 API 缺失不崩 | ✅ |
| B17 | 设置 pane 条件显隐与校验 | **preferencesPane.dom.test.ts(10) 新增**：五引擎字段组显隐/menulist 回退 pref/PDFTranslate 探测两态/maxChars 越界与合法写回/字体目录回显 | ✅ |

新增测试全部用 QA 资产（zotero-mock / fetch-mock / jsdom）端到端驱动真实模块，
不是对私有实现的 mock 断言。

## 5. 测试过程中发现并修复的缺陷（14 个）

### 源码缺陷（10 个，修复后复跑全绿）
| # | 文件 | 问题 | 修复 |
|---|---|---|---|
| 1 | OpenDataLoaderPdfClient.ts:465 | `Zotero.File.exists` 在新版 zotero-types 无声明 | 局部 cast + 注释说明 |
| 2 | splitViewFactory.ts:378/693/787 | `Components.classes["@mozilla.org/prompt-service;1"]` 索引类型不收窄 | typings 补 `declare const Components: any`（leadero 同款约定） |
| 3 | addon/prefs.js | 6 个偏好键代码读取但未声明（pdfParser.opendataloader.×5、translation.targetLanguage） | 按 leadero 默认值补齐声明 |
| 4 | addon/locale/en-US/ztransplit.ftl | 9 个文案键被引用未定义（splitview-menu-×3、odl-error-×6） | 按 leadero 原文补 Fluent 条目（保留 `{ $detail }` 占位符） |
| 5 | PdfIR.ts / OpenDataLoaderJsonAdapter.ts:509 | PdfCitation 缺 `pageNumber`（leadero 有，移植时丢了）且类型未声明运行时实际设置的 doi/url | 类型补字段 + 运行时恢复 pageNumber |
| 6 | tests/node/*（6 处） | 移植测试从未经过 tsc（leadero 无 node tsconfig）：`spans` 未守卫、fixture 惰性字段（hasRawItems/columns/isScanned）、stubTranslator 少传 targetLanguage、statesDiffer 参数类型与 `?? 0` 运行时行为不符 | 逐项修复：显式存在性断言、清惰性字段、补参数、类型放宽为 `top?: number \| null` |
| 7 | tsconfig.node.json | 把 tests/qa/fixtures（自测用一次性假插件）纳入类型检查 | exclude |
| 8 | 测试依赖 | jsdom 无类型声明 | 补 @types/jsdom |

### 测试资产缺陷（4 个，在用于测插件前修复并经正控钉死）
| # | 缺陷 | 修复 |
|---|---|---|
| 9 | fetch-mock 的 `**` glob 退化为单段匹配、URL `?` 未转义 | 占位符两段式替换 + 转义集扩充（正控：`**` 跨段+查询串） |
| 10 | structure-check S1 按顶层 id 校验（Zotero 7 在 applications.zotero 下）；S2 解析不了相对图标路径；S1 拿 `__buildVersion__` 占位符直接比版本；S4 把调试日志里的模板插值当成键读取；S9 把注释溯源当耦合；S4/S5 从整行抓引号串；S4 前缀剥离少一段；S8 XPI 路径混用基目录；S7 靠文件名猜图标角色 | 逐项修复，每项配正控（共 26 组：干净插件全 PASS + 25 个各带一处缺陷的坏插件逐一断言预期 FAIL/WARN） |

## 6. 未覆盖项（本环境无法验证，如实披露）

| 项 | 原因 |
|---|---|
| 真实 Zotero 7 中加载 XPI 的运行时行为（pane 注册、菜单、分屏 Tab、设置窗口实际渲染） | 本机无 Zotero 运行时 |
| 五个翻译引擎的真实网络调用 | 无 API 密钥；全部经 fetch-mock 验证请求形状与响应解析 |
| OpenDataLoader Java jar 端到端（真实 PDF→译文 PDF） | 无 Java 运行时与真实 PDF；jar 已随包（sha256 与 PROVENANCE 一致），代码路径与单测覆盖 |
| zotero-pdf-translate 外部插件桥 | 未安装该插件（缺失路径已测） |
| 设置 pane 在真实 XUL 窗口的视觉观感（暗亮主题） | 无 XUL 运行时；已用 jsdom+XML 模式验证标记/行为，CSS 走 Zotero 变量（设计上自动适配） |
| Logo 的最终渲染效果 | SVG 源码已交付并发布，未做渲染截图验收 |
| XPI 装机安装/升级 | 需用户本机操作 |

## 7. 复跑方式

```bash
npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit   # 类型
npx vitest run                                                # 165 个测试
npm run build                                                 # 构建 XPI
npm run check:structure                                       # S1–S9
npm run test:qa                                               # QA 资产自测（harness 14 + 正控 26）
```

## 8. 测试资产（tests/qa/，可复用）

- `harness/zotero-mock.ts`：可编程 Zotero 全局（Prefs/locale/platform 三态/PDFTranslate 开关/ItemPaneManager spy/Reader 选区/ProgressWindow 记录）
- `harness/fetch-mock.ts`：可编程 fetch（glob 路由、顺序回复、recorded calls、jsonBody/formBody、throws、once、动态回复体）
- `structure-check-selftest.mjs`：结构校验的正控测试（无正控的校验器不能证明自己能抓问题）
- `harness-smoke.mjs`：上述 mock 的自测

## 9. 独立复核（换人复审）与修复

移植工作流内置的「独立复核员」（未参与搭建的全新上下文，逐项核对四项用户需求）提出
**15 项发现**；其中 5 项高/中危被判定为阻断性并已全部修复，修复后本报告第 2 节全部门控
复跑复绿。

### 已修复（5 项，verified）

| 严重度 | 发现 | 证据 | 修复 |
|---|---|---|---|
| high | **分屏翻译运行期不可达**：`registerSplitViewMenu()/registerOpenDataLoaderMenu()` 已实现但无调用方，分屏流水线被 tree-shake 出 XPI，用户无入口 | 复核员 grep bundle 中 `openSplitView\|splitViewSync\|translateAndSplit` = **0 处**；unzip XPI 仅 24 文件无分屏代码 | `src/hooks.ts:60-61` onStartup 注册两个菜单、:102-103 onShutdown 反注册。**复验：重建后 bundle 命中 18 处，XPI 23.2MB 含分屏代码** |
| medium | manifest 图标按尺寸而非主题选取（"48"→light、"96"→dark，Zotero 纯尺寸匹配，暗色主题显示亮色图标） | Zotero 源码 `getIconURI→getPreferredIconURL(addon, idealSize, window)` 无主题参数 | 两个尺寸键均指向新增的主题无关变体 `ztransplit-any.svg`（单色系，亮暗底均可辨） |
| medium | 设置文案承诺不存在的能力（「可在阅读器的翻译面板中选择译文语言」「Java 检测结果显示在阅读器的翻译面板中」） | FTL 原文与代码行为不符；`translation.targetLanguage` 无写入方，回落恒为 zh-CN | 文案改写为真实路径（分屏菜单触发 + 装 JRE 引导；译文语言改为真实控件），代码兑现语义：回落链 pref→`Zotero.locale`→zh-CN |
| medium | 设置 pane 未覆盖全部已登记偏好：18 键中 6 个（translation.targetLanguage + 5 个 pdfParser.opendataloader.*）无 UI 入口 | 复核员键比对：xhtml 仅绑定 12 个 translate.* | pane 补齐 6 个控件（含 timeout 数值校验：非法值只报错不写 pref、越界夹紧、空值回退合法值），绑定达 16 个 |
| medium | 用户可见错误泄漏裸 FTL 键（`assertEngineReady` 把 reasonKey 原样插值） | `opendataloaderSplitAdapter.ts:206` `${m.prefKey}（${m.reasonKey}）`；FTL 已有对应文案；translatePane.ts:677 是正确写法 | 改用 `getString(m.reasonKey)` 本地化 |

### 未修复的低危发现（10 项，均 verified，留待裁决）

1. `src/addon.ts` splitTranslate/splitView 死槽位（注释误导）
2. `formatRelativeTime` 死导出 + 4 个 time-* 死键
3. 20 个无引用 FTL 死键（含暗示不存在入口的 itemtree-*）
4. `opendataloader-pdf-parser.ts:14-19` 过时注释（称 pdfParser.* 未登记）
5. 分屏 resizer 无对应 CSS（随 high 项修复后已可达，需要补样式）
6. 构建产物 update_url/homepage 为 example.com 占位（发布前须填真实仓库）
7. en-US 目录装中文文案且只发布一个 locale（非中文用户看到中文面板）
8. `translation.targetLanguage` 前缀与其余 translate.* 不一致（openQuestions 裁决「原样登记」的固化）
9-10. 两项 unconfirmed：设置 pane 真实 Zotero 渲染未实测；五引擎真实网络行为未实测（同第 6 节）

## 10. 低危发现的后续处置（2026-09-24 同日晚）

| # | 发现 | 处置 |
|---|---|---|
| 1 | addon.ts splitTranslate/splitView 死槽位 | **已删除**（全仓无读写方） |
| 2 | formatRelativeTime 死导出 + time-* 死键 | **已删除**（函数 + 4 个 FTL 键） |
| 3 | 无引用 FTL 死键 | **已删除 19 个**（ztransplit.ftl 9 个：ztransplit-title、engine-×5、translate-enabled/auto/max-chars；pane.ftl 10 个：pane-open-split-view、pane-close、pane-split-×2、pane-status-×3、pane-none、itemtree-×2） |
| 4 | opendataloader-pdf-parser.ts 过时注释 | **已改写**（prefs.js 现已声明全部 pdfParser.* 键，理由更新为升级兼容） |
| 5 | 分屏 resizer 无样式 | **已补**：splitViewFactory 注入 `<style>`（基础宽度/光标 + hover/dragging 反馈，走 Zotero 变量带回退色；样式随文档生命周期保留，插件停用时已打开的分屏仍正常） |
| 6 | update_url/homepage 占位 | **未改**：真实仓库地址属用户输入，发布前必填（package.json + zotero-plugin.config.ts） |
| 7 | en-US 装中文且单 locale | **已修复**：en-US 三份 FTL 全量英文化；新增 addon/locale/zh-CN/ 三份中文 FTL（键集与 en-US 逐键一致）。Zotero.Plugins#registerLocales 自动扫描 locale/ 全部子目录并做 closest-locale 回退（exact → 同语言 → en-US），无需改 bootstrap |
| 8 | translation.targetLanguage 前缀不一致 | **已改名** `translate.targetLanguage`（prefs.js、preferences.xhtml 绑定、opendataloaderSplitAdapter、typings、translation-chain.spec 同步） |
| 9-10 | 实机验证 | 保持披露（仍需真实 Zotero / 真实 API） |

处置后全部门控复跑复绿：`tsc` ×2 清零、vitest **165/165**、`npm run build` 3.8s、
structure-check **9/9**（S5 定义 112 / 引用 46）、test:qa **40/40**；新增
`npm run check:jar`（scripts/check-jar-provenance.cjs，兑现 PROVENANCE.json#howToUpdate
的悬空引用）实跑 OK。XPI 复核：zh-CN FTL 已入包且消息 id 前缀正确、prefs.js 为新键名、
bundle 含 resizer 样式且无旧键名。

## 11. 真机验证（2026-09-24 晚，Zotero 7.0.15 win-x64 便携版 + 隔离 profile/数据目录）

在本机真实 Zotero 运行时中装入 XPI 并交互测试（隔离 profile + 空数据目录，通过
proxy sideload 与 zotero-plugin serve 的临时插件（RDP）两条真实安装路径各验证一次；
测试条目经 `/connector/saveItems` 注入）。诊断手段：`-ZoteroDebugText` + stdout 重定向
捕获 Zotero.debug，并在构建产物内注入临时诊断代码（验证后已重建清除）。

### 发现并修复的真实缺陷（修复后已在真机复验）

| # | 缺陷 | 根因（真机日志证据） | 修复 | 真机复验 |
|---|---|---|---|---|
| R1 | **Fluent 本地化在真实运行时全灭**：面板所有文案显示裸键名（165 个 mock 测试无法发现——mock 了 getString 依赖的注入路径） | `getAddonData()` 读 `globalThis._globalThis`；真机 bundle 里 esbuild banner 使 `_globalThis === globalThis`，该属性不存在 → `initLocale()` 创建的 Localization 被静默丢弃（`if (data)`），`getString` 永远回落裸 id | `getAddonData()` 增加回退路径 `?? globalThis?.addon?.data` | 面板完整显示「源文本/刷新选区/自动检测/zh-CN/警告文案」，布局正常 |
| R2 | **「未检测到当前阅读器」误报**：在活动阅读器标签页中面板永远找不到 reader | ItemPaneManager 回调给的 `item.id` 是**父条目**（1），`reader.itemID` 是**附件**（2），严格相等比较拒绝 → 返回 null | 匹配附件或其父条目任一身份（`Zotero.Items.get(reader.itemID)?.parentItemID`） | 面板能读到 reader 与选区：显示「没有选中文本」占位 → 选中 PDF 文本后源文本区正确回显选中文本，出现「翻译」按钮 |
| R3 | **Bing web 兜底对 auto 检测必失败**（网络层发现，见下） | Bing ttranslatev3 现拒绝 `fromLang=auto`（`{"statusCode":400}`），要求 `auto-detect` | `toBingWebLang()` auto 分支改为 `auto-detect` 并钉进测试 | 真实网络复验：`from=auto-detect` 返回正确译文；`from=auto` 400 |

R1/R2 各补了回归测试（`translatePane.dom.test.ts` 15 例，zotero-mock 的 Reader stub
增加 `itemID`）。

### 真机确认通过的项

- 插件安装/启动：bootstrap startup 无错误日志；section 与设置 pane 均注册成功（stdout 日志为证）
- 阅读器翻译面板：注册、门控（仅 reader 标签页）、DOM 渲染、样式、本地化（修复后）、选区捕获
- 翻译引擎网络层（真实网络）：Bing web 兜底链两跳均实测（token 抓取 → ttranslatev3，含 R3 修复验证）；Google 免 key 端点在本机网络不可达（环境限制，兜底链正是为此设计）
- Java + ODL jar 端到端：真实 PDF → 插件同款 CLI 参数（`--format json --reading-order xycut --table-method default --image-output off/embedded`）→ exit 0 → JSON 含标题/正文/章节，两种图像模式均验证

### 真机仍未覆盖（自动化工具链限制）

- 「翻译」按钮点击后的完整 in-Gecko 翻译往返（自动化框架无法触发该 DOM 按钮；引擎链路已由网络层验证覆盖）
- 设置 pane 与分屏右键菜单的视觉呈现（Gecko 原生菜单/弹窗在自动化框架中不可见）
- Zotero 10 兼容性（测试机 Zotero 7.0.15 便携版在验证期间被自动更新为 10.0.3 后插件按 manifest 声明拒绝加载——strict_max 7.* 生效，行为符合声明；干净的 7.0.15 全部验证在禁用自动更新后完成）

处置后全量门控：vitest **166/166**（含 2 个真机回归测试）、tsc ×2 清零、build OK、
structure-check 9/9、test:qa 40/40、check:jar OK。
