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
│   │   ├── ai/providerPresets.ts   AI 服务商预设表（面板镜像同内容）
│   │   ├── ai/connectionTest.ts    AI「测试连接」：最小请求 + 结果分类
│   │   ├── JavaRuntimeManager.ts      托管 JRE：缺失时自动下载便携版（官方 API 取校验和 + 国内镜像取件 + 官方兜底、SHA-256 校验复用、暂存目录原子安装、损坏自愈）
│   │   ├── javaLocator.ts             跨平台定位 java（JAVA_HOME → 各平台真实安装位置枚举 → PATH）
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
- 功能与修复提交在 CHANGELOG.md 顶部维护 `## [Unreleased]` 节（英文，
  Keep a Changelog 的 Added / Changed / Fixed / Removed 分节）；发布时把这个
  标题改成 `[x.y.z] - YYYY-MM-DD`，再同步 package.json 的 `version` 并打
  `vX.Y.Z` 标签。只记用户可见的改动，内部开发工具（真机测试台、脚本）不进
  发布说明。
- `zotero-plugin.config.ts` 已把 `release.changelog` 配置为
  `node scripts/release-notes.mjs`：走 `npx zotero-plugin release`（需要
  GITHUB_TOKEN）时，GitHub Release 说明自动取自 CHANGELOG.md 当前版本段落，
  不会用中文提交信息生成。手工发布时同样以 CHANGELOG.md 对应段落为正文。
  该脚本按 package.json 的版本号取段，`## [Unreleased]` 在版本号改动前不会被
  取走。
- 推送 `v*` 标签后由 CI（`.github/workflows/ci.yml` 的 release 任务）自动
  完成发布：门禁通过 → 构建精简版与完整版 XPI → `scripts/make-update-
  manifests.mjs` 生成自动更新清单 → 创建 GitHub Release 并上传 → 把清单
  同步到 `release` 标签预发布。手工发布必须手工补做最后一步——Zotero 的
  updateURL 指向 `release` 标签上的清单，忘了同步就是 1.9.0–1.12.2 自动
  更新失效五个版本的原因。日常推送与 PR 由同一工作流的 test 任务跑全量
  门禁，不需要本地先跑一遍再推。

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

### 扫描页识别侧车（addon/scan-sidecar/sidecar.py）

扫描件与乱码文本层页的识别在插件外的一个 Python 侧车里跑（版面 + 行级文字 +
公式 + 表格，全部 CPU 可跑的小模型），插件只认 JSON 契约
（`src/core/pdf/scan/sidecarProtocol.ts`），换引擎不用改插件。侧车脚本随插件
分发（XPI 里带 `addon/scan-sidecar/`），用户不需要自己找脚本；一键安装见下
一节。本地联调（高级用户自己搭环境时）：

```bash
pip install -r addon/scan-sidecar/requirements.txt
python addon/scan-sidecar/sidecar.py --pdf 样本.pdf --pages 1-5 --out workdir --dpi 200
# workdir/result.json 即插件读取的批次结果；stderr 每行一个 JSON 诊断
```

`--selftest` 只构建识别引擎并退出（首次运行会下载模型权重），不认页面。一键
安装用它把"翻译到一半才卡在模型下载"提前到安装阶段暴露。诊断与结果分流：
stderr 每行一个 JSON 诊断，stdout 只放结果与自检的 JSON 行。

然后在设置 → PDF 分屏翻译 →「识别侧车命令」填完整命令行（带空格的路径加引号），
对一篇纯扫描 PDF 执行「翻译全文」即可走通全链路。侧车的纯函数（页码解析、框
归一、覆盖率并集）已用 Python 直接冒烟验证；模型调用部分需在装好依赖的机器上
按上面的命令验证。管线语义：路由决策
（`scan/routePages.ts`，纯函数）、逐页分类（`scan/pageClassification.ts`）、
分批与断点账目（`scan/scanBatchPlan.ts`、`scan/ScanPipeline.ts`）、产出合并
（`scan/mergeScannedAssemblies.ts`）均有纯函数单测覆盖。表格结构还原在插件侧
完成：侧车给出的表格 HTML 由 `scan/htmlTable.ts`（纯函数，不依赖 DOM 的引号
感知扫描器）解析成行/单元格，含 colspan/rowspan 与网格列起点，单元格框按
表格区域均分近似（HTML 不带坐标）；解析失败整表退回只登记区域。文档级聚合
在 `scan/scanDocumentAggregate.ts`：识别页的正文进 `filteredText`、标题与
表格进 `filteredMarkdown`（表格渲染与数字路径共享 `core/pdf/tableMarkdown.ts`），
表格/公式/图区进 `allXxx`；数字页的聚合按页界原样保留、只替换被识别页的
位置，因此混合文档不丢标题层级。页界记账由 `OpenDataLoaderJsonAdapter` 产出
（纯文本与 Markdown 各一套，收集点不同必须分别记）。

### 识别断点与自动续跑（scanRunState）

每批识别成功的页会逐页落盘到 Zotero 数据目录的
`ztransplit/scan-state/<附件 id>/page-XXXX.json`，清单 `run-manifest.json`
记录源文件指纹（修改时间 + 字节数）与已完成页码。重跑同一文件的识别时，
指纹对得上的页直接沿用（不再送侧车、不参与重试），进度行报"沿用 N 页"；
指纹对不上（源文件换版）先清空旧状态——旧坐标配新页面比不识别更糟。
清单在而页文件丢失的页按未完成处理，不冒充已认。整篇运行成功产出后清理状态；
页码范围运行保留，供下一个范围接着用。状态读写集中在
`src/core/pdf/scan/scanRunState.ts`（纯函数序列化/校验 + 宿主 IOUtils），
适配器在 `opendataloaderSplitAdapter.ts` 接线。

### 识别运行时的 Python 自动分发（pythonRuntime）

侧车跑在插件外的 Python 里，运行时本身由插件按平台分发，落地在数据目录
`ztransplit/python-runtime/`（内部即上游发行版的 `python/` 布局，可执行文件
路径以清单为准）。链路与 jar、JRE 同一形状：

1. 随包清单 `src/core/pdf/lib/PYTHON-RUNTIME.json` 声明"哪个平台取哪个构件、
   校验和清单在哪"（`src/core/pdf/scan/pythonRuntimeManifest.ts` 解析，六平台
   必须齐，缺一个该平台用户装不上）；
2. 安装时现取上游随发行版发布的 SHA256SUMS（信任锚），取出本平台构件的
   指纹——清单不存单构件指纹：一个发行版六个平台，逐个人工登记只会让人懒得
   更新，而"漏登记一个平台"比"不登记"更危险；
3. 字节必须过 SHA-256 才解包；镜像只送字节，对不上就换源（来源表由清单的
   `mirrors` + 规范源组成，探测竞速后整包下载，见
   `src/core/pdf/artifactAcquire.ts`——jar 与运行时共用的取件器，按目标 key
   去重）；
4. 解到暂存区、跑一次 `python -V` 探活、通过才原子换位：解压中断或架构不符
   都不占据正式位置；探活失败的状态行显示"未安装"而不是拿跑不起来的运行时
   当可用。

对账：`npm run check:python-runtime`（结构：平台齐全、文件名含发行标签、
可执行路径符合 install_only 布局、镜像唯一且 https、更新说明随数据带）；
`--online` 追加联网核对（每个构件名都在上游 SHA256SUMS 里、镜像可达）——在线
模式依赖外网，默认不进 CI。升级发行版的步骤写在清单的 `howToUpdate` 里。

已实测（2026-11-18）：发行版 `20261110`，CPython 3.12.16 的
install_only_stripped 构件六个平台齐备；`mirrors.cernet.edu.cn` 收录该发行版
且 SHA256SUMS 与 GitHub 逐字节一致（清华/阿里/腾讯/中科大/南大均未收录）；
win-x64 与 mac-arm64 两个构件已完整下载并核对指纹（355ee61b…、2f11b8aa…）。

入口：设置 → PDF 分屏翻译 →「识别运行时」的「检查状态 / 安装 / 修复…」
（`Zotero.ZTransplit.python`，进度窗显示在主窗口）。本模块只分发解释器；侧车
脚本落地与模型依赖由下一节的一键安装接着办完。

### 识别环境一键安装（sidecarEnv）

用户此前的路径是「自己装 Python → 自己 pip install → 自己抄一条命令进设置」，
三步任何一步卡住，扫描识别就用不上。`src/core/pdf/scan/sidecarEnv.ts` 把三步
合成一次点击，五步顺序即依赖关系：

1. 把随包的 `scan-sidecar/sidecar.py` 与 `requirements.txt` 落到数据目录
   `ztransplit/scan-sidecar/`——打包安装时脚本在 XPI 里，不能直接当命令执行。
   这一步每次都做（几 KB、不联网）：插件升级带来新版侧车时，已就绪的短路
   不能沿用盘上的旧脚本；
2. 受管 Python 运行时（复用上一节，按平台取件、指纹核对、探活）；
3. `pip install -r requirements.txt`：并发探测 PyPI 简单索引取最快的一个，用
   pip 的 `--index-url` 传入（进程运行器不传环境变量，也不需要）。索引地址表
   与 jar 取件共用（`OdlJarDownloader.pypiIndexUrls`）——官方源的文件主机
   （files.pythonhosted.org）与索引主机（pypi.org）不是同一个域名，拿文件
   主机当索引会永远探测失败，只连通官方源的网络就装不上；
4. `sidecar.py --selftest`：构建识别引擎并预热模型权重——模型下载发生在安装
   阶段，而不是用户翻译到一半；
5. 把「"<python>" "<sidecar.py>"」写进 `pdfParser.scan.sidecarPath`，用户不
   需要手填任何命令。

依赖与脚本都已就绪、只差命令时（第 2–4 步的结果都在，只是偏好被清掉），整段
跳过，直接补写命令——那可能是几分钟到十几分钟，不该重跑。

安装标记 `env.json` 记下解释器、脚本、索引源与引擎版本（`engineVersion`，
自检时从引擎读到，不是解释器版本），状态查询据此分四层报"未装解释器 / 缺依赖
/ 命令没填好 / 已就绪"。

失败语义：任一步失败都抛带本地化文案的错误（pip 与自检的错误带上输出末尾
400 字——版本冲突、镜像缺件、架构不符都写在那里），且不写安装标记、不回填
命令，半成品环境不会被当成装好了。取消与超时单独归类：取消抛
`ZTransplitCancelledError`（名字识别，见 `core/pdf/CancelledError.ts`），
超时用单独文案说明等了多久——两者都不该显示成"安装失败"。已就绪时零网络
直接返回（脚本刷新除外）。

入口：设置 → PDF 分屏翻译 →「识别环境」的「一键安装 / 修复…」
（`Zotero.ZTransplit.sidecarEnv`，进度窗显示在主窗口；修复先删旧环境再装）。
「修复」删掉 `ztransplit/scan-sidecar/` 并清掉命令偏好，避免它指向失效路径。
这一行没有「检查状态」按钮（运行时、Java、解析组件三行都有），状态在面板
每次显示时刷新，否则已装好的用户每次打开设置看到的都是空白。
体积与耗时如实告知用户：首次安装下载几百兆（paddlepaddle 一个包就有 100–
186 MB，模型权重另算），弱网下可能持续十几分钟，UI 文案必须说清楚。

测试：`tests/unit/core/pdf/scan/sidecarEnv.test.ts`（假宿主全链路：五步产物、
pip 与自检的 argv、命令回填、已就绪零网络、脚本刷新、只差命令时跳过重装、
命令写入失败、四类失败不写标记、取消与超时分类、状态四层、清理与重装）。

### 进程运行器的 JVM 参数（runProcess）

`runProcess` 在 Windows 上会给参数最前注入 JVM 的 UTF-8 编码属性
（`-Dfile.encoding=UTF-8` 等，CP936 主机下中文路径与消息才能 round-trip）。
这些参数只对 Java 有意义：Python 见到 `-D` 会以 "Unknown option: -D" 退出
（退出码 2），因此注入改为按可执行文件名判断（java / javaw 才注入），Java
调用方显式传 `{ jvmEncodingArgs: true }`，侧车与受管 Python 显式传 `false`。
此前是无条件注入——扫描识别的每次 Python 调用都会失败，而测试全部 mock 掉
`runProcess`，覆盖不到。

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
| `npm run check:python-runtime` | 随包 `PYTHON-RUNTIME.json` 的结构对账（`--online` 追加联网核对构件与镜像） |

## 测试分层

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/unit/` | 引擎分发、缓存、面板 DOM 行为、设置 pane 显隐与校验、朗读控制、JRE 托管安装中断安全（假宿主驱动真实 `JavaRuntimeManager`，含国内镜像取件/换源/兜底分支）、java 跨平台定位（内存虚拟文件系统驱动真实 `javaLocator`）、外部进程 runner 双分支（假 Subprocess/nsIProcess 驱动真实 `runProcess`）、Unicode 探针 fail-closed 判定逻辑（假进程库存/命令执行器驱动 `windows-unicode-probe-gates.mjs`） |
| 单元（真实网络，默认跳过） | `tests/unit/core/pdf/jreMirrorE2E.test.ts` | `ZT_E2E_NETWORK=1` 启用：真实 fetch/文件系统/子进程桩掉宿主边界，跑完整「官方校验和 → 国内镜像取件 → tar 解压 → java 探测」链路，数据目录用中文路径（覆盖 Windows 代码页问题） |
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

多会话隔离：通道根目录默认 `D:\zt-qa`，可用环境变量 `QA_ROOT` 覆盖（启动器与
探针副本同步改写，`shoot` 只结束当前根目录下的实例）。私有根目录名避开 `zt-qa`
子串，即可与上游 leadero 共用同一套默认路径而互不干扰。

探针补充命令：`scripts/qa/driver2/probe-extra.js` 存在时，启动器会在 `probe.js`
之后、`startProbe()` 之前用同一个作用域加载它，直接往既有 `PROBE_CMDS` 上挂命令。
单独一个文件是为了不改动 `probe.js` 本体——它可能带着其他轮次未提交的改动。
现有补充命令针对 Zotero 10 SDT 阅读模式的 iframe 文档（`probe.js` 的 `selectText`
选的是 pdf.js 文本层，SDT 模式下该层被隐藏，选不中）。

阅读器类型门控的补充命令：

- `kindGate {kind}`（`pdf`｜`snapshot`｜`epub`）：从 `<QA_ROOT>\fixtures\`
  导入并打开对应类型的附件，回报「翻译」区块的渲染与隐藏态、双语控制条、
  工具栏双语按钮、阅读器右键子菜单在真实宿主里的呈现，以及宿主自己算出的
  划词浮层参数。快照类型还会驱动一次真实选区（模拟 `_gotPointerUp` 后派发
  `selectionchange`），验证选区文本端到端送达面板。fixture 缺省在
  `<QA_ROOT>\fixtures\qa-reader-kind.<ext>`；EPUB 夹具由
  `python -I scripts/qa/make_epub_fixture.py scripts/qa/fixtures/qa-reader-kind.epub`
  生成（最小合法 EPUB 3，仓库内已提交）。
- `shotWindow {path}`：进程内 `drawWindow` 截取主窗口存 PNG。启动器侧的
  `PrintWindow` 对部分 Gecko 合成层不可靠——实测阅读器画面能抓到、右侧上下文
  面板抓不到；`drawWindow` 画的是屏幕真实合成的结果。

两个真机教训（都已钉进单元测试）：阅读器标签页的条目面板渲染的是附件的父
条目，区块门控必须先解析当前标签页的阅读器实例；快照阅读器没有
`_selectionRanges`，选区文本只由划词弹窗事件承载。

排版/引擎相关的真机发现都建议带上 `docs/screenshots/` 截图归档（本轮阅读器
类型门控的四张在 `docs/screenshots/reader-kind/`）。

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
