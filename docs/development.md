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

#### 扫描件的真机联调

纯函数与编排已被单测覆盖，但**没有任何测试真的启动过 Python 侧车**——管道
调用、模型权重下载、`--selftest` 构造引擎这三件事只在真机上验过。联调顺序：

```bash
node scripts/qa/real-machine.mjs boot
# 解释器这关先确认：应返回 ready 与一个绝对路径
node scripts/qa/real-machine.mjs send pyStatus
node scripts/qa/real-machine.mjs send envStatus
# 一键安装（几百兆，弱网十几分钟）：装解释器依赖、下模型权重、跑 selftest、
# 写安装标记并把命令回填进 pdfParser.scan.sidecarPath
node scripts/qa/real-machine.mjs send sidecarInstall
node scripts/qa/real-machine.mjs send envStatus      # 应变为就绪且已回填命令
# 对扫描件夹具跑整条管线
node scripts/qa/real-machine.mjs send installPdf D:\github_code\z-transplit\scripts\qa\fixtures\scanned-sample.pdf
node scripts/qa/real-machine.mjs send pipelineStart
node scripts/qa/real-machine.mjs send translated
```

要盯的观测点：进度行的 `scan-progress-start` / `scan-progress-retry` /
`scan-progress-batch` / `scan-progress-summary`；数据目录
`ztransplit/scan-state/<附件 id>/` 下的逐页 JSON 与 `run-manifest.json`；失败时
侧车的临时目录会保留（`ScanSidecarClient.ts` 只在失败时不删），里面的
`result.json` 与 stderr 诊断是定位依据。

`scanned-degraded.pdf` 走的是同一条链（`needsOcr` 对 scanned 与 degraded 一视
同仁），区别只在分类那一行的计数：它用来验证「有文本层但是乱码」的页确实被
送去识别，而不是当成数字页直接机器翻译。

#### 扫描件链路的真机试装结果（2026-11-19）

第一次完整试装（Windows + Python 3.13 + Zotero 10.0.8 隔离 profile）连撞四个
问题，前三个已修，第四个仍未解。按撞到的顺序记，免得下次从头查：

1. **`requirements.txt` 装得出、跑不起。** 只写 `paddleocr` 时 pip 全部成功，
   但 `--selftest` 过不去。缺两项：`paddlex[ocr]`（paddleocr 只带 `ocr-core`
   子集，不含 PP-StructureV3 要的全量附加依赖，缺的是 einops、ftfy、
   premailer、sentencepiece、tiktoken）和 `paddlepaddle` 本身（paddlex 的 151
   个 extra 里没有一个声明推理引擎）。已补进 requirements.txt。

2. **状态查询读错偏好分支。** `Zotero.Prefs.get` 的第二个参数是分支，漏掉它读
   的是另一个分支、拿回来恒为 undefined。安装五步全部成功、偏好也确实写进去
   了，`envStatus` 却一直报「命令未回填」，`ready` 永远是 false。已改用
   `src/utils/prefs.ts` 的 `getPref`；测试桩也改成忠实于真机语义（不带分支
   参数就返回空），并补了「四步全齐时 ready 为真」的正面断言——此前只有断言
   false 的各种形状，这类缺陷照样全绿。

3. **侧车把 PIL 图像传给引擎，被静默忽略。** PaddleX 3.x 的 `predict` 只收
   `numpy.ndarray` 或文件路径；传 PIL 图像不抛异常，只打一条
   "Not supported input data type! ... So has been ignored" 然后跳过整页。
   结果是每页 lines/tables/figures 全空、coverage 0，而侧车报告
   "recognized N page(s)"。已转成 numpy 数组，并补了「这一页什么都没认到」
   的显式告警——加上它之后第 4 个问题才立刻可见。

4. **仍未解：oneDNN 的 PIR 属性转换在 Comet Lake CPU 上不实现。** 修完前三个
   之后引擎真的开始推理，随即在文字检测模型上报
   `NotImplementedError: (Unimplemented) ConvertPirAttribute2RuntimeAttribute
   not support [pir::ArrayAttribute<pir::DoubleAttribute>]`（
   `paddle/fluid/framework/new_executor/instruction/onednn/onednn_instruction.cc`）。
   试过且无效：`FLAGS_use_mkldnn=false`、`FLAGS_enable_pir_api=0`、
   升级 paddlepaddle（3.3.1 已是 PyPI 最新）。机器是 i7-10510U（有 AVX2、
   无 AVX-512）。PaddleX 的 runner 在 `run_mode` 不含 mkldnn 时本应调
   `disable_mkldnn`，说明融合发生在新执行器的 PIR 阶段，绕不开。
   **结论：识别链路在本机跑不通，卡在框架层，不是插件代码问题。** 换一台
   CPU（有 AVX-512）或等 paddle 修这个转换再验。

前三个修复都有单测；第四个的复现步骤就是上面那条最小命令，见
`addon/scan-sidecar/requirements.txt` 顶部注释里的版本记录。

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

侧车跑在插件外的 Python 里。解释器按「受管运行时 → 系统 Python」的顺序解析
（`resolvePython`）：机器上已有合格的 Python 就直接用，一个字节都不下载；两者
都没有才由插件按平台分发受管运行时，落地在数据目录 `ztransplit/python-runtime/`
（内部即上游发行版的 `python/` 布局，可执行文件路径以清单为准）。

系统候选的采用条件（三关，任一不过就换下一个候选，全不过则装受管运行时）：

1. 起得来，版本不低于 3.9（引擎与依赖的支持面）；
2. pip 可导入——依赖要装进这个环境，没有 pip 的解释器对一键安装没用；
3. 64 位——paddlepaddle 没有 32 位 Windows 轮子，装到一半才失败最难查。

三关合成一条 `python -c` 命令（版本 / 指针宽度 / pip 可导入，输出三行）。分成
三次调用时状态查询实测要两秒（Windows 每次冷进程启动几百毫秒），合成后 286 毫秒。

两条真机教训（都已钉进测试）：

1. **Gecko 的 Subprocess 不做 PATH 查找**。按名字启动
   （`Subprocess.call({ command: "python" })`）会以
   "File at path \"python\" does not exist, or is not executable" 失败，哪怕
   PATH 里就有那个文件（真机实测：Zotero 10.0.8 / Windows，PATH 含
   `C:\Python313`）。因此候选必须先用 `pathSearch` 解析成绝对路径——否则
   "用机器上已有的 Python"这条路永远不会触发，只会静默退回下载受管运行时。
   顺带把 javaLocator 的 PATH 搜索也收敛到同一份实现。
2. **不要给系统解析加会话级缓存**。第一版做了缓存，立刻被测试打脸：缓存会让
   "使用期间装上的 Python"看不见，也会让"卸掉的 Python"继续显示就绪。现在每次
   现探。

候选只收 `python3` / `python`（顺序即优先级）：Windows 的 `py` 启动器要带附加
参数，会让侧车命令形状变复杂，而真装了 Python 的机器上 `python.exe` 基本都在
PATH 上。

受管运行时的链路与 jar、JRE 同一形状：

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
（`Zotero.ZTransplit.python`，进度窗显示在主窗口）。状态行区分来源：用的是
受管运行时还是机器上已有的 Python（`PythonRuntimeStatus.source`）。「安装 /
修复」始终装受管运行时——它是显式动作，用户要的就是插件自己那一份。本模块
只管解释器；侧车脚本落地与依赖安装由下一节的一键安装接着办完。

### 识别环境一键安装（sidecarEnv）

用户此前的路径是「自己装 Python → 自己 pip install → 自己抄一条命令进设置」，
三步任何一步卡住，扫描识别就用不上。`src/core/pdf/scan/sidecarEnv.ts` 把三步
合成一次点击，五步顺序即依赖关系：

1. 把随包的 `scan-sidecar/sidecar.py` 与 `requirements.txt` 落到数据目录
   `ztransplit/scan-sidecar/`——打包安装时脚本在 XPI 里，不能直接当命令执行。
   这一步每次都做（几 KB、不联网）：插件升级带来新版侧车时，已就绪的短路
   不能沿用盘上的旧脚本；
2. 解释器：按上一节的顺序解析——机器上已有合格的 Python 就直接用（依赖装入
   那个环境，UI 文案如实说明），已装好的受管运行时同样直接用；两者都没有才
   下载受管运行时。用系统 Python 时没有"安装运行时"这一阶段，进度直接进依赖；
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

安装标记 `env.json` 记下解释器、解释器来源（`pythonSource`：受管运行时还是
机器上已有的 Python）、脚本、索引源与引擎版本（`engineVersion`，自检时从引擎
读到，不是解释器版本），状态查询据此分四层报"未装解释器 / 缺依赖 / 命令没填好
/ 已就绪"，就绪时报出用的是哪一个解释器。

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
| `npm run test:benchmark` | 版面保留翻译的评测基准：度量库自检 + 与基线逐指标判回归 |

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
真实接口面与 findEntries/extract 行为探查）、`pyStatus` / `envStatus`（识别
解释器与识别环境状态，直调 `Zotero.ZTransplit.python.getStatus` 与
`sidecarEnv.getStatus`——这两个查询会真的起进程探活，是"系统 Python 在 Zotero
自己的进程环境里找不找得到"唯一能在真机确认的地方）。

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

#### 版式与扫描件夹具

原有两篇夹具都是「HTML 经无头 Edge 打印成 PDF」的产物，但转换命令没有入库，
加夹具只能靠猜。`scripts/qa/make_pdf_fixtures.py` 把这一步固化，一次生成五篇：

| 夹具 | 版式 | 专门暴露什么 |
|---|---|---|
| `formula-dense.pdf` | 双栏 | 编号独立公式、行内公式、公式引用句；含希腊字母与不等号的统计段（喂 `isFormulaParagraph` 误报）；`a² + b² = c²` 这类不含符号类字符的算术式（喂漏报） |
| `three-column.pdf` | 三栏带栏线 + 跨栏标题 + 通栏图 | 栏检测缺失、栏间文字串位 |
| `landscape-slides.pdf` | `@page { size: A4 landscape }`，大字号标题 | 非纵向页面、通栏、大字号 |
| `scanned-sample.pdf` | 纯位图，无文本层 | `textLength` 判不到字符 → scanned 分支 |
| `scanned-degraded.pdf` | 同源位图 + 损坏的 ToUnicode 文本层 | `saneRatio` 低于 0.9 → degraded 分支 |

```
python scripts/qa/make_pdf_fixtures.py
```

两个实现要点，都是实测踩出来的：

- 脚本不用 `python -I`。它要 import 用户 site-packages 里的 pymupdf，隔离模式
  看不见；它读的外部文件只有仓库自己的 `reading-brain.pdf`，HTML 全是文件内
  常量，没有需要 `-I` 防的不可信输入。
- 扫描件的乱码文本层不能直接插乱码字符。分类器认定的乱码是三样——C0/C1 控制符、
  私用区码位、替换符；实测 C0 控制符能被 pymupdf 原样往返但 PDFBox 会整个丢掉，
  替换符与私用区码位则被 pymupdf 在插入时换成间隔号（不在乱码类里）。可行的
  做法是先按原位插一遍正常文字（白色，看不见），再给字体的 ToUnicode 表挂一张
  把部分码位指向私用区的 CMap——字形由字体编码决定，画面仍是干净扫描图，提取
  则拿到私用区乱码，这正是真实世界里映射损坏那种 PDF 的成因。

在真机上跑某一篇：

```
node scripts/qa/real-machine.mjs send installPdf D:\github_code\z-transplit\scripts\qa\fixtures\<夹具>.pdf
node scripts/qa/real-machine.mjs send pipelineStart
node scripts/qa/real-machine.mjs send translated      # 轮询到译文附件出现
node scripts/qa/real-machine.mjs send openShot '{"id":<译文附件 id>,"path":"D:\\zt-qa\\<名>.png"}'
```

这五篇的字号与元素类型分布已统计（用于定「图内文字」的识别规则，见
`src/core/pdf/translation/figureTextFilter.ts` 的既有讨论）：图内标注的字号在
6.0 到 6.8 磅之间，各篇正文的主导字号在 8.5 到 11 磅之间，而最小的正文类元素
（图题、参考文献）不低于主导字号的 84%。

#### 评测基准（scripts/qa/benchmark/）

在此之前，版面质量只有一种验证方式：截图，人眼对照。截图给不出可复现的答案，
八个版式修复批次每一批都要回答「修好了还是修坏了」，没有基准就只能每批重新
看一遍图。这个目录把这件事变成数字。

三个文件，经文件交换数据，互不 import：

| 文件 | 职责 |
|---|---|
| `metrics.py` | 只放「怎么算数」。A/B/C 三组指标全是纯函数，带 `--selftest` |
| `run.py` | 只放「怎么跑」。调解析器、跑无头渲染、出报告、判门禁 |
| `render-entry.ts` | 无头渲染驱动，esbuild 打包后由 Node 执行。是基准与产品代码之间唯一的接触点 |

`run.py` 的 assemble 模式走的是 `adaptOpenDataLoaderJson` →
`odlAnalysisToAssembly`，render 模式走 `renderOverlayTranslated`——同一条装配与
渲染代码，只是不走适配器。因此基准量的是产品自己的排版逻辑，不是复刻品。

```
python scripts/qa/benchmark/metrics.py --selftest      # 37 条合成扰动断言
python scripts/qa/benchmark/run.py --regen-keys         # 从夹具 HTML 重生成答案键
python scripts/qa/benchmark/run.py                      # 跑全部数字版夹具
python scripts/qa/benchmark/run.py formula-dense        # 只跑一篇
python scripts/qa/benchmark/run.py --write-baseline     # 产基线（第一跑只做这个）
python scripts/qa/benchmark/run.py --gate               # 与基线比，判回归
python scripts/qa/benchmark/run.py --ocr                # 扫描件层
python scripts/qa/benchmark/run.py --real-machine formula-dense   # 真机抽查
python scripts/qa/benchmark/run.py --real-machine --reuse-translated formula-dense
```

真机抽查有两档。默认档会重新点火流水线，全新 profile 的第一次要反复重试
「PDFViewerApplication not ready in reader iframe」，实测十分钟以上，慢在与版面
无关的一次性初始化上。`--reuse-translated` 不重点火，直接度量库里已有的译文附件
（打印文件的修改时间，避免拿一份旧文件得出一个看起来新鲜的结论）——只要比对数字，
这一档就够了。

答案键（`answer-keys/*.json`）只存语义真值：元素类型、顺序、文本、是否公式段、
标题层级、表格行列、栏数、横版标记。坐标一概不记——HTML 没有页的概念，坐标由
度量端按文本相似度与解析器产出配对，避免手抄坐标出错。公式的边界样本是内容推导
出来的：通篇符号密度跨过阈值 2 的非公式段记 `false-positive-bait`，含上标/属于/
子集/空集/真减号这些不在符号类里的字符的记 `false-negative-bait`。

三组指标：

- **A 组 解析层**：原文 PDF 经解析器得 JSON，与答案键比。公式判域的精确率与
  召回率（含逐案表）、段落匹配 F1（按类型分组）、栏串位率、标题层级一致率、
  表格结构误差、阅读顺序 Kendall tau、图区检出。
- **B 组 端到端层**：无头渲染产出译文 PDF 后度量。边界框交并比（BabelDOC 论文
  的 BIoU，另拆出覆盖率与框内滞留率）、每页未翻译块数、越界计数、字号保持率、
  遮罩侵入（压到别段或图区表格区）、框外像素差异、原文残留率、渲染器统计。
- **C 组 扫描件层**：侧车产出对 `reading-brain.pdf` 的已知原文。字符错误率、
  词错误率、段落召回、坐标交并比、阅读顺序。本机推理跑不通（见
  「扫描件链路的真机试装结果」），这一组现在必然报 `unavailable`，不许假装通过。

坐标系全文只有一套：PDF 用户空间，原点在页面左下角，y 向上。解析器的
`bounding box` 直接可用；pymupdf 的 span bbox 与 drawings rect 是左上原点 y 向下，
必须先翻。忘这一步会让所有交并比整体镜像，而数字看起来仍然「合理」——所以翻转
函数只有一个入口 `flip_y`，并且自检里有一条专门断言它。

三条设计约束，都是踩过才写下来的：

- **门禁判相对回归，不判绝对阈值。** 当前代码是带着八个批次要修的缺陷的，用
  当前状态定绝对阈值，等于把要修的缺陷一起冻进门禁。第一跑 `--write-baseline`，
  人工核对后提交 `baseline.json`；之后任何指标朝坏方向越过容差即失败（交并比类
  0.02，比率类 0.01，计数类 0）。绝对底线只有两条：框外像素差异不大于 0.002
  （沿用原型那个跑过 14 个文档的探针的阈值）、交并比大于 0。
- **指标抓不住扰动比没有指标更糟。** 自检用合成小样本断言每个指标都能抓住已知
  扰动：译文搬到框外，交并比必须塌成 0；白遮罩盖住邻栏，侵入必须报；盖掉框外
  内容，像素差异必须大于 0。这条纪律真抓到过两个 bug——生成器的终止分支写成
  `return` 而非 `yield`，门禁因此一个指标都比不了、永远说绿。
- **真值下标与解析器块下标是两个编号空间。** 答案键 30 个元素、解析器 62 个块
  （表格单元格与图内标注都算块），直接拿两边的 order 集合求交，只在两边条数
  恰好相等时碰巧正确。公式三项曾因此在 `formula-dense`（26 对 26）上数字全对、
  在 `attention-reading`（30 对 62）上恒为 0。现在三项都经配对换算，自检里有一条
  专门构造错开下标的用例钉住它。

第一跑的数字（2026-11-20，合成译文长度比 0.55）：

| 夹具 | 公式精确率 | 公式召回率 | 段落 F1 | 栏串位率 | 交并比 | 框内滞留 | 框外像素差异 |
|---|---|---|---|---|---|---|---|
| reading-brain | — | — | 1.000 | 0.000 | 0.813 | 0.970 | 0.00000 |
| attention-reading | 1.000 | 1.000 | 0.652 | 0.032 | 0.752 | 0.938 | 0.00000 |
| formula-dense | 0.571 | 1.000 | 1.000 | 0.038 | 0.785 | 0.974 | 0.00000 |
| three-column | — | — | 0.894 | 0.115 | 0.729 | 0.924 | 0.00000 |
| landscape-slides | — | — | 0.813 | 0.000 | 0.705 | 0.899 | 0.00000 |

第三批批次 1（公式链路粒度）修完之后的数字，同一天、同一套夹具：

| 夹具 | 公式精确率 | 公式召回率 | 段落 F1 | 交并比 | 公式子区间标记 | 截图回贴 | 渲染含公式段 |
|---|---|---|---|---|---|---|---|
| reading-brain | — | — | 1.000 | 0.813 | 0 | 0 | 0 |
| attention-reading | 1.000 | 1.000 | 0.652 | 0.753 | 2 | 1 | 1 |
| formula-dense | **1.000** | 1.000 | 1.000 | 0.782 | **25** | **4** | **11** |
| three-column | — | — | 0.894 | 0.729 | 0 | 0 | 0 |
| landscape-slides | — | — | 0.813 | 0.705 | 0 | 0 | 0 |

四项变化的含义：

- **精确率 0.571 → 1.000**。三个统计正文段（答案键 order 14、18、22）不再被
  整段判成公式区。判据从"只数公式字符匹配次数"改成"公式字符够多 **且**
  长度不小于 4 的拉丁实词不超过一个 **且** 汉字不超过 8 个"。
- **公式子区间标记 0 → 25**。这是新增的观察项，数的是装配层写进送翻译文本的
  `$...$`对数。此前恒为 0，因为链路只做整段替换，行内公式从来没有机器可判的
  边界。`a² + b² = c²` 这类上标算式从漏报变成被圈住。
- **截图回贴 7 → 4**。截图从默认行为降级为兜底：只有拿不到 LaTeX 的区域才贴。
  三个误报段不再被原文截图盖死，这正是精确率修复的直接收益。
- **渲染含公式段 0 → 11**。新增的 `stats.formulasRendered`，数的是译文 PDF 里
  真的画出了公式的段落数。合成译文现在会原样带回 `$...$` 子串，模拟一个遵守
  公式保护契约的引擎；此前它生成纯中文，这项恒为 0，保护层的往返没有任何
  端到端度量。

仍然没解决的两件事，留给后面的批次：`three-column` 的栏串位率 0.115 与偏低的
交并比是解析器把中段多栏并成了一个横跨两栏的大块（第三批批次 2 的目标）；
五篇的原文残留率全是 1.000——叠加模式的遮罩只遮画面，文本层里原文一个字符都没
少，读者复制全文会复制到原文（第三批批次 7 的目标）。批次 1 顺带补上了删除端
与渲染端的几何对齐（裁剪后外扩 1 磅、越界框过 MediaBox），但那要等删除器真的
跑起来才看得出来。

### 第三批批次 2（栏检测与全宽段落）

先说结论：`three-column` 的交并比从 0.729 升到 0.759，`attention-reading` 从
0.753 升到 0.773，两篇的遮罩侵入段落从看不见的 0（度量有缺陷）变成 12 与 8，
再降到 0。`stats.overflowed` 五篇全为 0，没有上涨。

批次 2 与前两批最大的不同：**修正缺陷会让现有指标先变差，所以度量侧必须先改**。

根因不是"缺少栏检测算法"，是解析器把多栏流式排版并成了一个块。用 PyMuPDF 量出
真实几何：`three-column` 那个宽 334.83 磅的块，边界框是第一栏底部两行
（x 42.75–201.66、y 511.58–532.24）与第二栏顶部六行（x 218.67–377.58、
y 665.33–733.99）的并集。同一缺陷在 `attention-reading` 第 2 页也存在：一个宽
504.73 磅、高 251.26 的块，几何上完整包住同页另外 10 个块。所以修法必须通用。

**度量侧两处修正。** `_mask_ownership` 的判据原本是
`mask.intersect(box) - owner.intersect(box) > 1.0`。当跨栏大框是主人且完整包含
邻段时，两个交集相等，差值恒为 0——真实的侵入被减掉了，`three-column` 的这项
指标因此永远是 0，而那正是缺陷最严重的一篇。改成不减法：段落框理论上互不重叠，
遮罩压到别人就该报。`column_bleed` 的栏宽原本按"页宽除以答案键栏数"算，三栏得
198.32 磅，比真实栏宽 158.906 磅高估四分之一，导致坐标轴标签那行差 2 磅落选；
改成从同页段落框投影实测栏宽（取众数，并用"至少两个块或总数的四成"挡住横版
幻灯片那种众数落在 8 磅刻度标签上的情形）。同时新增 `mergedBlockRatio`：边界框
完整包含至少三个同页其它段落的块占比，它直接度量"合并块吞掉邻段"这个实际问题。

**装配侧新增 `src/core/pdf/translation/columnLayout.ts`。** 栏检测按覆盖计数做，
不按布尔投影：通栏元素（图注、通栏标题、坐标轴标签）横跨整页，会把栏间空白缝
起来，三栏夹具上用布尔投影整页横向无一空隙，一条栏界都找不到；而栏间空白只被
这几个通栏元素经过，覆盖数远低于栏内区域（三栏实测栏内 8 到 11、空白 2）。跨栏
识别用两个判据取或：完整包含至少三个同页其它块（直接证据，通栏标题虽宽但不包住
别人），或跨越至少两个栏带且块高超过字号 18 倍（兜底邻居也被吞掉的情形）。

**片段几何调了两级，都是实测逼出来的。** 第一级：y 范围取栏带内兄弟块未占用的
最大空隙，恢复出的片段比真实内容高 6.77 与 7.09 磅，正好盖住邻段第一行——那两层
是邻段边界与真实内容之间的栏内留白，实测为字号的 0.797 与 0.834 倍。于是在顶到
邻段边界的那些端上按 0.8 倍字号收缩，合并块边界框自身的两端不收缩（那两端与
真实内容的起点终点分毫不差）。收缩后遮罩侵入从 4 处降到 0。第二级：片段横向边
界原本取栏界，而栏界是栏间空白的中点，落在空白里——`attention-reading` 第 2 页
栏界 297.5，真实栏缘却是 284.62 与 310.13，按栏界切会让片段向右伸进第二栏十二磅
多。改成用栏带内兄弟块的 x 极值夹，三栏那两段的横向边界从此与 PyMuPDF 量出的
真实矩形片完全一致。

**`mergedBlockRatio` 没有归零，这是度量口径不是修复失败。** 它量的是解析器产出
（`flatten_odl(odl_doc)`），而修复在装配层——解析器照样吐出那个合并块，装配层
把它切开。它的作用是发现缺陷的探测器：参数或引擎版本变化导致合并块增多时它会
报警，但它不随修复变化。`crossColumnRatio` 从 0.115 涨到 0.154 同理，纯粹是栏宽
口径从"页宽除以栏数"改成实测之后，阈值从 277.8 降到 222.47，坐标轴标签那行这才
被计入——度量变准了，不是产品变差。**因此基线重新生成过一次**，`baseline.json`
写于 2026-11-21 00:55，五篇的遮罩侵入段落与 `stats.overflowed` 都是 0。

批 2 新增 `tests/node/column-layout.spec.ts` 共 35 条，测试数据是五篇夹具的真实
块框（基准数据在仓库外，所以抄进来而不去读）：栏界在三栏得两个、双栏得一个、
单栏与横版两页都得零个；跨栏识别在两个已知实例上命中、在两页其余 52 个块上全不
命中；片段几何对着 PyMuPDF 量出的真值逐项比对，并逐对检查片段不压到同栏任何
兄弟块。

### 第三批批次 3（图内文字）

这一批没有改产品代码，改的是"这件事能不能看见"。

先说清一个此前没人发现的事实：`figureTextFilter` 这个模块想实现图片区域文字整体
排除——不翻译、不画遮罩、不删原文、不叠印译文。它有 8 条单测、有页级包装护栏、
注释把设计意图写得很清楚。**但它在真实数据上从未生效过一次。** 它依赖删除器的
`--inspect` 模式报告"含文字表单对象"的边界框，而对五篇夹具实跑
`java -jar ztransplit-region-text-remover.jar --inspect three-column.pdf`，输出是
`inspect forms=0`——一篇都没有。三栏的图是 PDFBox 画的纯矢量图，文字在页面层而不
在表单对象里，`--inspect` 的结构假设不成立。同时无头基准根本没有调用这个过滤
（`render-entry.ts` 的 `assemble()` 只走 `adaptOpenDataLoaderJson` →
`odlAnalysisToAssembly`），所以两条路径在图内文字上"一致地"都不排除。

后果已用渲染证实。三栏的坐标轴变成中文：纵轴刻度是 `置信`、`测量`、`后续`，横轴
`Wk 1 Wk 3 Wk 5 Wk 6` 变成一行中文，图例变成 `结果支持注意力` 与
`资源重组的解释`，而数据线与图框还是原样。真机上原文会被删除器删掉，所以只剩中文
刻度。

**新增 `parse.figureText` 度量**，三个数字层层递进：

| 夹具 | 真值 | 检出 | 当正文处理的段落 |
|---|---|---|---|
| three-column | 9 | 9 | 5 |
| landscape-slides | 12 | 12 | 6 |
| attention-reading | 15 | 15 | 7 |
| reading-brain / formula-dense | 0 | 0 | 0 |
| 合计 | 36 | 36 | 18 |

`truth` 来自夹具 HTML 的 SVG `<text>` 节点——图内文字在夹具里全部写成 SVG 文字
节点，`FixtureHtmlParser` 新数的，与解析器无关。`detected` 是判据从源 PDF 检出的
跨度数，用来验证判据本身：**36 对 36，零误报零漏报**。`paragraphs` 才是产品行为：
18 个装配段落被当正文翻译、画遮罩、删原文、叠印译文，与 ODL 块一一对应（三栏正是
`30`、`15`、`0`、`Wk 1 Wk 3 Wk 5 Wk 6`、`Shallow sensor Deep sensor` 这五段）。

判据是两条同时满足：字号小于该页文字跨度字号中位数的 0.8 倍，且跨度中心落在矢量
路径簇内。两个设计点都是实测逼出来的：

- **中位数不用众数**。横版幻灯片那页的字号众数是 6.75，那正是图内文字的字号——
  按众数取阈值会得 5.40，一篇图内文字都检不出。中位数 10.24 正常。自检里有一条
  断言专门照那页的真实分布合成数据钉住这个反例。
- **矢量簇条件挡住表格误伤**。attention-reading 页 1 的表格文字字号 8.20，与中位
  数 8.80 的比值 0.93，过不了字号这一关；簇条件再兜一层。簇由路径包围盒按页高
  3% 间隙贪心合并，阈值故意取粗——三栏的装饰栏线与图只隔 6.8 磅，任何精细阈值都会
  把它们并成一簇，而并成一簇不可怕，簇内正文靠字号条件挡掉。

**度量过程中的一处自我纠正**：段落配对最初用"段落中心落在任一检出跨度内"，结果
三栏只数出 3 段。原因是 `Wk 1 Wk 3 Wk 5 Wk 6` 是 4 个跨度并成一段，段落中心落在
`Wk 3` 与 `Wk 5` 之间的空档里，按中心判把这段整个漏掉——而它恰恰是最显眼的一处
图内文字。改成按"段落框与检出跨度框有交集"判定，五篇各自数出 5、6、7 段，与 ODL
块一一对应。

**顺带修掉一个会静默吞数据的坑**：`--regen-keys` 是全量覆盖，而 `columnLeftEdges`
是批 2 手工补进去的实测真值、`summary()` 产不出它——跑一次 regen 就会把它清掉。
`regen_keys` 现在会在写文件前把"旧文件有、新产出没有"的保留字段合并回去，并打印
合并了什么。

**判据的适用边界要说清楚**：五篇上零误报零漏报，不代表普遍成立。脚注、上标、
参考文献小字号在别的文档上可能落进"字号小于中位数 0.8 倍"里，矢量簇条件能挡掉
一部分（这类文字通常不在图形区域里），但不能全挡。所以这一项是观测值，产品侧真要
改行为时需要在更多真实文档上验证。

产品侧第一版可以只用字号判据：ODL 已经给了每段的 `fontSize`，不需要新的图区输入；
矢量簇条件要等产品侧能拿到绘图路径（pdf.js 的 operator list）再补。翻不翻图内文字
仍然是待定的产品决策，这一批只是把规模摆到了桌面上。

**基准不覆盖什么，说清楚免得误信。** 无头路径不走
`src/core/pdf/translation/opendataloaderSplitAdapter.ts`，因此不覆盖：页面范围
选择、译文附件创建、进度汇总、白页兜底合并模式。公式截图的取图路径也不等价——
无头用 pymupdf 渲染同一块区域，真机是借阅读器的活 pdf.js 实例；截图内容等价，
取图路径不等价。这三块只能靠 `--real-machine` 抽查确认，那也是它存在的唯一目的：
不是每批都跑，是回答「无头路径可不可信」。

第一次真机抽查（2026-11-20，`formula-dense`）给出的答案是无头路径在版面指标上
可信，在原文删除上完全没覆盖：

| 指标 | 真机 | 无头 |
|---|---|---|
| 交并比 | 0.723 | 0.785 |
| 框内滞留 | 0.974 | 0.974 |
| 每页未翻译块 | 0 | 0 |
| 遮罩侵入段落 | 0 | 0 |
| 框外像素差异 | 0.00000 | 0.00000 |
| **原文残留率** | **0.000** | **1.000** |

交并比差 0.06 是译文长度不同造成的，不是缺陷：真机走模拟引擎，无头走长度受控的
合成译文，两者填满框的程度本就不同。四项版面指标完全一致，说明无头路径复现的装
配与渲染和真机是同一条。

原文残留率那一行的 1.000 对 0.000 是真发现：真机跑通了
`ztransplit-region-text-remover.jar`，原文被真的从内容流里删掉了（所以译文 PDF
里一个白遮罩都没有，`maskOriginalText` 传的是 false）；无头路径不跑删除器，原文
整个留在文本层。这正是上面列的不覆盖项，现在有了数字——第三批批次 7 要做的
「删除器回传跳过流数、为 0 强制回落遮罩」，在无头路径上根本测不到，只能靠真机。

#### 外部基准接入实测（pdf-parse-bench）

自建基准量的是装配与渲染，解析器本身一直缺一把外部的尺子。`pdf-parse-bench`
（MIT，`pip install pdf-parse-bench`）是 2025-2026 年唯一新的独立解析器横评，
榜上有 22 个系统，但没有 OpenDataLoader——本项目整个版面链路建立在它上面，
它在公式与表格提取上的真实位置一直是个未知数。2026-11-20 实测接入，结论分两半。

**能跑通的部分（全部本地，无接口密钥）：**

```
pip install pdf-parse-bench
# 基准数据在 HuggingFace，直连不通时用镜像
#   https://hf-mirror.com/datasets/piushorn/pdf-parse-bench
# 目录结构：<数据集名>/{pdfs,ground_truth}/<编号>.{pdf,json}
# 公式集 100 篇，表格集 100 篇，实测下载 11.4 MB / 62 秒

# 1. 用本项目的 jar 解析（参数与产品一致）
java -jar src/core/pdf/lib/opendataloader-pdf-cli.jar \
  --format json --output-dir <odl-out> --reading-order xycut \
  --table-method default --image-output embedded --use-struct-tree <pdf>

# 2. ODL JSON 转成它要的 markdown（scripts/qa/benchmark/external/odl_to_markdown.py）
python scripts/qa/benchmark/external/odl_to_markdown.py <odl-out> - results/opendataloader

# 3. 不调用裁判的公式覆盖比对
python scripts/qa/benchmark/external/odl_formula_coverage.py \
  <数据集>/ground_truth results/opendataloader
```

实测：解析 100 篇 67 秒，转换 100 篇无一为空。

**跑不通的部分：正式分数必须走 OpenRouter。** `extract()` 与 `evaluate()` 两步
的客户端 `base_url` 都是硬编码的 `https://openrouter.ai/api/v1`，只从
`OPENROUTER_API_KEY` 取密钥，没有环境变量能改端点。所以「换成本地裁判模型做到
全离线」这条路不存在——能换的只有模型 ID，仍走 OpenRouter。设了密钥之后：

```python
from pathlib import Path
from pdf_parse_bench import Benchmark
bench = Benchmark(
    parser_output_dir=Path("results/opendataloader"),
    ground_truth_dir=Path("<数据集>/ground_truth"),
    llm_judge_models=["google/gemma-4-31b-it"],
)
bench.extract(); bench.evaluate(); bench.save_benchmark_summary()
```

榜单显示 100 页的裁判成本约 0.20 到 3.00 美元，取决于选哪个裁判。

**没有密钥时能得到的，是公式覆盖比对（2026-11-20，公式集 100 篇 / 2,070 条公式）：**

| 判据 | 结果 |
|---|---|
| 公式内容字符覆盖率（去 LaTeX 命令名后） | 0.998 |
| 字符找齐的公式（宽松，允许分散在多段） | 2,051/2,070 = 0.991 |
| 作为连续子串完整出现的公式（严格） | 1,525/2,070 = 0.737 |
| 解析输出平均段落数 | 29.7 |

这三个数字的层次正是批次 1 的输入：**内容不缺（99.8%），字符不缺（99.1%），
但 26.3% 的公式不是作为一个整体被提取出来的**。ODL 把 `(I − A)^n =` 这样的
公式拆成五六个段落，变量提成 Unicode 数学斜体（`𝐾` 是 U+1D43E 而不是 ASCII 的
K），上下标位置丢失。这与本项目自己的发现完全吻合——`odlToAssembly` 只能靠字符
密度启发式猜哪段是公式，之所以误报率 43%，根源不在"提不到内容"，在"提不到这是
一条公式"这个判断。

两个实现要点，都是实测踩出来的：

- **字符比对前必须做 NFKC 归一化。** LaTeX 生成的 PDF，其文本层用的是 Unicode
  的数学字母数字符号：斜体 K 是 U+1D43E、斜体 X 是 U+1D44B、斜体 f 是 U+1D453。
  不归一化就把公式里的变量整个算成缺失，第一版覆盖率凭空掉到 0.695（最低篇），
  把"解析输出把变量提成了数学斜体"误读成"内容丢失"。
- **覆盖比对的分数与榜上那个 0 到 10 的裁判分不可比。** 该基准自己的论文测出，
  文本级指标与人判的相关性只有 0.01 到 0.31（公式）、0.70（表格，TEDS/GriTS
  上限），LLM 裁判才有 0.74 到 0.82。所以上面三个数只能当"这个后端在公式上是
  否基本可用"的下界估计，不能换算成榜上分数。

**UniMER-Test 加 CDM 暂不接入。** 它评的是"把公式图片转成 LaTeX"，需要一个
公式识别模型；本项目的公式链路是 OpenDataLoader 加可选的视觉模型端点，当前没
有这样一个模型可评。等批次 1 把视觉模型提 LaTeX 那段接通，再用它单独量化那一环
（数据集 Apache-2.0、支持中文公式、可离线，是三个候选里唯一许可证干净的）。

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
