# Z-Transplit

**Z-Transplit** 是一个 Zotero 7 / 10 插件，围绕「读外文文献」提供一整套翻译能力：划词翻译、PDF 保排版全文翻译、分屏对照、上下对照双语阅读、仅译文阅读，并内置翻译缓存与朗读。

界面全部使用 Zotero 原生 XUL/HTML 构建，不引入 React / iframe 桥。

## 翻译模式

### 划词翻译

在阅读器中选中任意文本，右侧面板给出源文本与译文，可一键复制；支持自动检测源语言、目标语言切换，并可对译文直接朗读。

![划词翻译](docs/screenshots/selection-translate.png)

### 全文翻译（生成译文附件）

在文献列表右键 PDF →「翻译全文（生成译文附件）」。OpenDataLoader（本地 JVM）解析版面 → 逐段翻译 → 按原版式重排渲染，产物作为「译文 (zh-CN)」附件入库并自动打开，重复翻译自动去重。

![全文翻译附件](docs/screenshots/translated-attachment.png)

### 分屏对照

右键 →「翻译并分屏对照」：同一个标签页内左右两个阅读器并排，左侧原文、右侧译文，滚动与翻页同步，适合逐段精读。

![分屏对照](docs/screenshots/split-view.png)

### 上下对照双语阅读（Zotero 10）

在阅读器右侧栏开启「双语对照」：Zotero 10 的 SDT 阅读模式把 PDF 重排为结构化文本，每段原文下方插入译文块；视口懒翻译，滚到哪译到哪。

![上下对照双语](docs/screenshots/bilingual-interleave.png)

### 仅译文模式

同一双语会话内切换到「仅译文」：隐藏原文块，只保留译文，适合通读全文。

![仅译文](docs/screenshots/translation-only.png)

> 双语对照 / 仅译文依赖 Zotero 10 的阅读模式；在 Zotero 7 上会明确提示降级，其余功能（划词、全文翻译、分屏、朗读）在 7 与 10 上均可用。

## 翻译引擎

设置面板中可切换，均支持跨会话的内容寻址翻译缓存（F0）：

| 引擎 | 密钥 | 说明 |
| --- | --- | --- |
| Google | 可留空 | 免费端点，失败自动切 Bing 网页接口兜底 |
| Bing | 必填 | Azure 翻译器 REST API |
| DeepL | 必填 | free / pro 端点可选 |
| AI 翻译 | 接口地址必填，密钥可留空 | OpenAI 兼容 chat/completions，提示词模板可自定义 |
| 自定义接口 | 必填 | OpenAI 兼容 chat/completions |
| zotero-pdf-translate | — | 检测到该插件时可直接转交 |

### AI 翻译的提示词模板

AI 引擎把「发给模型什么」交给用户：翻译提示词是一个可编辑模板，插件负责语言配置与模板校验。

![AI 翻译引擎设置](docs/screenshots/ai-engine.png)

- 模板必须包含三个占位符：`{{text}}`（待翻译原文）、`{{sourceLang}}`（源语言名称）、`{{targetLang}}`（目标语言名称）。占位符用双花括号，因为 `{v0}`、`{v1}` 这种单花括号标记在流水线里代表公式位置，默认模板会要求模型原样保留它们。
- 语言名称由插件按语言码解析成可读名称（`zh-CN` → Simplified Chinese），不直接发送语言码。
- 模板在设置面板里即时校验：占位符拼错、缺失、重复、花括号不成对、超长都会就地提示具体原因，非法值不会写入设置；已存的非法模板会被就绪检查拦下并指回设置面板。留空即恢复内置默认模板。
- 缓存按模板指纹失效：改一个字的模板就会重新翻译，不会读到旧提示词的结果。
- 按段请求（不走批量 JSON），与其它模型后端（自建 Ollama、vLLM、网关等）的行为一致。

## 朗读

双语会话与划词面板均支持朗读（Windows SAPI / 系统 TTS），句级高亮跟随播放进度：朗读原文走 PDF 文本层定位，朗读译文走双语译文块。

---

## 构建

```bash
npm install          # 安装依赖
npm run dev          # 启动 Zotero 并热重载（zotero-plugin serve）
npm run build        # 类型检查 + 打包到 .scaffold/build
npm run test:unit    # vitest（tests/unit + tests/node，Node 环境）
```

要求 Node.js ≥ 22.8（`zotero-plugin-scaffold@0.8` 的 engines 约束）。

## 目录导览

| 路径 | 说明 |
| --- | --- |
| `addon/` | 插件静态资源：`manifest.json`、`bootstrap.js`、`prefs.js`、`locale/`。构建时按原样复制。 |
| `addon/content/scripts/ztransplit.js` | 打包产物（`src/index.ts` 的 esbuild 输出），由 `npm run build` 生成，不入库。 |
| `src/` | 插件源码。入口 `src/index.ts`，生命周期 `src/hooks.ts`，公共工具 `src/utils/`。 |
| `src/modules/` | UI 注册类模块（阅读器面板、设置界面、分屏视图），由 `hooks.onStartup` 动态加载。 |
| `src/core/` | 业务内核：翻译引擎适配、PDF 保排版流水线。 |
| `src/core/pdf/lib/` | 运行期 jar（PDF 解析后端）存放处，来源见同目录 `PROVENANCE.json`。 |
| `tests/unit/` | vitest 单元测试（纯 Node）。 |
| `tests/node/` | vitest Node-only 测试（可用 `node:fs`、真实 fixture）。 |
| `tests/zotero/` | 需在真实 Zotero 内运行的 mocha 测试（`zotero-plugin test`），**不要**被 vitest 收录。 |
| `typings/` | 全局声明：`global.d.ts` 手写（`_globalThis` / `addon` / `__env__` 等 bundle 注入的全局）；`i10n.d.ts`、`prefs.d.ts` 由 `npm run build` 从 FTL 与 `addon/prefs.js` 自动生成。 |
| `zotero-plugin.config.ts` | scaffold 构建配置（入口、banner、prefs 前缀、assets）。 |
| `tsconfig.json` | 主包（Zotero sandbox）类型配置；`tsconfig.node.json` 覆盖 Node 侧（tests、config 文件）。 |

## 偏好设置

默认值声明在 `addon/prefs.js`，键名统一带 `extensions.zotero.ztransplit.` 前缀，
在代码里通过 `src/utils/prefs.ts` 的 `getPref` / `getPrefDynamic` 读取。

## License

MIT，见 [LICENSE](./LICENSE)。

---

# Z-Transplit (English)

**Z-Transplit** is a Zotero 7 / 10 plugin offering a full translation toolkit for reading foreign-language literature: selection translation, layout-preserving full-text PDF translation, side-by-side split reading, interleaved bilingual reading, translation-only reading, plus a persistent translation cache and read-aloud.

All UI is built with Zotero's native XUL/HTML. No React, no iframe bridge.

## Translation Modes

### Selection Translate

Select any text in the reader — the side panel shows source and translation with one-click copy, automatic source-language detection, a target-language switcher, and read-aloud of the result.

![Selection translate](docs/screenshots/selection-translate.png)

### Full-text Translation (translated attachment)

Right-click a PDF in the library → "翻译全文（生成译文附件）". OpenDataLoader (local JVM) parses the layout, paragraphs are translated, and the result is re-rendered preserving the original layout, stored as a "译文 (zh-CN)" attachment and opened automatically. Repeat runs are deduplicated.

![Translated attachment](docs/screenshots/translated-attachment.png)

### Split-screen Reading

Right-click → "翻译并分屏对照": one tab, two readers side by side — original on the left, translation on the right, with synchronized scrolling and page turns.

![Split view](docs/screenshots/split-view.png)

### Interleaved Bilingual Reading (Zotero 10)

Toggle "双语对照" in the reader sidebar: Zotero 10's SDT reading mode reflows the PDF into structured text and injects a translation block under every paragraph, translated lazily as you scroll.

![Interleaved bilingual](docs/screenshots/bilingual-interleave.png)

### Translation-only Mode

In the same bilingual session switch to "仅译文": original blocks are hidden, leaving only the translation for smooth reading.

![Translation only](docs/screenshots/translation-only.png)

> Interleaved / translation-only modes rely on Zotero 10's reading mode; on Zotero 7 the panel discloses the limitation while every other feature (selection, full-text, split, read-aloud) works on both versions.

## Translation Engines

Switchable in the preferences pane; all share a content-addressed cross-session translation cache:

| Engine | API key | Notes |
| --- | --- | --- |
| Google | optional | Free endpoint, automatic Bing-web fallback |
| Bing | required | Azure Translator REST API |
| DeepL | required | free / pro endpoint toggle |
| AI | endpoint required, key optional | OpenAI-compatible chat/completions with a user-owned prompt template |
| Custom | required | OpenAI-compatible chat/completions |
| zotero-pdf-translate | — | Delegates to the plugin when detected |

### The AI engine's prompt template

The AI engine hands "what gets sent to the model" to the user, and keeps two things for itself: the language configuration and the template validation.

![AI engine settings](docs/screenshots/ai-engine.png)

- A template must contain three placeholders — `{{text}}` (the text to translate), `{{sourceLang}}` and `{{targetLang}}`. They use double braces on purpose: `{v0}` / `{v1}` single-brace markers are formula positions in the pipeline, and the default template asks the model to keep them verbatim.
- The plugin resolves the language codes to readable names (`zh-CN` → Simplified Chinese) instead of sending raw codes.
- The template is validated as you type in the settings pane: misspelled, missing, duplicated or unbalanced placeholders and over-long templates each get their own inline message, an invalid value is never written to the settings, and a stored invalid template is blocked by the readiness check, which points back at the pane. An empty field restores the built-in default template.
- The cache invalidates by template fingerprint — editing one character forces a re-translation instead of serving results from the old prompt.
- Requests go out per paragraph (no batch JSON), same as any other model backend (self-hosted Ollama, vLLM, a gateway, …).

## Read-aloud

Both the bilingual session and the selection panel support read-aloud (Windows SAPI / system TTS) with sentence-level highlight tracking: the original is located via the PDF text layer, the translation via the bilingual blocks.

## Build

```bash
npm install          # install dependencies
npm run dev          # serve into Zotero with hot reload (zotero-plugin serve)
npm run build        # typecheck + bundle into .scaffold/build
npm run test:unit    # vitest (tests/unit + tests/node, Node environment)
```

Requires Node.js ≥ 22.8 (`zotero-plugin-scaffold@0.8` engines constraint).

## Layout

See the table above — `addon/` holds the static addon assets, `src/` the plugin
source (entry `src/index.ts`, lifecycle `src/hooks.ts`, shared helpers in
`src/utils/`), `src/modules/` the UI registration modules loaded dynamically by
`hooks.onStartup`, and `tests/` the suites split by runner.

## Preferences

Defaults are declared in `addon/prefs.js` under the
`extensions.zotero.ztransplit.` branch; read them through `getPref` /
`getPrefDynamic` in `src/utils/prefs.ts`.

## License

MIT — see [LICENSE](./LICENSE).
