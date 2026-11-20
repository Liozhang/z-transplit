"""生成真机测试台用的三类版式夹具与两类扫描件夹具。

为什么单独一个脚本：仓库里原有的两篇夹具（attention-reading / reading-brain）
是 HTML 经无头 Edge 打印成 PDF 后成对提交的，但转换命令本身没有入库——换个
人想加夹具就只能靠猜。本脚本把这一步固化，顺带补上仓库一直缺的扫描件样本。

产出的五个文件全部直接提交进 scripts/qa/fixtures/，与原有两篇同等待遇：
  formula-dense.html / .pdf      双栏，公式密集
  three-column.html / .pdf       三栏带栏线，跨栏标题，通栏图
  landscape-slides.html / .pdf   横版，大字号标题
  scanned-sample.pdf             纯位图，无文本层
  scanned-degraded.pdf           同源位图加乱码文本层

三个 HTML 篇的公式一律用 HTML 排版（字符实体加 sub/sup），不用图片——沿用
attention-reading.html 的做法，这样进 PDF 之后是真文字，解析器提取得到，才
能检验公式在翻译链路里的去向。图片型 PDF 提不到文字，检验的是另一条链。

依赖：无头 Edge（或 Chrome/Chromium）负责 HTML 转 PDF；pymupdf 负责把已有
PDF 栅格化成图片型 PDF。pymupdf 是第三方包，只在本脚本用，不进发布物。

关于调用方式：仓库里 make_epub_fixture.py 用 python -I，因为那个脚本只用标准
库、且读的是自己刚写进 zip 的内容。本脚本不能用 -I——它要 import 用户
site-packages 里的 pymupdf，隔离模式看不见。本脚本读的外部文件只有仓库自己
的 reading-brain.pdf，HTML 全部是文件内的常量，没有需要 -I 防的不可信输入。

Run:  python scripts/qa/make_pdf_fixtures.py
"""

import os
import re
import subprocess
import sys

FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

# 无头浏览器候选，按优先级。命中第一个就停。
BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]

# 扫描件的源文档。复用 reading-brain 是有意的：它的原文已知，OCR 产出可以
# 逐句核对，不必先人工认一遍。
SCAN_SOURCE = "reading-brain.pdf"
SCAN_DPI = 200

# 乱码文本层里替换字符的比例。要同时满足两个约束：乱码率高于
# pageClassification 的 MIN_SANE_RATIO（0.9），去空白后的字符数高于
# MIN_PAGE_TEXT_CHARS（24）。取 0.3 离 0.1 的判定线有足够余量，换一篇源
# 文档也仍然落在 degraded 一侧。
GARBLE_RATIO = 0.3

# ── 公式密集（双栏） ────────────────────────────────────────────────
#
# 专门喂公式链路的两个方向：
#   误报方向——「模型设定」段里成串出现希腊字母与不等号，
#     isFormulaParagraph 的阈值是 2，这种统计学正文会被整段判成公式区，
#     整段被裁图送视觉模型、译文被截图盖死。
#   漏报方向——「勾股定理」段里的上标 ² 不在 FORMULA_CHAR_RE 的字符类里，
#     整段判不上公式，符号被传统机器翻译引擎直接改写。
# 另外还有三个编号独立公式、多处行内公式、以及引用公式的句子，覆盖
# 「行内 vs 独立」这条目前被丢弃的区分位。
FORMULA_DENSE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Formula Dense Sample</title>
<style>
  @page { size: A4; margin: 1.8cm 1.6cm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Times New Roman", "Noto Serif", serif;
    font-size: 9.5pt; line-height: 1.45; color: #111;
  }
  .paper { column-count: 2; column-gap: 0.9cm; column-rule: 0.5pt solid #bbb; }
  header.full, .span-all { column-span: all; }
  h1 { font-size: 17pt; text-align: center; margin: 0 0 8pt 0; line-height: 1.25; }
  .authors { font-style: italic; text-align: center; margin: 0 0 4pt 0; }
  .affil { text-align: center; font-size: 8.5pt; color: #444; margin: 0 0 14pt 0; }
  h2 { font-size: 11pt; margin: 12pt 0 5pt 0; page-break-after: avoid; }
  p { margin: 0 0 6pt 0; text-align: justify; }
  .abstract { font-size: 8.8pt; margin: 0 0 6pt 0; }
  .eq {
    text-align: center; font-style: italic; margin: 7pt 0;
    font-size: 10pt;
  }
  .eqnum { float: right; font-style: normal; }
  .refs { font-size: 8.2pt; }
  .refs p { text-indent: -10pt; padding-left: 10pt; margin-bottom: 3pt; }
</style>
</head>
<body>
<div class="paper">
  <header class="full">
    <h1>Estimating Attentional Allocation from Eye Movements: A Formula Dense Sample</h1>
    <p class="authors">R. Nakamura, K. Osei, and L. Bergström</p>
    <p class="affil">Department of Cognitive Science, Riverside Institute</p>
  </header>

  <p class="abstract"><b>Abstract</b> — We derive a family of estimators for the
  attentional weight a reader assigns to each token of a sentence, and we show how
  the estimators behave when the underlying fixation durations are correlated.
  Three closed form results are stated as numbered equations, and every claim in
  the paper is tied back to one of them.</p>

  <h2>1. Setup</h2>
  <p>Let a sentence consist of n tokens. For token i the observed fixation duration
  is d<sub>i</sub> and the surprisal under the reader's language model is
  s<sub>i</sub> = −log p(t<sub>i</sub> | t<sub>&lt;i</sub>). We write the latent
  attentional weight as α<sub>i</sub>, constrained so that the weights sum to one.</p>

  <p class="eq">α<sub>i</sub> = exp(θ s<sub>i</sub>) / Σ<sub>j=1</sub><sup>n</sup> exp(θ s<sub>j</sub>)<span class="eqnum">(1)</span></p>

  <p>Equation (1) is the softmax form. It is convenient because the normalising
  constant cancels in ratios, so the relative weight of two tokens depends only on
  the difference of their surprisals, as the identity below records.</p>

  <p class="eq">α<sub>i</sub> / α<sub>k</sub> = exp(θ (s<sub>i</sub> − s<sub>k</sub>))<span class="eqnum">(2)</span></p>

  <h2>2. Model</h2>
  <p>The generative model treats the durations as conditionally independent given
  the weights. Under that assumption the log likelihood separates into a sum over
  tokens, and the score with respect to θ has a particularly compact form.</p>

  <p class="eq">ℓ(θ) = Σ<sub>i=1</sub><sup>n</sup> d<sub>i</sub> log α<sub>i</sub> − λ Σ<sub>i=1</sub><sup>n</sup> α<sub>i</sub><span class="eqnum">(3)</span></p>

  <p>Differentiating (3) and setting the result to zero gives the fixed point
  iteration used throughout the paper. The iteration converges whenever θ is
  bounded and the durations are strictly positive, which holds for every corpus we
  examined.</p>

  <h3>2.1 Statistics of the estimator</h3>
  <p>Under the null hypothesis of no attentional modulation we have θ = 0, and the
  weights collapse to the uniform distribution. The estimator is asymptotically
  normal: writing β and α for the regression coefficients, the standard error
  satisfies s ≈ 1.96 / √n whenever p ≈ 0.05 and the residuals are homoscedastic.
  In practice the inequality χ² ≥ 3.84 is the operative test, and we reject the
  null whenever the observed statistic exceeds that threshold with r ≠ 0 and the
  effect size is at least δ ≥ 0.2.</p>

  <p>This paragraph is deliberately dense in Greek letters and inequality signs.
  The formula heuristic in the translation pipeline counts matching characters
  rather than distinct ones, so a paragraph of ordinary statistical prose can cross
  the threshold and be treated as a single formula region. When that happens the
  whole paragraph is cropped, sent to the vision model, and the returned image
  covers the translated text.</p>

  <h3>2.2 A formula the heuristic cannot see</h3>
  <p>Some formulae contain no character from the heuristic's symbol class at all.
  The most familiar example is the Pythagorean identity a² + b² = c², whose only
  non-ASCII character is the superscript two. A page of plane geometry, of
  elementary algebra, or of arithmetic exercises therefore passes through the
  pipeline unflagged, and a statistical machine translation engine rewrites the
  superscripts into ordinary digits.</p>

  <p>Other unseen cases include the limit notation lim<sub>n→∞</sub>, the
  trigonometric pair sin θ + cos θ, the set relations x ∈ A and A ⊂ B, the
  membership of the empty set ∅, and the subtraction written with the true minus
  sign a − b rather than a hyphen. None of these characters appears in the symbol
  class, so none of them triggers the formula path.</p>

  <h2>3. Relation to reading time</h2>
  <p>Total reading time for the sentence is the duration-weighted sum of the
  weights. Substituting (1) and collecting terms yields the closed form used in
  Section 4, and the same substitution explains why the estimator is insensitive
  to sentence length once n is large.</p>

  <p class="eq">T = (1/n) Σ<sub>i=1</sub><sup>n</sup> d<sub>i</sub> / (1 + exp(−θ s<sub>i</sub>))<span class="eqnum">(4)</span></p>

  <p>Equation (4) reduces to the mean duration when θ = 0 and to a max-like
  statistic when θ is large. Both limits are recovered correctly by the iteration,
  which is the main practical argument for the softmax parameterisation.</p>

  <h2>References</h2>
  <div class="refs">
    <p>Nakamura, R. (2020). Attention as a softmax over surprisal. <i>Journal of
    Mathematical Psychology, 94</i>, 101–318.</p>
    <p>Osei, K. (2021). Correlation robust variance estimates for fixation
    durations. <i>Behavior Research Methods, 53</i>(2), 712–729.</p>
  </div>
</div>
</body>
</html>
"""


# ── 三栏 ───────────────────────────────────────────────────────────
#
# 现有夹具只有单栏与双栏。三栏逼出两件目前完全没有的事：栏检测，以及栏间
# 文字不串位。版式上还带一个跨栏标题和一张通栏图，两者都会让解析器产出
# 横跨全页的段落，正是白遮罩涂白邻栏与图区的那条路径。
THREE_COLUMN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Three Column Sample</title>
<style>
  @page { size: A4; margin: 1.6cm 1.5cm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Times New Roman", "Noto Serif", serif;
    font-size: 8.5pt; line-height: 1.4; color: #111;
  }
  .paper { column-count: 3; column-gap: 0.6cm; column-rule: 0.5pt solid #bbb; }
  header.full, .span-all { column-span: all; }
  h1 { font-size: 16pt; text-align: center; margin: 0 0 6pt 0; line-height: 1.2; }
  .authors { font-style: italic; text-align: center; margin: 0 0 3pt 0; font-size: 9pt; }
  .affil { text-align: center; font-size: 8pt; color: #444; margin: 0 0 10pt 0; }
  h2 { font-size: 10pt; margin: 9pt 0 4pt 0; page-break-after: avoid; }
  p { margin: 0 0 5pt 0; text-align: justify; }
  figure { margin: 6pt 0; text-align: center; page-break-inside: avoid; }
  figcaption { font-size: 7.5pt; text-align: justify; color: #222; margin-top: 2pt; }
</style>
</head>
<body>
<div class="paper">
  <header class="full">
    <h1>Field Notes from a Three Column Layout</h1>
    <p class="authors">A. Whitfield, B. Ferreira, and C. Lindqvist</p>
    <p class="affil">Coastal Research Station</p>
  </header>

  <h2>1. Why three columns</h2>
  <p>Three column layouts appear in newsletters, conference programmes, and dense
  reference sheets. They are a useful stress case for any tool that has to put
  translated text back where the original text was, because the vertical gap
  between columns is small and the reading order zig zags down the page.</p>
  <p>The first column of this fixture carries only running prose, so that a tool
  which loses track of the column boundary shows up immediately as text drifting
  into the second column.</p>

  <h2>2. Measurements</h2>
  <p>Tide height was recorded every fifteen minutes for six weeks. Wind speed and
  direction came from the station anemometer at ten minute resolution. Water
  temperature was logged at three depths. All series were resampled to a common
  fifteen minute grid before comparison, and gaps shorter than two hours were
  filled by linear interpolation.</p>
  <p>Longer gaps were left unfilled and flagged in the derived tables, so that any
  statistic computed over them is reported together with the fraction of missing
  observations.</p>

  <h2>3. Preliminary results</h2>
  <p>Mean tide height over the recording window was within four centimetres of the
  predicted value for every week except the third, when a low pressure system
  pushed the observed series above prediction for thirty six hours.</p>
  <p>Water temperature at the shallowest sensor tracked air temperature with a lag
  of roughly two hours, while the deepest sensor showed no diurnal signal at all.
  The intermediate depth carried a signal whose amplitude was about half of the
  shallow one.</p>

  <h2>4. Instruments</h2>
  <p>The anemometer was calibrated against a hand held unit at the start and end of
  the campaign. The two readings agreed to within half a metre per second, which
  is well inside the resolution needed for the comparisons reported here.</p>
  <p>Temperature sensors were checked in an ice bath before deployment. All three
  agreed to within one tenth of a degree, and none drifted by more than that over
  the six weeks.</p>

  <figure class="span-all">
    <svg width="430" height="150" viewBox="0 0 430 150" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="428" height="148" fill="#ffffff" stroke="#999" stroke-width="0.5"/>
      <line x1="40" y1="120" x2="410" y2="120" stroke="#333" stroke-width="1"/>
      <line x1="40" y1="120" x2="40" y2="20" stroke="#333" stroke-width="1"/>
      <line x1="40" y1="90" x2="410" y2="90" stroke="#ddd" stroke-width="0.6"/>
      <line x1="40" y1="55" x2="410" y2="55" stroke="#ddd" stroke-width="0.6"/>
      <polyline points="50,112 100,100 150,104 200,86 250,74 300,80 350,62 400,52"
                fill="none" stroke="#2ca02c" stroke-width="2"/>
      <polyline points="50,114 100,110 150,112 200,106 250,108 300,100 350,98 400,92"
                fill="none" stroke="#ff7f0e" stroke-width="2" stroke-dasharray="5,3"/>
      <text x="30" y="123" font-size="8" text-anchor="end" fill="#333">0</text>
      <text x="30" y="93" font-size="8" text-anchor="end" fill="#333">15</text>
      <text x="30" y="58" font-size="8" text-anchor="end" fill="#333">30</text>
      <text x="50" y="134" font-size="8" text-anchor="middle" fill="#333">Wk 1</text>
      <text x="150" y="134" font-size="8" text-anchor="middle" fill="#333">Wk 3</text>
      <text x="250" y="134" font-size="8" text-anchor="middle" fill="#333">Wk 5</text>
      <text x="400" y="134" font-size="8" text-anchor="middle" fill="#333">Wk 6</text>
      <line x1="270" y1="28" x2="295" y2="28" stroke="#2ca02c" stroke-width="2"/>
      <text x="300" y="31" font-size="8" fill="#333">Shallow sensor</text>
      <line x1="270" y1="40" x2="295" y2="40" stroke="#ff7f0e" stroke-width="2" stroke-dasharray="5,3"/>
      <text x="300" y="43" font-size="8" fill="#333">Deep sensor</text>
    </svg>
    <figcaption><b>Figure 1:</b> Water temperature at the shallow and deep sensors
    over the six week campaign. The shallow series follows the air temperature
    cycle; the deep series is nearly flat.</figcaption>
  </figure>

  <h2>5. Discussion</h2>
  <p>The agreement between observed and predicted tide height is good enough that
  the residual series can be used directly as a wind and pressure proxy for the
  weeks when the anemometer was offline.</p>
  <p>The two hour lag at the shallow sensor is consistent with a simple mixed layer
  model, and the absence of a diurnal signal at depth rules out any direct
  convective mixing below the thermocline during the campaign.</p>

  <h2>6. Next steps</h2>
  <p>The next campaign will add a fourth temperature sensor and a current meter.
  Both are needed to close the heat budget, which is the quantity the station
  exists to measure.</p>
</div>
</body>
</html>
"""


# ── 横版（幻灯片比例） ─────────────────────────────────────────────
#
# 暴露页面方向与通栏。横版页在叠加渲染路径上直接抛
# render-error-rotated-page 之前要先过 /Rotate 这一关——本夹具的页面本身
# 不是旋转的（MediaBox 就是横的），逼出来的是「非纵向页面」这条完全没测过
# 的路。另有大字号标题与通栏图，检验字号收缩与大段框。
LANDSCAPE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Landscape Slides Sample</title>
<style>
  @page { size: A4 landscape; margin: 1.4cm 1.6cm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Helvetica", "Arial", sans-serif;
    font-size: 11pt; line-height: 1.4; color: #111;
  }
  h1 { font-size: 26pt; text-align: center; margin: 0 0 10pt 0; line-height: 1.15; }
  .sub { text-align: center; font-size: 13pt; color: #444; margin: 0 0 18pt 0; }
  h2 { font-size: 15pt; margin: 14pt 0 6pt 0; }
  p { margin: 0 0 8pt 0; }
  ul { margin: 0 0 8pt 0; padding-left: 18pt; }
  li { margin-bottom: 4pt; }
  figure { margin: 10pt 0; text-align: center; }
  figcaption { font-size: 9.5pt; color: #222; margin-top: 4pt; }
  .box {
    border: 0.8pt solid #336; background: #eef2f8;
    padding: 8pt 10pt; margin: 10pt 0;
  }
  .box h2 { margin-top: 0; }
</style>
</head>
<body>
  <h1>Reading Practice Changes What Children Look At</h1>
  <p class="sub">Twelve weeks of structured practice, 240 children, three classrooms per condition</p>

  <div class="box">
    <h2>The claim</h2>
    <p>Structured reading practice does not merely make children faster. It changes
    <b>where</b> they look, and the change survives twelve weeks after training
    stops.</p>
  </div>

  <h2>What we did</h2>
  <ul>
    <li>240 children aged eight to twelve, matched in pairs by baseline literacy.</li>
    <li>Twelve weeks of daily forty minute sessions, three activity blocks each.</li>
    <li>Eye movements tracked at 500 Hz; comprehension scored by two blind raters.</li>
  </ul>

  <h2>What we found</h2>
  <p>Comprehension scores rose 23 percent on average, and the rise was largest for
  the children who started lowest. Latency measures showed a 40 millisecond
  advantage in the trained group on sentences with a rare word or an ambiguous
  referent, and the advantage grew over the course of training.</p>

  <figure>
    <svg width="700" height="180" viewBox="0 0 700 180" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="698" height="178" fill="#ffffff" stroke="#999" stroke-width="0.5"/>
      <line x1="55" y1="145" x2="670" y2="145" stroke="#333" stroke-width="1"/>
      <line x1="55" y1="145" x2="55" y2="25" stroke="#333" stroke-width="1"/>
      <line x1="55" y1="110" x2="670" y2="110" stroke="#ddd" stroke-width="0.6"/>
      <line x1="55" y1="70" x2="670" y2="70" stroke="#ddd" stroke-width="0.6"/>
      <line x1="55" y1="35" x2="670" y2="35" stroke="#ddd" stroke-width="0.6"/>
      <rect x="90"  y="60"  width="42" height="85" fill="#9ecae1" stroke="#333" stroke-width="0.6"/>
      <rect x="160" y="78"  width="42" height="67" fill="#9ecae1" stroke="#333" stroke-width="0.6"/>
      <rect x="230" y="92"  width="42" height="53" fill="#9ecae1" stroke="#333" stroke-width="0.6"/>
      <rect x="300" y="104" width="42" height="41" fill="#fdd0a2" stroke="#333" stroke-width="0.6"/>
      <rect x="370" y="96"  width="42" height="49" fill="#fdd0a2" stroke="#333" stroke-width="0.6"/>
      <rect x="440" y="84"  width="42" height="61" fill="#fdd0a2" stroke="#333" stroke-width="0.6"/>
      <text x="111" y="160" font-size="9" text-anchor="middle" fill="#333">Baseline</text>
      <text x="181" y="160" font-size="9" text-anchor="middle" fill="#333">Week 3</text>
      <text x="251" y="160" font-size="9" text-anchor="middle" fill="#333">Week 6</text>
      <text x="321" y="160" font-size="9" text-anchor="middle" fill="#333">Week 9</text>
      <text x="391" y="160" font-size="9" text-anchor="middle" fill="#333">Week 12</text>
      <text x="461" y="160" font-size="9" text-anchor="middle" fill="#333">Follow up</text>
      <text x="42" y="148" font-size="9" text-anchor="end" fill="#333">0</text>
      <text x="42" y="113" font-size="9" text-anchor="end" fill="#333">10</text>
      <text x="42" y="73" font-size="9" text-anchor="end" fill="#333">20</text>
      <text x="42" y="38" font-size="9" text-anchor="end" fill="#333">30</text>
      <rect x="520" y="52" width="16" height="10" fill="#9ecae1" stroke="#333" stroke-width="0.5"/>
      <text x="542" y="61" font-size="9" fill="#333">Trained</text>
      <rect x="520" y="72" width="16" height="10" fill="#fdd0a2" stroke="#333" stroke-width="0.5"/>
      <text x="542" y="81" font-size="9" fill="#333">Control</text>
    </svg>
    <figcaption><b>Figure 1:</b> Mean comprehension gain by measurement point. The
    trained group separates from controls after week three and holds the gap at the
    twelve week follow up.</figcaption>
  </figure>

  <h2>Why it matters</h2>
  <p>If practice changes where children look rather than only how fast they read,
  then practice design is a lever on attention, not just on fluency. That is a
  cheaper lever than curriculum reform and a more durable one than a single
  intervention week.</p>
</body>
</html>
"""


def find_browser():
    """返回第一个存在的无头浏览器路径，全都找不到返回 None。"""
    for candidate in BROWSER_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return None


def html_to_pdf(browser, html_path, pdf_path):
    """用无头浏览器把 HTML 打印成 PDF。

    --headless=new 是当前 Chromium 系推荐的形态；旧版的 --headless 也能用，
    但打印回调在新形态下更可靠。--disable-gpu 避免某些虚拟环境里初始化
    GPU 失败连带打印失败。--no-pdf-header-footer 去掉浏览器默认加的日期与
    标题页眉，否则 PDF 顶部会多出两行与正文无关的文字。
    """
    cmd = [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path}",
        html_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)


def write_html(name, content):
    """把 HTML 常量写进夹具目录，返回写入路径。"""
    path = os.path.join(FIXTURE_DIR, name)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
    return path


def build_scanned(name, source_pdf, dpi, garble_ratio=None):
    """由源 PDF 造图片型 PDF。

    整页栅格化后重建为只含图像的文档：没有字体、没有文本层，
    pageClassification 的 textLength 判不到字符，落到 scanned 分支。

    garble_ratio 非 None 时额外铺一层文本层，并把它的 ToUnicode 按该比例
    改写成私用区码位。文字用白色画在源页原位——分类只读文本层，看不见不
    影响判定，而视觉上与 scanned-sample 完全一致，两份夹具的截图可以直接
    对比。这一层把 saneRatio 压到 0.9 以下，落到 degraded 分支。
    """
    import fitz

    src = fitz.open(source_pdf)
    out = fitz.open()
    for page in src:
        pix = page.get_pixmap(dpi=dpi)
        rect = fitz.Rect(0, 0, page.rect.width, page.rect.height)
        new_page = out.new_page(width=rect.width, height=rect.height)
        new_page.insert_image(rect, pixmap=pix)
        if garble_ratio is not None:
            _insert_garble_layer(new_page, page, garble_ratio)
    if garble_ratio is not None:
        remapped = _attach_garbled_tounicode(out, garble_ratio)
        if remapped == 0:
            raise SystemExit(
                "没有改写到任何 ToUnicode 表，乱码层不会生效——"
                "pymupdf 版本若改变了插入文本用的字体形态，这里必须报错而不是"
                "静默产出一个分类还是 digital 的夹具。"
            )
    target = os.path.join(FIXTURE_DIR, name)
    out.save(target, garbage=4, deflate=True)
    out.close()
    src.close()
    return target


def _insert_garble_layer(page, source_page, ratio):
    """在已栅格化的页面上铺一层文本层，再把它的 ToUnicode 改成私用区码位。

    为什么绕这么一圈：分类器认定的乱码是三样——C0/C1 控制符、私用区码位、
    替换符。实测前两样都写不进去：C0 控制符能被 pymupdf 原样往返，但真理解
    析器用的 PDFBox 会把它整个丢掉；替换符与私用区码位则被 pymupdf 在插入时
    换成了间隔号，那个字符不在乱码类里。三条路都试过，只剩这一条能同时让
    pymupdf 写得出、PDFBox 提得到。

    做法分两步：先用普通字体把源页文字按原位插一遍（白色，看不见），再把该
    字体的 ToUnicode 表里一部分目的码位改写成私用区码位。字形由字体编码决定、
    不受 ToUnicode 影响，所以画面仍然是一张干净的扫描图；提取则拿到私用区
    乱码。这也正是真实世界里 ToUnicode 映射损坏那种 PDF 的成因。
    """
    blocks = source_page.get_text("dict")["blocks"]
    for block in blocks:
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text", "")
                if not text.strip():
                    continue
                origin = span["origin"]
                size = max(span.get("size", 9) * 0.9, 4)
                page.insert_text(
                    (origin[0], origin[1]),
                    text,
                    fontsize=size,
                    color=(1, 1, 1),
                )


def _attach_garbled_tounicode(doc, ratio):
    """给插入文本用的 WinAnsi 字体挂一张部分指向私用区的 ToUnicode 表。

    pymupdf 插入文本用的是 base-14 Type1 字体（Helvetica + WinAnsiEncoding），
    本身不带 ToUnicode，提取完全依赖标准 WinAnsi 映射——所以怎么插入都提不
    出乱码。这里自己补一张 CMap：按 cp1252 表给出每个码位的正常 Unicode，其
    中按比例确定性抽样的一部分改写成私用区码位。

    字形由字体编码决定，不受 ToUnicode 影响，所以画面仍然是一张干净的扫描
    图；提取则按新表拿到私用区乱码。这正是真实世界里 ToUnicode 映射损坏那种
    PDF 的成因，也是分类器把私用区码位列为乱码特征要抓的东西。

    返回改写的字体个数。只碰 WinAnsi 编码且原本没有 ToUnicode 的字体——已有
    ToUnicode 的（源文档自带字体）一律不碰。
    """
    import random

    rng = random.Random(20261119)
    seen = set()
    patched = 0
    for page in doc:
        for font in page.get_fonts():
            xref = font[0]
            if xref in seen:
                continue
            seen.add(xref)
            if doc.xref_get_key(xref, "ToUnicode")[0] != "null":
                continue
            enc_kind, enc_value = doc.xref_get_key(xref, "Encoding")
            if enc_kind != "name" or "WinAnsi" not in str(enc_value):
                continue
            entries = []
            for code in range(0x00, 0x100):
                if code in (0x0A, 0x0D):
                    continue
                if rng.random() < ratio:
                    dst = 0xE000 + (len(entries) % 0x1000)
                    entries.append(f"<{code:02X}> <{dst:04X}>")
                else:
                    uni = bytes([code]).decode("cp1252", errors="replace")
                    entries.append(f"<{code:02X}> <{ord(uni):04X}>")
            cmap = _build_tounicode_cmap(entries)
            stream_xref = doc.get_new_xref()
            doc.update_object(stream_xref, "<<>>")
            doc.update_stream(stream_xref, cmap.encode("latin-1"))
            doc.xref_set_key(xref, "ToUnicode", f"{stream_xref} 0 R")
            patched += 1
    return patched


def _build_tounicode_cmap(entries):
    """拼出一张最小可用的 ToUnicode CMap。"""
    body = "\n".join(entries)
    return (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\n"
        "begincmap\n"
        "/CIDSystemInfo\n"
        "<< /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Adobe-Identity-UCS def\n"
        "/CMapType 2 def\n"
        "1 begincodespacerange\n"
        "<00> <ff>\n"
        "endcodespacerange\n"
        f"{len(entries)} beginbfchar\n"
        f"{body}\n"
        "endbfchar\n"
        "endcmap\n"
        "CMapName currentdict /CMap defineresource pop\n"
        "end\n"
        "end\n"
    )


def count_pdf_pages(path):
    """粗数 PDF 页数：统计 `/Type /Page` 的出现次数。

    刻意不引 pymupdf——这个校验要在装上 pymupdf 之前也能跑，否则 HTML 三篇
    的成败会被一个无关的第三方包挡住。对象流可能被压缩，数不到时就返回 0，
    由调用方决定是否当成失败。
    """
    with open(path, "rb") as fh:
        raw = fh.read()
    if not raw.startswith(b"%PDF"):
        raise SystemExit(f"不是 PDF 文件: {path}")
    # `/Type /Page` 与 `/Type/Page` 两种写法都算；`/Pages` 是页树节点，要排掉。
    return sum(
        1
        for token in (b"/Type /Page", b"/Type/Page")
        for _ in range(raw.count(token))
    ) - raw.count(b"/Type /Pages") - raw.count(b"/Type/Pages")


def verify(path, min_pages=1):
    """确认产物存在、是 PDF、页数够。返回 (路径, 页数, 字节数)。"""
    if not os.path.isfile(path):
        raise SystemExit(f"夹具未生成: {path}")
    size = os.path.getsize(path)
    if size < 1024:
        raise SystemExit(f"夹具异常小({size} 字节)，打印大概失败了: {path}")
    pages = count_pdf_pages(path)
    if pages < min_pages:
        raise SystemExit(f"夹具页数不足({pages} < {min_pages}): {path}")
    return path, pages, size


def main():
    os.makedirs(FIXTURE_DIR, exist_ok=True)

    browser = find_browser()
    if not browser:
        raise SystemExit(
            "找不到无头浏览器。请在下列候选之一的位置安装 Edge 或 Chrome，"
            "或手工把 HTML 打印成 PDF 后放进 scripts/qa/fixtures/：\n  "
            + "\n  ".join(BROWSER_CANDIDATES)
        )
    print("browser:", browser)

    html_specs = [
        ("formula-dense.html", FORMULA_DENSE_HTML),
        ("three-column.html", THREE_COLUMN_HTML),
        ("landscape-slides.html", LANDSCAPE_HTML),
    ]

    for name, content in html_specs:
        html_path = write_html(name, content)
        pdf_name = name[:-5] + ".pdf"
        pdf_path = os.path.join(FIXTURE_DIR, pdf_name)
        html_to_pdf(browser, html_path, pdf_path)
        path, pages, size = verify(pdf_path)
        print(f"  {pdf_name:26} {pages} 页  {size:>8} 字节")

    # 扫描件两篇依赖 pymupdf，单独 try：缺包时前面三个 PDF 已经落盘，不至于
    # 整个脚本白跑。
    try:
        import fitz  # noqa: F401
    except ImportError:
        raise SystemExit(
            "缺 pymupdf，无法生成扫描件夹具。装它：\n"
            "  python -I -m pip install pymupdf\n"
            "只影响 scanned-sample.pdf 与 scanned-degraded.pdf 两个文件。"
        )

    source = os.path.join(FIXTURE_DIR, SCAN_SOURCE)
    if not os.path.isfile(source):
        raise SystemExit(f"扫描件源文档不在: {source}")

    for name, ratio in [
        ("scanned-sample.pdf", None),
        ("scanned-degraded.pdf", GARBLE_RATIO),
    ]:
        built = build_scanned(name, source, SCAN_DPI, garble_ratio=ratio)
        path, pages, size = verify(built, min_pages=1)
        # 扫描件必须真的提不到文字，否则分类不会走 OCR 分支，夹具白造。
        doc = fitz.open(path)
        extracted = sum(len(p.get_text().strip()) for p in doc)
        doc.close()
        if ratio is None and extracted != 0:
            raise SystemExit(
                f"{name} 仍能提出 {extracted} 字符，不是纯图片型 PDF"
            )
        print(f"  {name:26} {pages} 页  {size:>8} 字节  文本层 {extracted} 字符")

    print("完成。产物在", FIXTURE_DIR)


if __name__ == "__main__":
    main()
