## Z-Transplit — 核心文案。
##
## 消息 id 一律不带 `ztransplit-` 前缀：构建时由 zotero-plugin-scaffold 的
## build.fluent（prefixFluentMessages，默认开启）统一加上，src/utils/locale.ts
## 也按同样规则读取。详见 en-US/ztransplit.ftl 顶部说明。
##
## 本目录的键集合必须与 en-US 完全一致——Zotero 按文件粒度选择插件 locale，
## 缺失的文件会回落到 en-US。
##
## 报错文案的统一结构：发生了什么、可能的原因、可以怎么做。原因不确定时
## 不编造；下一步必须指向一个真实存在的入口（设置项、按钮或菜单）。

## 通用标题（进度窗 headline / 对话框标题）
app-title = Z-Transplit

## 引擎错误与提示（src/core/translation/translationEngines.ts）
## 键名沿用 leadero 的 translation-error-* 命名。ai-prompt-* 同时是
## src/core/translation/promptTemplate.ts 的模板拒绝原因：每条规则一个文案，
## 运行时报错与设置面板的即时提示共用同一套措辞。
translation-error-google-empty = Google 翻译返回了空结果。可能是请求过于频繁，或该语言方向不受支持。请稍后重试或更换引擎。
translation-error-bing-empty = Bing 翻译返回了空结果。可能是请求过于频繁，或该语言方向不受支持。请稍后重试或更换引擎。
translation-error-deepl-empty = DeepL 返回了空结果。可能是请求过于频繁，或免费账户配额已用尽。请稍后重试或更换引擎。
translation-error-custom-empty = 自定义接口返回了空结果。可能是请求过于频繁，或模型的输出上限被推理过程耗尽。可在设置中调大「单次输出上限」后重试。
translation-error-google-failed = Google 翻译失败。请检查网络后重试；仍失败多为服务暂时不可用，请稍后重试或更换引擎。
translation-error-bing-failed = Bing 翻译失败。请检查网络与密钥配置后重试。
translation-error-deepl-failed = DeepL 翻译失败。请检查网络与密钥配置后重试；免费账户有配额限制。
translation-error-custom-failed = 自定义接口翻译失败。请检查接口地址、密钥与网络后重试。
translation-error-pdf-translate-failed = zotero-pdf-translate 翻译失败。请检查该插件的翻译服务设置，或改用本插件的其他引擎。
translation-error-bing-not-configured = Bing 翻译未配置 API 密钥。请在「设置 → Z-Transplit → 引擎」中填写密钥后重试。
translation-error-deepl-not-configured = DeepL 翻译未配置 API 密钥。请在「设置 → Z-Transplit → 引擎」中填写密钥后重试。
translation-error-youdao-not-configured = 有道翻译未配置应用 ID 或应用密钥。请在「设置 → Z-Transplit → 引擎」中补齐后重试。
translation-error-youdao-failed = 有道翻译失败。请检查网络后重试。
translation-error-youdao-empty = 有道翻译返回了空结果。可能是请求过于频繁，请稍后重试。
translation-error-youdao-sign-unavailable = 当前环境无法计算请求签名（缺少 WebCrypto），有道翻译不可用。请改用其他引擎。
translation-error-youdao-code-108 = 有道翻译失败：应用 ID 无效，请在智云控制台核对
translation-error-youdao-code-110 = 有道翻译失败：该应用未开通文本翻译服务，请在控制台开通后重试
translation-error-youdao-code-202 = 有道翻译失败：签名校验失败，请核对应用密钥
translation-error-youdao-code-206 = 有道翻译失败：时间戳无效，请检查系统时间
translation-error-youdao-code-other = 有道翻译失败（错误码 { $code }）。请到有道智云控制台核对应用配置、余额与服务状态。
translation-error-youdao-rate-limited = 有道翻译失败：接口限流，请求过于频繁（错误码 { $code }）。已等待并重试仍被拒绝，请稍后再试；翻译长文档建议在设置中改用「有道翻译」（官方接口）或其他引擎
translation-error-custom-url-missing = 自定义翻译接口地址未配置。请在「设置 → Z-Transplit → 引擎」中填写接口地址。
translation-error-unknown = 发生未知错误。请开启调试输出后复现一次，并把日志反馈给开发者。
translation-error-bing-token-unavailable = 无法获取 Bing 翻译令牌（页面结构可能已变化）。可暂时改用「有道翻译（免密钥）」，并等待插件更新。
translation-error-bing-rejected = Bing 拒绝了请求（{ $status }）。多为请求过于频繁或令牌失效，请稍后重试；频繁出现请更换引擎。
translation-error-pdf-translate-missing = 未安装或未启用 zotero-pdf-translate 插件。请在 Zotero 的插件管理器中安装并启用，或改用本插件的其他引擎。
translation-error-ai-empty = AI 翻译返回了空结果。可能是模型的输出上限被推理过程耗尽，可在设置中调大「单次输出上限」后重试。
translation-error-ai-failed = AI 翻译失败。请检查接口地址、密钥与网络后重试。
translation-error-ai-url-missing = AI 翻译接口地址未配置。请在「设置 → Z-Transplit → 引擎」中选择服务商或填写地址。
translation-error-ai-bad-response = AI 引擎返回的内容不符合约定格式。请重试；反复失败时请更换模型，或核对服务商的接口文档。
translation-error-rate-limited = 翻译服务触发限流：已按服务器指示等待并重试一次，仍被拒绝。请稍后再试，或降低批量翻译的并发规模。
translation-error-rate-limited-wait-too-long = 翻译服务触发限流：服务器要求等待过久（超过 120 秒），已放弃本次请求。请稍后再试，或降低批量翻译的并发规模。

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
readiness-reason-ai-url = 缺少 AI 翻译接口地址（在设置里选一个服务商即可自动填好）
readiness-reason-engine-plugin = 未安装或未启用 zotero-pdf-translate 插件
readiness-reason-ai-prompt = AI 引擎的提示词模板不合法，请在设置面板中修正
readiness-reason-unknown = 未知原因

## 分屏菜单（src/core/pdf/splitview/splitViewFactory.ts）
splitview-menu-root = Z-Transplit
splitview-menu-compare = 分屏阅读
splitview-menu-translate = 分屏翻译
splitview-menu-interleave = 上下翻译
splitview-menu-trans-only = 仅译文
splitview-menu-cancel = 取消进行中的翻译

## OpenDataLoader 流水线错误（src/core/pdf/splitview/splitViewFactory.ts）
odl-error-java-missing = 翻译需要 Java 11 或更高版本。可在「设置 → Z-Transplit → PDF 分屏翻译」中点 Java 运行库的「安装 / 修复…」自动安装，无需管理员权限。
odl-error-jar-missing = 未找到解析组件。请在「设置 → Z-Transplit → PDF 分屏翻译」中点解析组件的「下载 / 修复…」重新获取；文件反复消失时请检查杀毒软件的隔离记录。
odl-error-jar-unreadable = 解析组件无法读取（Java 打不开解析组件文件）。请稍后重试一次；仍失败请重启 Zotero 后再试。
odl-error-jar-unreadable-path = 解析组件无法读取（Java 打不开该文件）：{ $path }。请稍后重试一次；仍失败且路径含表情符号等特殊字符时，请把 Zotero 数据目录移到不含特殊字符的位置。
odl-error-jar-corrupt = 解析组件文件已损坏（下载不完整或被改写）。请在设置中点解析组件的「下载 / 修复…」重新获取后重试。
odl-error-jar-download-failed = 解析组件自动下载失败。请检查网络后，在设置中点解析组件的「下载 / 修复…」重试；若反复失败，可改用内置解析组件的完整版安装包。
odl-error-parse-timeout = PDF 解析超时。文档较长或机器较慢时会在这一步超时：可在设置中调大「解析超时」，或用「翻译指定页」分批翻译。
odl-error-parse-disabled = PDF 解析已在设置中关闭。请到「设置 → Z-Transplit → PDF 分屏翻译」开启「启用 OpenDataLoader 解析」后重试。
odl-jar-download-window = 正在下载 OpenDataLoader 解析组件
odl-jar-download-probe = 正在测试可用镜像…
odl-jar-download-downloading = 正在下载（{ $percent }%）
odl-jar-download-verifying = 校验并安装…
odl-jar-download-done = ✓ 解析组件已就绪
err-jar-load = 无法读取解析组件 jar 文件（路径非法）：{ $path }（{ $message }）
odl-error-file-path = 文件路径无效，无法启动解析。请确认 PDF 与 Zotero 数据目录所在路径不含特殊字符，且目录有读写权限。
odl-error-network = 网络错误：请检查网络连接与代理设置后重试。（{ $detail }）
odl-error-not-configured = 未配置翻译。请在「设置 → Z-Transplit → 引擎」中选择翻译引擎并填写其配置。
odl-error-parse-empty = { $detail }
odl-error-http-auth = 翻译服务拒绝了请求（HTTP { $code }）：API 密钥无效或没有访问权限，请检查 Z-Transplit 设置中的密钥。
odl-error-http-rate = 翻译服务繁忙或配额不足（HTTP { $code }），请稍后重试。
odl-error-http-other = 翻译服务返回错误（HTTP { $code }）：{ $detail }

## 分屏错误与进度（splitViewFactory / readerPaneAdapter / splitViewCleanup）
splitview-error-dialog-title = 分屏对照 (Z-Transplit)
splitview-error-open = 无法打开分屏：{ $detail }。请重新打开这篇 PDF 后重试；仍失败请重启 Zotero。
splitview-error-tab-create = 分屏标签页创建失败（容器未就绪）。请重试；仍失败请重启 Zotero。
splitview-error-container-timeout = 分屏标签页未在 2 秒内就绪。机器繁忙时会出现，请重试；仍失败请重启 Zotero。
splitview-error-reader-timeout = 阅读器未在 10 秒内完成初始化，分屏中止。机器繁忙时会出现，请重试；仍失败请重启 Zotero。
splitview-error-scroll-timeout = 分屏阅读器的滚动区域未在限定时间内就绪，页面同步不可用。请重试；仍失败请重启 Zotero。
splitview-error-no-item = 无法确定当前阅读器对应的 PDF 附件，请重新打开该文献后重试。
splitview-error-in-flight = 已有翻译正在进行，可在阅读器右键菜单选择「取消进行中的翻译」。
splitview-progress-reused = 已复用已有译文「{ $title }」
splitview-tab-title = { $left } | { $right }

## 文献树右键菜单进度（src/modules/registerItemTreeMenu.ts）
itemtree-progress-attachment = Z-Transplit: 正在翻译全文…
itemtree-dedup-open = 检测到已有译文附件，直接打开。
itemtree-split-reuse = 检测到已有译文附件，直接分屏打开。
itemtree-open-failed = 无法自动打开译文附件，请在该条目下手动打开。
itemtree-interleave = 上下翻译
itemtree-trans-only = 仅译文
itemtree-launch-progress = Z-Transplit: 正在准备双语阅读…
itemtree-launch-done = 双语阅读已就绪
itemtree-launch-no-reader = 无法确定当前阅读器，请重新打开该 PDF 后重试。
itemtree-pages-prompt-title = 翻译指定页
itemtree-pages-prompt-text = 输入要翻译的页码，例如 1-3,7。范围外的页面在译文里保持原样。
itemtree-pages-invalid = 页码格式不合法：请输入页码或范围，例如 1-3,7。
odl-error-page-range = 页码超出范围：这份文档共 { $count } 页。

## 译文附件（src/core/pdf/translation/translatedAttachment.ts）
translated-tag = 译文

## Java 运行时安装流程（splitViewFactory / JavaRuntimeManager）
java-dialog-title = 需要安装 Java
java-dialog-body =
    需要 Java 11+ 才能使用「翻译并分屏」。

    「自动下载安装」：下载约 40MB 的 Java 运行时并解压到插件数据目录，无需管理员权限；
    「打开下载页」：在浏览器中打开 https://adoptium.net，由你手动下载安装；
    「取消」：本次不做任何处理。
java-dialog-button-download = 自动下载安装(&D)
java-dialog-button-openpage = 打开下载页(&O)
java-dialog-button-cancel = 取消
java-progress-install = 正在安装 Java 运行时…
java-progress-download-prepare = 准备下载…
java-progress-retry = ✓ Java 安装完成。请再次点击「翻译并分屏」。
java-install-failed =
    Java 安装失败：{ $detail }
    请检查网络后在设置中重试「安装 / 修复…」，或手动从 https://adoptium.net 下载安装。
java-progress-already-installed = Java 运行时已安装。
java-progress-self-heal = 检测到已损坏的 Java 运行环境，正在自动重新安装…
java-progress-download-start = 下载 Java { $version } JRE（{ $archive }）…
java-progress-probe = 正在选择下载源…
err-java-not-found = 未找到可用的 Java 运行库。请在「设置 → Z-Transplit → PDF 分屏翻译」中点 Java 运行库的「安装 / 修复…」自动安装便携版（无需管理员权限），或自行安装 Java 11 或更高版本。
java-progress-downloading = 下载中 { $percent }%
java-progress-reuse-archive = 已有下载完成的安装包（校验通过），跳过下载…
java-error-download-failed = 下载失败：{ $detail }。请检查网络与代理设置后重试。
java-error-checksum-mismatch = 安装包校验失败（SHA-256 不匹配），已丢弃。可能是下载不完整或网络异常，请重试。
java-progress-extracting = 解压中…
java-progress-verifying = 验证安装…
java-error-extract-failed = 解压失败：{ $detail }。请确认磁盘空间充足、数据目录可写入，且安全软件未拦截解压，然后重试。
java-error-exe-not-found = 解压后未找到 java 可执行文件（在 { $dir }）。请手动从 https://adoptium.net 安装。

## AI 引擎「测试连接」的结果分类（src/core/ai/connectionTest.ts）
ai-test-ok = 连接成功：模型 { $model } 有应答（{ $ms } 毫秒）。
ai-test-auth = 密钥被拒绝（401/403）。请检查 API 密钥是否填写正确；本地服务商（Ollama 等）可留空。确认无误时请到服务商控制台查看账户状态。详情：{ $detail }
ai-test-not-found = 接口地址不存在（404）。请确认服务商选择是否正确、地址是否抄错，以及末尾是否需要带 /v1。详情：{ $detail }
ai-test-rate-limit = 被限流（429），请稍后重试；反复出现请到服务商控制台查看配额与余额。详情：{ $detail }
ai-test-network = 连不上该端点：{ $detail }。该地址可能不可达，或需要代理。
ai-test-timeout = 连接超时（{ $ms } 毫秒）。端点不可达，或需要代理。
ai-test-http = 服务端返回错误（HTTP { $status }）：{ $detail }。400 多为参数不受支持；500 与 503 为服务端故障，请稍后重试。
ai-test-empty = 端点连通，但模型没有返回任何内容。可换一个模型名再试，或在设置中调大「单次输出上限」。
ai-test-invalid = 请先填写接口地址，再测试。
ai-test-server-default = 服务端默认
java-error-probe-failed = 下载的 Java 无法运行：{ $detail }。可能被安全软件拦截或解压不完整，请重试「安装 / 修复…」；仍失败请从 https://adoptium.net 手动安装。
java-progress-done = Java 安装完成

## OpenDataLoader 流水线进度与错误
## （opendataloaderSplitAdapter / splitViewFactory / registerItemTreeMenu）
odl-progress-translating = Z-Transplit: 正在翻译全文…
odl-error-dialog-title = 翻译并分屏 (OpenDataLoader)
odl-progress-preparing = 准备…
odl-progress-done-split = 完成：已分屏打开「{ $title }」
odl-progress-cancelled = 翻译已取消
odl-error-engine-not-ready = 翻译引擎尚未配置完成：{ $gaps }。请先到「设置 → Z-Transplit → 引擎」补齐后重试。
odl-progress-parsing = 正在解析 PDF 版面…
odl-error-source-path = 无法获取原文 PDF 的路径。附件文件可能已被移动、删除或尚未下载，请在 Zotero 中确认该附件能正常打开。
odl-error-parse-failed = PDF 解析失败：{ $detail }。请重试；反复失败时先在设置中点解析组件的「下载 / 修复…」，仍失败请查看调试输出并反馈。
odl-error-parse-no-pages = PDF 解析未返回任何页面：文件可能是空文件、已损坏或已加密，也可能是纯扫描件。
odl-error-parse-no-text = 解析完成但未提取到任何文本段落。这份 PDF 可能是纯图片扫描件：可在设置中开启「识别扫描页」并安装识别环境；确认不是扫描件时，请检查文件是否损坏。
odl-progress-formula-vlm = 正在用视觉模型提取公式（{ $count } 段）…
odl-progress-formula-novlm = 检测到 { $count } 段公式，但未配置视觉模型，公式将随正文翻译（可能不准确）。可在设置中配置 OpenAI 兼容接口后重新翻译。
odl-progress-font-missing = ⚠️ 未找到 { $fontFile } 或系统默认字体 — 译文将显示为问号。请将字体放入 { $assetsDir }
odl-progress-page = 正在翻译第 { $current }/{ $total } 页（{ $count } 段）…
odl-progress-overlay = 正在叠加译文到原 PDF（保留原图/表格/版式）…
odl-progress-remove-original = 正在删除已翻译段落的原文…
odl-progress-remove-original-ineffective = 原文无法从页面内容流中删除，改用遮罩覆盖。
odl-progress-merging = 检测到已有译文附件，正在把本次译文并入…
odl-progress-merged = 已并入已有译文：本次新译 { $count } 页已替换对应页面。已打开的分屏重新打开后可见新内容。
odl-progress-render-white = 正在渲染译文（白底模式）…
odl-error-render-empty = 渲染阶段未产出任何页面。请重试；仍失败请重启 Zotero 后再试，问题持续时请查看调试输出并反馈。
odl-progress-summary = 完成：{ $pages } 页，{ $paragraphs } 段
odl-progress-summary-failed = ，{ $failed } 段翻译失败已保留原文（多为网络或引擎问题，重新翻译可重试这些段落）
odl-progress-summary-nosplit = 完成：{ $pages } 页，{ $paragraphs } 段（译文已生成，但分屏打开失败）
odl-progress-opening-split = 正在打开分屏…
odl-error-no-split-opener = 译文已生成，但分屏组件不可用（内部错误）。译文附件已保存，可直接打开；请把此问题反馈给开发者。
odl-progress-crop-reader-missing-skip = 无法打开 reader 进行公式截图，跳过公式提取。
odl-progress-crop-reader-missing-text = 无法打开 reader 进行公式截图，公式将以文本形式处理。
odl-progress-crop-progress = 公式提取进度：{ $current }/{ $total }
odl-progress-crop-done = 公式提取完成：{ $ok } 段成功
odl-progress-crop-failed = ，{ $count } 段失败已保留原文
odl-progress-shot-progress = 公式截图进度：{ $current }/{ $total }
odl-progress-shot-done = 公式截图完成：{ $ok } 段成功
odl-progress-shot-failed = ，{ $count } 段失败

## 扫描页识别管线（src/core/pdf/scan/**）
scan-progress-start = 正在识别扫描页（共 { $pages } 页）…
scan-progress-resumed = 沿用上次已识别的 { $pages } 页，只认剩余的页…
scan-progress-batch = 已识别 { $done }/{ $total } 批
scan-progress-retry = 第 { $batch } 批有 { $pages } 页内容偏少，提高分辨率重试…
scan-progress-summary = 扫描识别完成：{ $recognized } 页有内容，{ $empty } 页无内容，{ $skipped } 页跳过
scan-progress-summary-resumed = （其中 { $resumed } 页沿用上次结果）
scan-progress-summary-suspect = ，{ $suspect } 页内容仍偏少（已保留识别结果）
scan-error-sidecar-unconfigured = 检测到需要识别的扫描页，但识别环境尚未安装。请在设置中点「一键安装识别环境」，装好后这些页随下次翻译自动识别；本次翻译中它们保持原文。
scan-error-sidecar-failed = 识别环境已安装，但这次识别没有产出结果。请重新翻译以重试；反复失败时请查看调试输出，或在设置中点「修复（重装）…」重建识别环境。
scan-error-disabled = 扫描页识别已在设置中关闭，这些页保持原文。需要识别时请在设置中开启「识别扫描页」。
scan-error-rotated-skipped = 扫描页含旋转页面，已跳过识别并保持原文。如需识别，请先把页面转正另存，再重新翻译。

## 识别侧车的 Python 运行时分发（src/core/pdf/scan/pythonRuntime.ts）
py-progress-window = 正在安装识别运行时
py-progress-checksum = 正在获取构件校验清单…
py-progress-probing = 正在探测可用镜像…
py-progress-downloading = 正在下载运行时（{ $percent }%）
py-progress-verifying = 正在核对构件指纹…
py-progress-extracting = 正在解压并探活…
py-progress-done = 识别运行时安装完成
py-status-not-installed = 未安装
py-error-install-failed = 识别运行时安装失败，请检查网络后重试。反复失败时请确认磁盘空间充足，并点「安装 / 修复…」重试。
py-error-unsupported-platform = 当前平台没有可用的识别运行时构件。可按开发文档手动配置「识别侧车命令」。
py-error-manifest-unavailable = 运行时清单缺失或损坏，请重新安装插件
py-error-checksum-unavailable = 校验清单里没有本平台的构件，安装已中止。请更新插件或改用完整版安装包；问题持续请反馈给开发者。

## 识别环境一键安装（src/core/pdf/scan/sidecarEnv.ts）
sidecar-progress-window = 正在安装扫描识别环境
sidecar-progress-runtime = 正在安装 Python 运行时…
sidecar-progress-script = 正在部署识别脚本…
sidecar-progress-dependencies = 正在安装识别依赖（首次约几百 MB，可能持续几分钟到十几分钟）…
sidecar-progress-selftest = 正在构建识别引擎并自检（首次运行需下载模型权重）…
sidecar-progress-done = 识别环境安装完成，命令已自动填好
sidecar-status-deps-missing = 未安装识别依赖。请点「一键安装识别环境」。
sidecar-status-command-missing = 依赖已装好，但「识别侧车命令」尚未填好。请点「一键安装识别环境」，命令会自动填好。
sidecar-error-bundle-missing = 安装包里缺少 { $file }，请重新安装插件
sidecar-error-no-mirror = 所有 Python 软件源均不可达，请检查网络后重试
sidecar-error-pip = 识别依赖安装失败：{ $detail }。请检查网络与代理；反复失败时请确认磁盘空间，并点「修复（重装）…」重试。
sidecar-error-selftest = 识别引擎自检未通过：{ $detail }。可能内存不足或本机不兼容，可重试一次；仍失败请把此信息反馈给开发者。
sidecar-error-timeout = 识别环境安装等待超过 { $minutes } 分钟仍未结束。多为网络较慢或模型下载受限，请检查网络后重试。
sidecar-error-pref-write = 识别环境装好了，但命令写入设置失败。请在「识别侧车命令」一栏手动填写：{ $command }

## 阅读器会话（src/core/pdf/scan/readerAccess.ts）
err-reader-pdf-timeout = 阅读器的 pdf.js 未在 15 秒内就绪。

## 版式保留渲染器（LayoutPreservingRenderer.ts）

## 词典卡片查询链（src/core/translation/dictionaryCard.ts）
dictionary-error-all-failed = 词典查询失败：词典与可用的翻译引擎都没有返回结果（{ $error }）。请检查网络与引擎配置后重试。
dictionary-error-unavailable = 词典查询暂不可用，请重试。
