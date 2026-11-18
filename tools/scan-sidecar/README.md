# 扫描页识别侧车（Z-Transplit）

在插件设置的「扫描页识别」里填写的命令就指向本目录的 `sidecar.py`。它把扫描 PDF 页
识别成带坐标的文字、公式与表格，输出一份 JSON；插件只认 JSON 契约（见
`src/core/pdf/scan/sidecarProtocol.ts`），不关心识别用哪家引擎——换引擎不用改插件。

## 安装

需要 Python 3.9 以上（开发与联调用；插件的自动分发属第二期，届时随插件下载托管运行时）：

```bash
pip install -r requirements.txt
```

CPU 即可运行。识别速度取决于机器：一篇 20 页的扫描论文，200dpi 下通常几分钟。

## 用法

```bash
python sidecar.py --pdf paper.pdf --pages 1-5,7 --out workdir --dpi 200
```

- `--pages`：1 基页码，支持 `1-5,7` 这样的混合写法；
- `--dpi`：渲染分辨率，72–600，默认 200；
- `--out`：输出目录，识别完成写 `result.json`；
- 退出码：0 全部成功；2 部分成功（JSON 仍含成功页）；1 致命错误（参数错、PDF 打不开、引擎导入失败）；
- stderr 每行一个 JSON 诊断，插件把摘要带进进度与错误提示。

## 输出契约（摘要）

每页一个对象：`lines`（行级文字框，同 `blockId` 拼段，`blockType` 区分标题/正文/
图注）、`formulas`（LaTeX）、`tables`（HTML）、`figures`（区域）、`coverage`（检出区域
面积占比，插件据此判断是否整页漏检并重试）、`rotation` 非 0 时只回报 `skipReason`。
字段级容错规则见 `sidecarProtocol.ts` 的解析函数。

## 识别链

pypdfium2 渲染 → PP-StructureV3（版面 + 阅读顺序 + 公式 + 表格）→ PP-OCRv6 行级
文字框 → 行按所在版面块归组。版面模型漏检时，页面级 OCR 的文字仍会以孤立行进入
结果——宁可多认，不漏内容。

## 排障

- `PPStructureV3 unavailable`：paddleocr 未安装或版本不含该类；`pip install -U paddleocr`。
- 识别慢：调低 `--dpi`，或调小插件设置里的「每批页数」。
- 结果缺字段：PaddleOCR 结果结构随小版本变动，本脚本对所有字段名做防御式读取并把
  读不到的记进 `diagnostics.warnings`；按警告提示的字段名在 `_first()` 里补一个别名即可。
- 旋转页：侧车不识别（叠加渲染器拒绝旋转页），插件让这些页保持原文。
