# 扫描页识别侧车（Z-Transplit）

在插件设置的「扫描页识别」里填写的命令就指向本目录的 `sidecar.py`。它把扫描 PDF 页
识别成带坐标的文字、公式与表格，输出一份 JSON；插件只认 JSON 契约（见
`src/core/pdf/scan/sidecarProtocol.ts`），不关心识别用哪家引擎——换引擎不用改插件。

本目录随插件一起分发（打包进 XPI），安装时由插件复制到 Zotero 数据目录的
`ztransplit/scan-sidecar/` 下运行。日常使用不需要手动装任何东西：设置面板的
「一键安装识别环境」会装好 Python 运行时、依赖与模型，并把命令回填进设置。
下面的手动步骤是给开发联调与高级用户的。

## 安装

需要 Python 3.9 以上：

```bash
pip install -r requirements.txt
```

CPU 即可运行。识别速度取决于机器：一篇 20 页的扫描论文，200dpi 下通常几分钟。
首次构建识别引擎时会下载模型权重（几百 MB），`--selftest` 就是用来提前把这件事
做完的。

## 用法

```bash
python sidecar.py --pdf paper.pdf --pages 1-5,7 --out workdir --dpi 200
python sidecar.py --selftest          # 只构建引擎：验证环境就位并预热模型
```

- `--pages`：1 基页码，支持 `1-5,7` 这样的混合写法；空规格（例如 `0`）按致命错误处理；
- `--dpi`：渲染分辨率，72–600，默认 200，超出范围按最接近的边界处理；
- `--out`：输出目录，识别完成写 `result.json`；
- `--selftest`：构建版面/OCR 引擎并渲染一页空白页后退出，stdout 打印一行 `{"selftest":"ok",…}`；
  插件在一键安装的最后一步调用它；
- 退出码：0 全部成功；2 部分成功（JSON 仍含成功页）；1 致命错误（参数错、PDF 打不开、引擎导入失败、渲染探活失败）；
- stderr 每行一个 JSON 诊断，插件把摘要带进进度与错误提示；stdout 只放结果与自检的 JSON 行。

## 输出契约（摘要）

每页一个对象：`lines`（行级文字框，同 `blockId` 拼段，`blockType` 区分标题/正文/
图注）、`formulas`（LaTeX）、`tables`（HTML）、`figures`（区域）、`coverage`（检出区域
面积占比，插件据此判断是否整页漏检并重试）、`rotation` 非 0 时只回报 `skipReason`。
字段级容错规则见 `sidecarProtocol.ts` 的解析函数。

## 识别链

pypdfium2 渲染 → PP-StructureV3（版面 + 阅读顺序 + 公式 + 表格，默认模型随
PaddleOCR 版本而定）→ PaddleOCR 行级文字框 → 行按所在版面块归组。版面模型
漏检时，页面级 OCR 的文字仍会以孤立行进入结果——宁可多认，不漏内容。

`--selftest` 覆盖识别路径上的全部第三方组件：两个识别引擎加 pypdfium2 的
导入与一次真实栅格化。pypdfium2 是独立轮子，在 Windows 上缺 VC++ 运行库或
轮子架构不符时会单独失败，只检查引擎发现不了。

## 排障

- `PPStructureV3 unavailable`：paddleocr 未安装或版本不含该类；`pip install -U paddleocr`。
- 识别慢：调低 `--dpi`，或调小插件设置里的「每批页数」。
- 结果缺字段：PaddleOCR 结果结构随小版本变动，本脚本对所有字段名做防御式读取，
  读不到关键字段（文本列表、版面块列表）时记进 `diagnostics.warnings` 并在 stderr
  留一条诊断；按警告提示的字段名在 `_first()` 里补一个别名即可。
- 旋转页：侧车不识别（叠加渲染器拒绝旋转页），插件让这些页保持原文。
