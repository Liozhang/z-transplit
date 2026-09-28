## Z-Transplit — 设置面板文案（编辑 → 设置 → Z-Transplit）。
##
## 消息 id 以 `preferences-ztransplit-` 开头，与 Zotero 原生设置面板的
## `preferences-*` 命名习惯保持一致，同时避免与 Zotero 自己的
## `preferences-*` 消息 id 撞名（插件的 FTL 会与 Zotero 的消息一起进入同一个
## Fluent 注册表，见 Zotero.Plugins#registerLocales）。
##
## id 不带 `ztransplit-` 前缀：构建时由 zotero-plugin-scaffold 的
## build.fluent（prefixFluentMessages，默认开启）统一加上，src/utils/locale.ts
## 也按同样规则读取。详见 en-US/ztransplit.ftl 顶部说明。
##
## 约定：
##   - `<description>` 与 `<html:h2>` 小节标题用普通消息值（Fluent 会写入文本
##     内容）；
##   - XUL `<label>` 只渲染 value 属性、不渲染文本内容，消息必须写 `.value`；
##     preferences.xhtml 里的静态 value 保留，作为 Fluent 失效时的兜底；
##   - `<checkbox>` / `<button>` / `<menuitem>` 必须写 `.label`（XUL 元素只认
##     label 属性，文本内容不会显示）；
##   - 每个可调设置都配一条 `-desc` 说明，讲清作用、留空后果与默认行为。
##
## 本目录的键集合必须与 en-US 完全一致——Zotero 按文件粒度选择插件 locale，
## 缺失的文件会回落到 en-US。

## 分区标题
preferences-ztransplit-general = 常规
preferences-ztransplit-engine = 翻译引擎
preferences-ztransplit-pdf = PDF 分屏翻译

## 面板简介（Zotero 会在标题下方自动渲染）
preferences-ztransplit-intro = 文本翻译引擎与 PDF 分屏翻译所需的运行环境都在这里配置。

## ── 常规 ───────────────────────────────────────────────────────────────────
preferences-ztransplit-translate-enabled =
    .label = 启用文本翻译
preferences-ztransplit-translate-enabled-desc =
    开启后，条目面板和阅读器中才会出现翻译入口。关闭时翻译按钮和自动翻译
    都会停用，但已经填写的引擎密钥等设置会保留，随时可以重新开启。

preferences-ztransplit-translate-auto =
    .label = 打开条目时自动翻译
preferences-ztransplit-translate-auto-desc =
    打开阅读器条目或选中文本时立即翻译，不需要再点「翻译」按钮。需要先开启
    上面的「启用文本翻译」。自动翻译会按下面的字符上限分段请求，打开长文档时
    会产生较多网络请求。

preferences-ztransplit-translate-max-chars =
    .value = 单次请求最大字符数
preferences-ztransplit-translate-max-chars-desc =
    每次提交给翻译引擎的字符上限，可填 100–50000，默认 10000。超出上限的文本
    会自动分段，所以调大只是减少分段次数、增大单次请求体积；调小更保守，但
    分段更多，更容易在分段处产生语义断裂。填错或留空时会继续使用上一次的
    合法值，不会改写设置。
preferences-ztransplit-translate-max-chars-range = 请输入 100 到 50000 之间的整数。

## ── 翻译引擎 ───────────────────────────────────────────────────────────────
preferences-ztransplit-engine-type =
    .value = 引擎
preferences-ztransplit-engine-type-desc =
    选择文本翻译使用的引擎。切换引擎不会清除其它引擎已经填写的密钥，随时可以
    切回；只有当前选中的引擎会被使用。

preferences-ztransplit-engine-google =
    .label = Google 翻译
preferences-ztransplit-engine-bing =
    .label = Bing 翻译
preferences-ztransplit-engine-deepl =
    .label = DeepL
preferences-ztransplit-engine-custom =
    .label = 自定义接口（OpenAI 兼容）
preferences-ztransplit-engine-zotero-pdf-translate =
    .label = zotero-pdf-translate 插件
preferences-ztransplit-engine-zotero-pdf-translate-missing = zotero-pdf-translate 插件（未安装）

## 密钥输入框旁的「显示密钥」复选框（勾选后临时以明文显示，不写入任何设置）
preferences-ztransplit-show-key =
    .label = 显示密钥
    .tooltiptext = 勾选后临时以明文显示密钥，方便核对粘贴结果；只影响当前输入框，不会写入任何设置。

## Google
preferences-ztransplit-google-api-key =
    .value = Google API 密钥
preferences-ztransplit-google-api-key-desc =
    可以留空。留空时使用免密钥的免费端点，失败后会自动改用免密钥的 Bing 网页
    接口兜底；填写密钥后改走官方接口，配额和稳定性更好。密钥无效不会弹出提示，
    只会表现为翻译失败，因此留空通常是更省心的选择。

## Bing
preferences-ztransplit-bing-api-key =
    .value = Bing API 密钥
preferences-ztransplit-bing-api-key-desc =
    必填。Microsoft 翻译器 REST API 的密钥，可在 Azure 门户的「翻译器」资源中
    申请。未填写时 Bing 翻译会直接失败。
preferences-ztransplit-bing-region =
    .value = 区域
preferences-ztransplit-bing-region-desc =
    可留空。多区域资源（如 chinaeast2）要与申请时保持一致，全球资源填 global
    即可。填错会返回鉴权错误。

## DeepL
preferences-ztransplit-deepl-api-key =
    .value = DeepL API 密钥
preferences-ztransplit-deepl-api-key-desc =
    必填。DeepL API 的认证密钥，未填写时 DeepL 翻译会直接失败。
preferences-ztransplit-deepl-use-free =
    .label = 使用 DeepL 免费接口
preferences-ztransplit-deepl-use-free-desc =
    免费密钥（密钥以 :fx 结尾）必须开启；Pro 密钥请关闭。选错会返回 401/403
    鉴权错误。

## 自定义（OpenAI 兼容）
preferences-ztransplit-custom-api-url =
    .value = 接口地址
preferences-ztransplit-custom-api-url-desc =
    必填。OpenAI 兼容的 chat/completions 地址，例如
    https://api.example.com/v1/chat/completions。留空时翻译会失败。
preferences-ztransplit-custom-api-key =
    .value = API 密钥
preferences-ztransplit-custom-api-key-desc =
    必填。该服务的密钥，通常作为 Authorization: Bearer <密钥> 发送。留空时
    翻译会失败。
preferences-ztransplit-custom-model =
    .value = 模型
preferences-ztransplit-custom-model-desc =
    可留空。要调用的模型名，例如 gpt-4o-mini。留空时由服务端使用默认模型，
    翻译质量不受保证。

## zotero-pdf-translate
preferences-ztransplit-pdftranslate-installed =
    已检测到 zotero-pdf-translate 插件，文本翻译请求会转交给它处理。
preferences-ztransplit-pdftranslate-missing =
    未检测到 zotero-pdf-translate 插件。请在 Zotero 的「工具 → 插件」中
    安装并启用它，否则选择该引擎时翻译会失败。

## ── PDF 分屏翻译 ───────────────────────────────────────────────────────────
preferences-ztransplit-pdf-java-title =
    .value = Java 运行库
preferences-ztransplit-pdf-java-desc =
    保留排版的 PDF 翻译需要 Java 11 或更高版本来解析 PDF 内容。没有安装 Java
    时该功能不可用：在阅读器中右键点击 PDF，选择「翻译并分屏」时会自动检测，
    未检测到会弹窗引导下载安装便携版 Java（约 40MB，解压到数据目录，无需
    管理员权限），安装完成后再次点击该菜单即可。

preferences-ztransplit-pdf-fonts-title =
    .value = 字体覆盖目录
preferences-ztransplit-pdf-fonts-desc =
    把自定义字体文件（.ttf / .otf / .ttc）放进下面的目录，即可覆盖 PDF 翻译
    使用的默认字体，用来改善中文等非拉丁文字的显示效果。目录不存在时会自动
    创建，放入的字体在下次翻译时生效。
preferences-ztransplit-pdf-fonts-path =
    .value = 字体目录

preferences-ztransplit-pdf-lang-title =
    .value = 译文语言
preferences-ztransplit-pdf-lang =
    .value = 目标语言
preferences-ztransplit-pdf-lang-desc =
    PDF 分屏翻译的目标语言；Zotero 10 双语对照视图与朗读译文也使用它作为
    默认目标语言。填写 BCP-47 语言码，如 zh-CN、en-US、ja-JP。留空时跟随
    Zotero 的界面语言（默认行为）。阅读器条目面板的文本翻译使用自己的
    目标语言框，与此处互不影响。

## OpenDataLoader 解析选项（addon/prefs.js 的 pdfParser.opendataloader.*）
preferences-ztransplit-pdf-odl-title =
    .value = OpenDataLoader 解析选项
preferences-ztransplit-pdf-odl-desc =
    以下选项控制本地 Java 解析组件的行为，影响「翻译并分屏」的版面解析质量
    与耗时。除超时外，改动都在下次翻译时生效。
preferences-ztransplit-pdf-odl-enabled =
    .label = 启用 OpenDataLoader 解析
preferences-ztransplit-pdf-odl-enabled-desc =
    OpenDataLoader 是「翻译并分屏」唯一使用的版面解析后端。关闭后翻译并分屏
    会直接失败并提示回到这里开启；除非它在你的系统上确实无法运行，否则应保持
    开启。
preferences-ztransplit-pdf-odl-table =
    .value = 表格识别
preferences-ztransplit-pdf-odl-table-default =
    .label = 默认（按边框识别）
preferences-ztransplit-pdf-odl-table-cluster =
    .label = 聚类（无边框表格）
preferences-ztransplit-pdf-odl-table-desc =
    表格识别方法。「默认」按表格线切分，适合有线框的表格；「聚类」按文本块
    聚类，适合无边框表格，但耗时更长、误判率略高。
preferences-ztransplit-pdf-odl-structtree =
    .label = 使用结构树判定阅读顺序
preferences-ztransplit-pdf-odl-structtree-desc =
    PDF 自带结构树（StructTree）时按它判定阅读顺序，多栏排版更准确；没有
    结构树的 PDF 不受影响，但解析会稍慢。
preferences-ztransplit-pdf-odl-timeout =
    .value = 解析超时（秒）
preferences-ztransplit-pdf-odl-timeout-desc =
    单次版面解析的最长等待时间，可填 30–3600 秒，默认 300。大文档或慢磁盘上
    解析超时会表现为翻译失败，调大之前请先确认不是 Java 未安装。填错或留空时
    会继续使用上一次的合法值，不会改写设置。
preferences-ztransplit-pdf-odl-timeout-range = 请输入 30 到 3600 之间的整数。
preferences-ztransplit-pdf-odl-images =
    .label = 返回嵌入图像
preferences-ztransplit-pdf-odl-images-desc =
    让解析器输出页面内嵌图像，翻译后随译文贴回原位置，图表更完整；关闭后只
    翻译文字，图像区域留白，解析更快、生成的文件更小。
