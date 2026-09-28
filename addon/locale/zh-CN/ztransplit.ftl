## Z-Transplit — 核心文案。
##
## 消息 id 一律不带 `ztransplit-` 前缀：构建时由 zotero-plugin-scaffold 的
## build.fluent（prefixFluentMessages，默认开启）统一加上，src/utils/locale.ts
## 也按同样规则读取。详见 en-US/ztransplit.ftl 顶部说明。
##
## 本目录的键集合必须与 en-US 完全一致——Zotero 按文件粒度选择插件 locale，
## 缺失的文件会回落到 en-US。

## 引擎错误与提示（src/core/translation/translationEngines.ts）
## 键名沿用 leadero 的 translation-error-* 命名。ai-prompt-* 同时是
## src/core/translation/promptTemplate.ts 的模板拒绝原因：每条规则一个文案，
## 运行时报错与设置面板的即时提示共用同一套措辞。
translation-error-google-empty = Google 翻译返回了空结果
translation-error-bing-empty = Bing 翻译返回了空结果
translation-error-deepl-empty = DeepL 返回了空结果
translation-error-custom-empty = 自定义接口返回了空结果
translation-error-google-failed = Google 翻译失败
translation-error-bing-failed = Bing 翻译失败
translation-error-deepl-failed = DeepL 翻译失败
translation-error-custom-failed = 自定义接口翻译失败
translation-error-pdf-translate-failed = zotero-pdf-translate 翻译失败
translation-error-bing-not-configured = Bing 翻译未配置 API 密钥
translation-error-deepl-not-configured = DeepL 翻译未配置 API 密钥
translation-error-custom-url-missing = 自定义翻译接口地址未配置
translation-error-google-fallback-failed = Google 翻译失败（{ $googleError }）；Bing 网页兜底也失败（{ $bingError }）
translation-error-unknown = 未知错误
translation-error-bing-token-unavailable = 无法获取 Bing 翻译令牌（页面结构可能已变化）
translation-error-bing-rejected = Bing 拒绝了请求（{ $status }）
translation-error-pdf-translate-missing = 未安装或未启用 zotero-pdf-translate 插件。请在 Zotero 的插件管理器中安装并启用。
translation-error-ai-empty = AI 翻译返回了空结果
translation-error-ai-failed = AI 翻译失败
translation-error-ai-url-missing = AI 翻译接口地址未配置

## AI 引擎提示词模板的拒绝原因（src/core/translation/promptTemplate.ts）
translation-error-ai-prompt-too-long = AI 提示词模板过长（最多 4000 个字符）。
translation-error-ai-prompt-unknown-placeholder = AI 提示词模板包含未知占位符：只支持 {"{{"}text{"}}"}、{"{{"}sourceLang{"}}"}、{"{{"}targetLang{"}}"}（双花括号）。
translation-error-ai-prompt-missing-text = AI 提示词模板缺少 {"{{"}text{"}}"}：它是待翻译原文所在的位置。
translation-error-ai-prompt-duplicate-text = AI 提示词模板里 {"{{"}text{"}}"} 出现了多次：待翻译原文只能发送一次。
translation-error-ai-prompt-missing-source-lang = AI 提示词模板缺少 {"{{"}sourceLang{"}}"}：它是源语言名称所在的位置。
translation-error-ai-prompt-missing-target-lang = AI 提示词模板缺少 {"{{"}targetLang{"}}"}：它是目标语言名称所在的位置。
translation-error-ai-prompt-unbalanced-braces = AI 提示词模板的花括号不成对：占位符用双花括号（{"{{"}text{"}}"}），公式标记用单花括号（{"{"}v0{"}"}）。

## 翻译功能就绪判定（src/core/translation/featureReadiness.ts）
readiness-reason-engine-key = 缺少翻译引擎 API 密钥
readiness-reason-engine-url = 缺少自定义翻译接口地址
readiness-reason-engine-plugin = 未安装或未启用 zotero-pdf-translate 插件
readiness-reason-ai-prompt = AI 引擎的提示词模板不合法，请在设置面板中修正
readiness-reason-unknown = 未知原因

## 分屏菜单（src/core/pdf/splitview/splitViewFactory.ts）
splitview-menu-compare = 分屏对照（不翻译）
splitview-menu-translate = 翻译并分屏打开
splitview-menu-cancel = 取消进行中的翻译

## OpenDataLoader 流水线错误（src/core/pdf/splitview/splitViewFactory.ts）
odl-error-java-missing = 翻译需要 Java 11 或更高版本。
odl-error-jar-missing = OpenDataLoader 解析组件缺失（未找到 jar 文件），请重新安装插件。
odl-error-file-path = 文件路径无效：PDF 或 Java 路径不合法。请检查 Zotero 数据目录权限，或重启 Zotero。
odl-error-network = { $detail }
odl-error-not-configured = 未配置翻译。请在 Zotero 设置的 Z-Transplit 中选择翻译引擎并填写其配置。
odl-error-parse-empty = { $detail }

## 分屏错误与进度（splitViewFactory / readerPaneAdapter / splitViewCleanup）
splitview-error-open = 无法打开分屏：{ $detail }
splitview-error-tab-create = 分屏标签页创建失败（容器未就绪）。
splitview-error-container-timeout = 分屏容器（{ $tabID }）在 2 秒内未出现在 DOM 中。
splitview-error-reader-timeout = 阅读器未在 10 秒内完成初始化，分屏中止。
splitview-error-scroll-timeout = 分屏阅读器的滚动区域未在限定时间内就绪，页面同步不可用。
splitview-progress-reused = 已复用已有译文（附件 { $attachmentId }）

## 文献树右键菜单进度（src/modules/registerItemTreeMenu.ts）
itemtree-progress-attachment = Z-Transplit: 正在翻译全文…
itemtree-dedup-open = 检测到已有译文附件，直接打开。
itemtree-split-reuse = 检测到已有译文附件，直接分屏打开。
itemtree-open-failed = 无法自动打开译文附件，请在该条目下手动打开。

## Java 运行时安装流程（splitViewFactory / JavaRuntimeManager）
java-dialog-title = 需要安装 Java
java-dialog-body =
    需要 Java 11+ 才能使用「翻译并分屏」。

    点击「确定」自动下载安装 Java（约 40MB，解压到插件目录，无需管理员权限）；
    或点击「取消」后手动访问 https://adoptium.net 下载。
java-progress-install = 正在安装 Java 运行时…
java-progress-download-prepare = 准备下载…
java-progress-retry = ✓ Java 安装完成。请再次点击「翻译并分屏」。
java-install-failed =
    Java 安装失败：{ $detail }
    请手动从 https://adoptium.net 下载安装后重试。
java-progress-already-installed = Java 运行时已安装。
java-progress-download-start = 下载 Java { $version } JRE（{ $archive }）…
java-progress-downloading = 下载中 { $percent }%
java-error-download-failed = 下载失败：{ $detail }
java-error-download-http = 下载失败：HTTP { $status }
java-progress-extracting = 解压中…
java-progress-verifying = 验证安装…
java-error-extract-failed = 解压失败：{ $detail }
java-error-exe-not-found = 解压后未找到 java 可执行文件（在 { $dir }）。请手动从 https://adoptium.net 安装。
java-error-probe-failed = 下载的 Java 无法运行：{ $detail }
java-progress-done = Java 安装完成

## OpenDataLoader 流水线进度与错误
## （opendataloaderSplitAdapter / splitViewFactory / registerItemTreeMenu）
odl-progress-translating = Z-Transplit: OpenDataLoader 翻译中…
odl-error-dialog-title = 翻译并分屏 (OpenDataLoader)
odl-progress-preparing = 准备…
odl-progress-done-split = 完成：已分屏打开（附件 { $attachmentId }）
odl-progress-cancelled = 翻译已取消
odl-error-engine-not-ready = 翻译引擎尚未配置完成：{ $gaps }。请先在 Z-Transplit 设置中补齐后重试。
odl-progress-parsing = 正在解析 PDF 版面…
odl-error-source-path = 无法获取原文 PDF 路径。
odl-error-parse-failed = 解析失败：{ $detail }
odl-error-parse-no-pages = PDF 解析未返回任何页面（PDF 可能是空文件或扫描件）。
odl-error-parse-no-text = 解析完成但未提取到任何文本段落（PDF 可能是纯图片）。
odl-progress-formula-vlm = 正在用视觉模型提取公式（{ $count } 段）…
odl-progress-formula-novlm = 检测到 { $count } 段公式，但未配置视觉模型，公式将随正文翻译（可能不准确）。
odl-progress-font-missing = ⚠️ 未找到 { $fontFile } 或系统默认字体 — 译文将显示为问号。请将字体放入 { $assetsDir }
odl-progress-page = 正在翻译第 { $current }/{ $total } 页（{ $count } 段）…
odl-progress-overlay = 正在叠加译文到原 PDF（保留原图/表格/版式）…
odl-progress-render-white = 正在渲染译文（白底模式）…
odl-error-render-empty = 渲染阶段未产出任何页面。
odl-progress-summary = 完成：{ $pages } 页，{ $paragraphs } 段
odl-progress-summary-failed = ，{ $failed } 段翻译失败已保留原文
odl-progress-summary-nosplit = 完成：{ $pages } 页，{ $paragraphs } 段（译文已生成，但分屏打开失败）
odl-progress-opening-split = 正在打开分屏…
odl-error-no-split-opener = 分屏打开器不可用（内部错误：split 流程缺少 openSplitView）。
odl-error-reader-pdf-timeout = reader pdf.js 未在 15 秒内就绪。
odl-progress-crop-reader-missing-skip = 无法打开 reader 进行公式截图，跳过公式提取。
odl-progress-crop-reader-missing-text = 无法打开 reader 进行公式截图，公式将以文本形式处理。
odl-progress-crop-progress = 公式提取进度：{ $current }/{ $total }
odl-progress-crop-done = 公式提取完成：{ $ok } 段成功
odl-progress-crop-fallback = ，{ $count } 段回退为截图
odl-progress-crop-failed = ，{ $count } 段失败已保留原文
odl-progress-shot-progress = 公式截图进度：{ $current }/{ $total }
odl-progress-shot-done = 公式截图完成：{ $ok } 段成功
odl-progress-shot-failed = ，{ $count } 段失败

## 版式保留渲染器（LayoutPreservingRenderer.ts）
render-error-rotated-page = 暂不支持旋转页面（/Rotate { $angle }°）。请先将 PDF 转正再翻译。
