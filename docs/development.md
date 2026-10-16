# 开发文档

面向贡献者的架构说明与构建、质量门控、测试、发布流程。用户向说明见
[README](../README.md) / [README.zh-CN](../README.zh-CN.md)。

## 架构

```
src/
├── index.ts / addon.ts / hooks.ts     插件入口（bootstrap 生命周期）
├── modules/                           UI 注册：条目面板 section、文献列表右键菜单
├── ui/                                原生 DOM 面板：划词翻译面板、双语对照控制条
├── core/
│   ├── translation/                  翻译引擎适配、AI 提示词模板、内容寻址缓存
│   ├── pdf/                           保排版全文翻译流水线
│   │   ├── OpenDataLoaderPdfClient.ts  本地 JVM（jar）进程封装
│   │   ├── JavaRuntimeManager.ts      托管 JRE：缺失时自动下载便携版（SHA-256 校验复用、暂存目录原子安装、损坏自愈）
│   │   ├── translation/                版式解析 → 逐段翻译 → 重排渲染 → 译文入库
│   │   └── splitview/                  分屏 Tab：浏览器装载、同步、清理
│   ├── pdf/sdt/                       Zotero 10 阅读模式（SDT）双语插入视图
│   └── readAloud/                     句级朗读（PDF 文本层 / 双语块定位）
├── utils/                             prefs / locale / logger / abort 等公共件
└── typings/                           bundle 注入的全局声明（global.d.ts）

addon/
├── manifest.json / bootstrap.js / prefs.js
├── content/                           设置面板（xhtml + js + css）、图标
├── core/pdf/lib/                      运行期 jar（PDF 解析后端）
└── locale/                            en-US / zh-CN 三份 Fluent 文案
```

生命周期要点：

- `hooks.onStartup` 依次注册条目面板 section、阅读器右键菜单、文献列表右键菜单，
  失败只降级不阻断；`_globalThis.addon.data.initialized` 做进程内幂等。
- Fluent 本地化由 `initLocale()` 在进程内创建 `Localization` 实例，`getString()`
  走 `formatMessagesSync`；消息 id 在源码里不带 `ztransplit-` 前缀，构建时由
  scaffold 加（见 `zotero-plugin.config.ts` 的 `build.fluent`）。
- 设置面板在 `bootstrap.js#startup` 里注册（唯一带完整 Zotero/Services 作用域的文件），
  这样即使 bundle 起不来，面板仍然可达。
- 偏好默认值统一声明在 `addon/prefs.js`，代码通过 `src/utils/prefs.ts` 的
  `getPref` / `getPrefDynamic` 读取；注意 `Zotero.Prefs.get(key, global)` 的第二参是
  「key 是否已是全路径」，传 true 才是读用户值。

## 构建

```bash
npm install
npm run dev          # zotero-plugin serve：启动 Zotero + 热重载
npm run build        # tsc --noEmit + zotero-plugin build → .scaffold/build/z-transplit.xpi
```

要求 Node.js ≥ 22.8（`zotero-plugin-scaffold@0.8` 的 engines 约束）。
jar 更新后必须跑 `npm run check:jar`（与 `PROVENANCE.json` 的 sha256 对账）。

## 发布

变更日志与发布说明的约定：

- CHANGELOG.md 与 GitHub Release 说明一律使用纯英文。发布说明面向全部用户，
  界面文案已由 Fluent 语言包按 Zotero 语言切换，发布说明不再做本地化。
- 引用代码里的原始字面量（例如正则匹配的中文错误文本）可保留原文，其余
  行文必须是英文。
- 发布前在 CHANGELOG.md 顶部按 `[x.y.z] - YYYY-MM-DD` 格式新增英文段落，
  再同步 package.json 的 `version` 并打 `vX.Y.Z` 标签。
- `zotero-plugin.config.ts` 已把 `release.changelog` 配置为
  `node scripts/release-notes.mjs`：走 `npx zotero-plugin release`（需要
  GITHUB_TOKEN）时，GitHub Release 说明自动取自 CHANGELOG.md 当前版本段落，
  不会用中文提交信息生成。手工发布时同样以 CHANGELOG.md 对应段落为正文。

### 原文删除器 jar（ztransplit-region-text-remover）

`src/core/pdf/lib/ztransplit-region-text-remover.jar` 由本仓库自有 Java 源构建
（源码在 `java/region-text-remover/src/`，依赖 pdfbox/fontbox/commons-logging
在 `java/region-text-remover/lib/`），用于「翻译并分屏」时把已翻译段落的
原文从页面内容流中真正删除（替代白色遮罩；表单内部文字保留由遮罩兜底）。
修改 Java 源后重新构建并更新溯源清单：

```bash
node scripts/build-region-text-remover.cjs   # 编译 → fat jar → 更新 PROVENANCE
npm run check:jar                            # 对账（同时校验 ODL jar 与本 jar）
```

要求 PATH 上有 JDK 17+。管线侧接入与回退语义见
`src/core/pdf/OriginalTextRemovalClient.ts` 头注释；
可行性验证数据见 `prototype/region-text-remover/README.md`。

## 质量门控

| 命令 | 覆盖 |
| --- | --- |
| `npx tsc --noEmit` | 主包（Zotero sandbox）类型 |
| `npx tsc -p tsconfig.node.json --noEmit` | Node 侧（测试、配置文件、脚本）类型 |
| `npx vitest run` | `tests/unit` + `tests/node`，纯 Node / jsdom |
| `npm run build` | 类型检查 + 打包出 XPI |
| `npm run check:structure` | S1–S9 包结构：manifest、图标、prefs 语法、偏好键双向一致、FTL 覆盖、chrome:// URL、SVG 角色、XPI 产物、无 leadero 可执行引用 |
| `npm run test:qa` | QA 资产自测：Zotero/fetch mock 自举 + structure-check 正控（无正控的校验器不能证明自己能抓问题） |
| `npm run check:jar` | 随包 jar 与 `PROVENANCE.json` 的 sha256 / 字节数对账 |

## 测试分层

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/unit/` | 引擎分发、缓存、面板 DOM 行为、设置 pane 显隐与校验、朗读控制、JRE 托管安装中断安全（假宿主驱动真实 `JavaRuntimeManager`）、外部进程 runner 双分支（假 Subprocess/nsIProcess 驱动真实 `runProcess`）、Unicode 探针 fail-closed 判定逻辑（假进程库存/命令执行器驱动 `windows-unicode-probe-gates.mjs`） |
| Node 集成 | `tests/node/` | ODL JSON 适配、版式渲染往返、分屏同步、真实 fixture |
| 真机 | `scripts/qa/real-machine.mjs` | 在真实 Zotero（隔离 profile + 数据目录）里装载构建产物，驱动真实 DOM / 菜单 / 网络 / Java 流水线 |
| 真机（进程 runner） | `scripts/qa/windows-unicode-probe.mjs` | 隔离诊断插件把生产 `runProcess`/`execJar`/`parsePdfToJson` 打包进真实 Zotero（GUI/headless），验证 Windows Unicode 参数、双流捕获、超时/取消进程树终止与失败诊断 |

### Windows Unicode 进程 runner 回归

`scripts/qa/windows-unicode-probe.mjs` 是可复用启动器：它把
`scripts/qa/windows-unicode-probe-entry.ts`（import 生产 `runProcess` 等导出，
不复制 runner）用 esbuild 打成探针 bundle，装进隔离 profile/data 的诊断插件，
在真实 Zotero 中自动执行场景并写 `<out>/runs/<mode>-<ts>/results.json`。
fixture 源码与编译产物、PDF 副本、profile、日志一律落在输出根
（默认 `D:\Develop\Misc Workspace\archive\z-transplit-issue-1-regression\`）。

清理与汇总的判定逻辑集中在 `scripts/qa/windows-unicode-probe-gates.mjs`
（无副作用、可注入假进程库存/时钟），失败一律 fail-closed：清理前必须按
当前 executable + 命令行中 `-profile` 参数的完整值（非子串）核对进程身份，
规范化后精确比较（观测失败不杀、历史 root PID 单独不足以开杀）；结果集必须
完整覆盖权威场景列表、匹配本 run/mode，且 deadline、probe-fatal、启动失败、
观测失败都会使顶层非零退出。PID 查询仅「成功且结构合法的空结果」可判消失，
单次查询带终止边界（超时杀掉并回收自有查询进程）。`MOZ_HEADLESS` 按模式显式
设置/清除，过滤后的启动参数与相关环境键记录在 run-manifest。判定逻辑的永久
自测在 `tests/unit/qa/windows-unicode-probe-gates.test.ts`，只用假进程库存，
不触碰真实进程。

```bash
node scripts/qa/windows-unicode-probe.mjs --mode gui        # 有界面 GUI（验收项）
node scripts/qa/windows-unicode-probe.mjs --mode headless   # headless 补充回归
node scripts/qa/windows-unicode-probe.mjs --mode both       # 顺序执行两种模式
# 可选：--zotero / --java / --jar / --remover-jar / --out / --javac
```

### 真机测试（实机）

`scripts/qa/real-machine.mjs` 用一个独立 bootstrap 插件（`scripts/qa/driver2/probe.js`,
注入到构建产物的副本里，不改发布物）在真实 Zotero 中执行探测，通过
`D:\zt-qa\command.json` / `result.json` 交换命令与结果：

```bash
node scripts/qa/real-machine.mjs boot                    # 启动真实 Zotero 并等待探针就绪
node scripts/qa/real-machine.mjs send <action> [arg]     # 调用一个探针 handler
node scripts/qa/real-machine.mjs log                     # 查看 Zotero 调试输出
node scripts/qa/real-machine.mjs shoot                   # 结束
```

可用 action：`ping`、`snapshot`、`introspect`、`reader`、`selectText`、`paneFlow`、
`bilingual`、`readAloud`、`menus`、`itemtree`、`tools`（工具菜单「生词本」入口检查）、
`prefs`、`pipelineViaMenu`、`splitPanes`、
`attachments`、`verifyPdf`、`installPdf`、`setPref`、`capabilities`、`locales`、
`allPanes`、`sectionState`、`listCommands`、`odlStatus`（解析组件状态检查，直调
`Zotero.ZTransplit.odlJar.getStatus`）、`odlInstall`（解析组件下载/修复入口）、
`odlHashProbe`（宿主 WebCrypto 大文件哈希探测）、`odlZipApi`（nsIZipReader
真实接口面与 findEntries/extract 行为探查）。

排版/引擎相关的真机发现都建议带上 `docs/screenshots/` 截图归档。

### README 截图再生成

`scripts/qa/screenshots.mjs` 在真机装置上自动摆好六个界面状态并截图：英文版
（README.md 引用）落在 `docs/screenshots/`，中文版（README.zh-CN.md 引用）落在
`docs/screenshots/zh-CN/`。夹具论文在 `scripts/qa/fixtures/reading-brain.*`，
两页版式与正文在两次重拍之间保持稳定。截图里的翻译走真实引擎，因此需要一份
引擎配置 JSON（AI 引擎的接口地址 / 密钥 / 模型，外加窗格宽度的
`extensions.zotero.pane.persist`），路径用 `--prefs` 传入；该文件在版本库外，
密钥不入库。

```bash
node scripts/qa/screenshots.mjs --locale en-US --out docs/screenshots \
     --prefs D:\zt-qa\qa-shot-prefs.json
node scripts/qa/screenshots.mjs --locale zh-CN --out docs/screenshots/zh-CN \
     --prefs D:\zt-qa\qa-shot-prefs.json
```

## 移植来源

代码自 leadero 的 PDF 翻译能力移植而来，保留了可读性注释里的溯源署名
（`// Ported from leadero/…`）。`npm run check:structure` 的 S9 只拦截
**可执行**耦合（import / require / chrome://），注释不计。

## License

Copyright (C) 2026 z-transplit contributors

AGPL-3.0 —— 见 [LICENSE](../LICENSE)。与 Zotero 本体相同的协议。
