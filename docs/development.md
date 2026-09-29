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
npm run release      # 打 tag 并产出 xpi + update.json
```

要求 Node.js ≥ 22.8（`zotero-plugin-scaffold@0.8` 的 engines 约束）。
jar 更新后必须跑 `npm run check:jar`（与 `PROVENANCE.json` 的 sha256 对账）。

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
| 单元 | `tests/unit/` | 引擎分发、缓存、面板 DOM 行为、设置 pane 显隐与校验、朗读控制 |
| Node 集成 | `tests/node/` | ODL JSON 适配、版式渲染往返、分屏同步、真实 fixture |
| 真机 | `scripts/qa/real-machine.mjs` | 在真实 Zotero（隔离 profile + 数据目录）里装载构建产物，驱动真实 DOM / 菜单 / 网络 / Java 流水线 |

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
`bilingual`、`readAloud`、`menus`、`itemtree`、`prefs`、`pipelineViaMenu`、`splitPanes`、
`attachments`、`verifyPdf`、`installPdf`、`setPref`、`capabilities`、`locales`、
`allPanes`、`sectionState`、`listCommands`。

排版/引擎相关的真机发现都建议带上 `docs/screenshots/` 截图归档。

## 移植来源

代码自 leadero 的 PDF 翻译能力移植而来，保留了可读性注释里的溯源署名
（`// Ported from leadero/…`）。`npm run check:structure` 的 S9 只拦截
**可执行**耦合（import / require / chrome://），注释不计。

## License

MIT — 见 [LICENSE](../LICENSE)。
