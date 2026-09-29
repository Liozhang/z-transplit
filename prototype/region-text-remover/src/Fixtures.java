import org.apache.fontbox.ttf.TrueTypeCollection;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.graphics.state.RenderingMode;

import java.awt.Color;
import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;

/**
 * 生成测试夹具 PDF 与对应的删除区域文件（.rects，格式：页码 x0 y0 x1 y1）。
 * 每个夹具覆盖一类真实风险：多栏、图形混排、嵌入中文字体、不可见文字、旋转页、
 * 单个文字块内连续推进（无重新定位）的算子序列。
 */
public final class Fixtures {

    private static final File DIR = new File("work");

    public static void main(String[] args) throws Exception {
        if (!DIR.exists()) DIR.mkdirs();
        singleColumn();
        twoColumn();
        cjk();
        graphicsOverlap();
        invisibleText();
        rotatedPage();
        sequentialRuns();
        kerningTJ();
        System.out.println("fixtures done");
    }

    private static void write(String name, PDDocument doc, List<int[]> rectLines) throws Exception {
        File pdf = new File(DIR, name + ".pdf");
        doc.save(pdf);
        doc.close();
        try (PrintWriter w = new PrintWriter(new File(DIR, name + ".rects"), "UTF-8")) {
            w.println("# page x0 y0 x1 y1");
            for (int[] r : rectLines) {
                w.println(r[0] + " " + r[1] + " " + r[2] + " " + r[3] + " " + r[4]);
            }
        }
        System.out.println("wrote " + name);
    }

    private static final String[] SENTENCES = {
            "The quick brown fox jumps over the lazy dog near the riverbank.",
            "Experimental results demonstrate a statistically significant improvement.",
            "We formulate the optimization problem as a convex program with constraints.",
            "Figure three illustrates the distribution of measured particle sizes.",
            "Related work has explored similar architectures for language modeling.",
            "The proposed method achieves state-of-the-art performance on benchmarks.",
            "Samples were incubated at room temperature for approximately two hours.",
            "This section describes the evaluation protocol in greater detail."
    };

    private static void textLines(PDPageContentStream cs, PDFont font, float size,
                                  float x, float yTop, float leading, int from, int count) throws Exception {
        cs.beginText();
        cs.setFont(font, size);
        cs.newLineAtOffset(x, yTop);
        for (int i = 0; i < count; i++) {
            cs.showText(SENTENCES[(from + i) % SENTENCES.length]);
            cs.newLineAtOffset(0, -leading);
        }
        cs.endText();
    }

    /** 夹具一：单栏连续段落，删除第 3 到 7 行与第 13 到 17 行。 */
    private static void singleColumn() throws Exception {
        PDDocument doc = new PDDocument();
        PDPage page = new PDPage(PDRectangle.LETTER);
        doc.addPage(page);
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            textLines(cs, PDType1Font.HELVETICA, 11, 72, 720, 15, 0, 20);
        }
        List<int[]> rects = new ArrayList<>();
        // 行高 15，第 i 行基线 y = 720 - 15*i；行框取基线 ±11
        rects.add(new int[]{1, 66, (int) (720 - 15 * 7 - 4), (int) (72 + 460), (int) (720 - 15 * 3 + 9)});
        rects.add(new int[]{1, 66, (int) (720 - 15 * 17 - 4), (int) (72 + 460), (int) (720 - 15 * 13 + 9)});
        write("single", doc, rects);
    }

    /** 夹具二：双栏排版（按栏宽折行），右栏中部有插图框（不删），删除两栏的段落。 */
    private static void twoColumn() throws Exception {
        PDDocument doc = new PDDocument();
        PDPage page = new PDPage(PDRectangle.LETTER);
        doc.addPage(page);
        List<String> wrapped = wrap(SENTENCES, 46);
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            // 左栏 28 行
            cs.beginText();
            cs.setFont(PDType1Font.HELVETICA, 9);
            cs.newLineAtOffset(60, 720);
            for (int i = 0; i < 28; i++) {
                cs.showText(wrapped.get(i % wrapped.size()));
                cs.newLineAtOffset(0, -12);
            }
            cs.endText();
            // 右栏上段 8 行
            cs.beginText();
            cs.setFont(PDType1Font.HELVETICA, 9);
            cs.newLineAtOffset(320, 720);
            for (int i = 0; i < 8; i++) {
                cs.showText(wrapped.get((i + 3) % wrapped.size()));
                cs.newLineAtOffset(0, -12);
            }
            cs.endText();
            // 右栏插图：灰底矩形、边框、对角线、菱形（必须保留）
            cs.setNonStrokingColor(new Color(230, 230, 230));
            cs.addRect(320, 470, 250, 130);
            cs.fill();
            cs.setStrokingColor(40, 40, 40);
            cs.addRect(320, 470, 250, 130);
            cs.stroke();
            cs.moveTo(320, 470);
            cs.lineTo(570, 600);
            cs.moveTo(320, 600);
            cs.lineTo(570, 470);
            cs.stroke();
            cs.moveTo(445, 585);
            cs.lineTo(495, 535);
            cs.lineTo(445, 485);
            cs.lineTo(395, 535);
            cs.closePath();
            cs.stroke();
            // 右栏下段 6 行
            cs.beginText();
            cs.setFont(PDType1Font.HELVETICA, 9);
            cs.newLineAtOffset(320, 440);
            for (int i = 0; i < 6; i++) {
                cs.showText(wrapped.get((i + 1) % wrapped.size()));
                cs.newLineAtOffset(0, -12);
            }
            cs.endText();
        }
        List<int[]> rects = new ArrayList<>();
        rects.add(new int[]{1, 54, 606, 306, 726});  // 左栏第 1-10 行
        rects.add(new int[]{1, 54, 390, 306, 558});  // 左栏第 15-28 行
        rects.add(new int[]{1, 314, 630, 576, 726}); // 右栏上段
        rects.add(new int[]{1, 314, 362, 576, 448}); // 右栏下段
        write("twocol", doc, rects);
    }

    private static List<String> wrap(String[] sentences, int maxChars) {
        List<String> lines = new ArrayList<>();
        for (String s : sentences) {
            for (int i = 0; i < s.length(); i += maxChars) {
                lines.add(s.substring(i, Math.min(s.length(), i + maxChars)));
            }
        }
        return lines;
    }

    /** 夹具三：嵌入微软雅黑的中英文混排。 */
    private static void cjk() throws Exception {
        PDDocument doc = new PDDocument();
        PDPage page = new PDPage(PDRectangle.LETTER);
        doc.addPage(page);
        PDFont font;
        TrueTypeCollection ttc = new TrueTypeCollection(new File("C:/Windows/Fonts/msyh.ttc"));
        final TrueTypeFontBox box = new TrueTypeFontBox();
        ttc.processAllFonts(f -> { if (box.font == null) box.font = f; });
        font = PDType0Font.load(doc, box.font, true);
        String[] lines = {
                "实验结果表明，该方法在多项指标上都有明显提升。",
                "本研究提出了一种新的框架，用于处理长文档的版面分析。",
                "The proposed framework is evaluated on multiple benchmarks.",
                "图三展示了不同参数设置下的误差分布情况。",
                "我们在正文中同时保留了中英文混排的典型场景。",
                "对比实验覆盖了三种基线方法与两种消融设置。",
                "结论部分总结了全文的主要贡献与未来工作方向。"
        };
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            cs.beginText();
            cs.setFont(font, 12);
            cs.newLineAtOffset(72, 720);
            for (String line : lines) {
                cs.showText(line);
                cs.newLineAtOffset(0, -20);
            }
            cs.endText();
        }
        List<int[]> rects = new ArrayList<>();
        rects.add(new int[]{1, 66, 668, 540, 730});  // 前三行
        rects.add(new int[]{1, 66, 608, 540, 672});  // 第 5-7 行
        write("cjk", doc, rects);
    }

    private static final class TrueTypeFontBox {
        org.apache.fontbox.ttf.TrueTypeFont font;
    }

    /** 夹具四：段落与下划线、背景色块、贯穿文字区的表格线共存。 */
    private static void graphicsOverlap() throws Exception {
        PDDocument doc = new PDDocument();
        PDPage page = new PDPage(PDRectangle.LETTER);
        doc.addPage(page);
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            // 段落背景色块
            cs.setNonStrokingColor(new Color(245, 240, 220));
            cs.addRect(60, 600, 492, 120);
            cs.fill();
            // 文字必须用与背景不同的填充色，否则在背景块上隐形
            cs.setNonStrokingColor(Color.BLACK);
            textLines(cs, PDType1Font.HELVETICA, 11, 72, 700, 16, 2, 6);
            // 每行下划线
            cs.setStrokingColor(0, 0, 160);
            for (int i = 0; i < 6; i++) {
                cs.moveTo(72, 696 - 16 * i - 2);
                cs.lineTo(500, 696 - 16 * i - 2);
            }
            cs.stroke();
            // 贯穿文字区的表格线
            cs.setStrokingColor(120, 120, 120);
            for (int i = 0; i <= 4; i++) {
                cs.moveTo(72 + i * 120, 596);
                cs.lineTo(72 + i * 120, 724);
            }
            cs.stroke();
            // 删除区域之外的图形（必须原样保留）
            cs.setNonStrokingColor(new Color(200, 220, 245));
            cs.addRect(72, 300, 300, 180);
            cs.fill();
            cs.moveTo(450, 460);
            cs.lineTo(520, 390);
            cs.lineTo(450, 320);
            cs.lineTo(380, 390);
            cs.closePath();
            cs.fill();
        }
        List<int[]> rects = new ArrayList<>();
        rects.add(new int[]{1, 60, 596, 552, 724}); // 段落整体（含背景块）
        write("graphics", doc, rects);
    }

    /** 夹具五：渲染模式 3 的不可见文字（模拟识别层）。 */
    private static void invisibleText() throws Exception {
        PDDocument doc = new PDDocument();
        PDPage page = new PDPage(PDRectangle.LETTER);
        doc.addPage(page);
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            cs.setNonStrokingColor(new Color(180, 180, 180));
            cs.addRect(72, 650, 300, 60);
            cs.fill();
            cs.beginText();
            cs.setFont(PDType1Font.HELVETICA, 12);
            cs.setRenderingMode(RenderingMode.NEITHER);
            cs.newLineAtOffset(80, 690);
            cs.showText("INVISIBLE-OCR-LAYER-TEXT-SHOULD-BE-REMOVED");
            cs.endText();
            cs.beginText();
            cs.setFont(PDType1Font.HELVETICA, 12);
            cs.newLineAtOffset(80, 600);
            cs.showText("VISIBLE-TEXT-OUTSIDE-ANY-REGION-MUST-STAY");
            cs.endText();
        }
        List<int[]> rects = new ArrayList<>();
        rects.add(new int[]{1, 66, 640, 500, 715});
        write("invisible", doc, rects);
    }

    /** 夹具六：页面 /Rotate 为 90 度（区域用未旋转的原始用户坐标）。 */
    private static void rotatedPage() throws Exception {
        PDDocument doc = new PDDocument();
        PDPage page = new PDPage(PDRectangle.LETTER);
        doc.addPage(page);
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            textLines(cs, PDType1Font.HELVETICA, 11, 72, 700, 16, 0, 8);
        }
        page.setRotation(90);
        List<int[]> rects = new ArrayList<>();
        rects.add(new int[]{1, 66, 640, 540, 706});
        write("rotate90", doc, rects);
    }

    /** 夹具七：单个文字块内连续 showText 无重新定位，验证删除后推进量保持。 */
    private static void sequentialRuns() throws Exception {
        PDDocument doc = new PDDocument();
        PDPage page = new PDPage(PDRectangle.LETTER);
        doc.addPage(page);
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            cs.beginText();
            cs.setFont(PDType1Font.HELVETICA, 14);
            cs.newLineAtOffset(72, 700);
            cs.showText("ALPHA-TO-BE-REMOVED ");
            cs.showText("BETA-TO-BE-REMOVED ");
            cs.showText("GAMMA-MUST-SURVIVE-AT-CORRECT-X");
            cs.endText();
            cs.beginText();
            cs.setFont(PDType1Font.HELVETICA, 10);
            cs.newLineAtOffset(72, 650);
            cs.showText("Reference line at fixed position for pixel comparison.");
            cs.endText();
        }
        List<int[]> rects = new ArrayList<>();
        // 前两段的范围（第三段起点约在 x=430 之后，矩形不要碰到它）
        rects.add(new int[]{1, 66, 690, 428, 712});
        write("sequential", doc, rects);
    }

    /**
     * 夹具八：带字距数字的 TJ 数组，覆盖"数组部分保留"的重建路径。
     * 用等宽字体（每字符恒为 8.4 磅）保证边界框可以精确卡在前三段与保留段之间。
     */
    private static void kerningTJ() throws Exception {
        PDDocument doc = new PDDocument();
        PDPage page = new PDPage(PDRectangle.LETTER);
        doc.addPage(page);
        PDResources res = new PDResources();
        res.put(org.apache.pdfbox.cos.COSName.getPDFName("F1"), PDType1Font.COURIER);
        page.setResources(res);
        String content = "BT /F1 14 Tf 72 700 Td [(KERN-A) 60 (KERN-B) 80 (KERN-C) 100 (KEEP-TAIL)] TJ ET\n"
                + "BT /F1 10 Tf 72 650 Td (Reference line for pixel comparison.) Tj ET\n";
        org.apache.pdfbox.pdmodel.common.PDStream stream =
                new org.apache.pdfbox.pdmodel.common.PDStream(doc);
        try (java.io.OutputStream os = stream.createOutputStream()) {
            os.write(content.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        }
        page.setContents(stream);
        List<int[]> rects = new ArrayList<>();
        // Courier 14pt：每字符 8.4 磅，负字距把后续文本左移。区域右边界取 218，
        // 落在 KERN-C 末字形中点（约 217）与 KEEP-TAIL 首字形中点（约 224）之间。
        rects.add(new int[]{1, 66, 688, 218, 714});
        write("kerning", doc, rects);
    }
}
