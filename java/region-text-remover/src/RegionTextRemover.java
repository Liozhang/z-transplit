import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSFloat;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Z-Transplit 原文删除器：按边界框从 PDF 页面内容流中真正删除文字绘制指令。
 *
 * 处理范围：仅页面内容流（第 0 层）。表单（Form XObject）与透明组内部的文字
 * 一律保留，交由管线的遮罩路径覆盖——嵌套坐标系下的表单改写存在渲染风险，
 * 且文献正文全部位于页面层。
 *
 * 设计要点：
 * - 逐字形中点判定：字形（或字距数字）基线中点落入边界框即删除，
 *   剩余连续字形重建成 TJ 数组，缺口用位移数字补齐。
 * - 位置保持：解析器状态按原流推进量完整重放；改写后的 TJ 补足推进量，
 *   行撇号算子补 T*，双引号算子补 Tw/Tc，保证保留文字一个像素不动。
 * - 护栏：渲染模式 7（文字作剪裁路径）不删；含内联图像的流整条跳过；
 *   字体缺失按半宽估算；单个流失败不影响其余页面。
 */
public final class RegionTextRemover {

    /** 删除区域：PDF 用户坐标系（原点左下），页码从 1 开始。 */
    public static final class Rect {
        public final int page;
        public final float x0, y0, x1, y1;
        public Rect(int page, float x0, float y0, float x1, float y1) {
            this.page = page;
            this.x0 = Math.min(x0, x1);
            this.y0 = Math.min(y0, y1);
            this.x1 = Math.max(x0, x1);
            this.y1 = Math.max(y0, y1);
        }
        boolean contains(double x, double y) {
            return x >= x0 && x <= x1 && y >= y0 && y <= y1;
        }
    }

    /** 处理统计。 */
    public static final class Stats {
        public int pagesTouched;
        public int operatorsRemoved;
        public int operatorsKept;
        public int operatorsRewritten;
        public int streamsSkippedInlineImage;
        @Override public String toString() {
            return "pagesTouched=" + pagesTouched + " opsRemoved=" + operatorsRemoved
                    + " opsKept=" + operatorsKept + " opsRewritten=" + operatorsRewritten
                    + " streamsSkippedInlineImage=" + streamsSkippedInlineImage;
        }
    }

    /** 列向量仿射矩阵：p' = (a*x + c*y + e, b*x + d*y + f)。mul 为矩阵积 this × m。 */
    private static final class Mat {
        final float a, b, c, d, e, f;
        Mat(float a, float b, float c, float d, float e, float f) {
            this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
        }
        static Mat identity() { return new Mat(1, 0, 0, 1, 0, 0); }
        static Mat translate(float tx, float ty) { return new Mat(1, 0, 0, 1, tx, ty); }
        Mat mul(Mat m) {
            return new Mat(
                    a * m.a + c * m.b,
                    b * m.a + d * m.b,
                    a * m.c + c * m.d,
                    b * m.c + d * m.d,
                    a * m.e + c * m.f + e,
                    b * m.e + d * m.f + f);
        }
        double[] apply(double x, double y) {
            return new double[]{a * x + c * y + e, b * x + d * y + f};
        }
    }

    /** 内容流里的一个可判定单元：字形片段或字距数字。 */
    private static final class Piece {
        COSString source;
        int off, len;
        float x0, x1;
        COSBase original;
        boolean keep = true;
    }

    private static final class GlyphRun {
        float advance;
        final List<Piece> pieces = new ArrayList<>();
    }

    /** 一次文字显示算子的处理结果。 */
    private static final class TextOpResult {
        boolean anyDropped;
        boolean allDropped;
        float totalAdvance;
        List<Object> rewritten;
    }

    private final Stats stats;
    private final Map<PDResources, Map<COSName, PDFont>> fontCache = new IdentityHashMap<>();
    private List<Rect> currentRects;

    private RegionTextRemover(Stats stats) {
        this.stats = stats;
    }

    public static Stats remove(PDDocument doc, List<Rect> allRects) throws java.io.IOException {
        Stats stats = new Stats();
        Map<Integer, List<Rect>> byPage = new HashMap<>();
        for (Rect r : allRects) {
            byPage.computeIfAbsent(r.page, k -> new ArrayList<>()).add(r);
        }
        RegionTextRemover remover = new RegionTextRemover(stats);
        for (int i = 0; i < doc.getNumberOfPages(); i++) {
            List<Rect> rs = byPage.get(i + 1);
            if (rs == null) {
                continue;
            }
            remover.processPage(doc, doc.getPage(i), rs);
        }
        return stats;
    }

    private void processPage(PDDocument doc, PDPage page, List<Rect> rects) throws java.io.IOException {
        this.currentRects = rects;
        PDResources res = page.getResources();
        try (java.io.InputStream in = page.getContents()) {
            if (in == null) {
                return;
            }
            byte[] bytes = readAll(in);
            PDFStreamParser parser = new PDFStreamParser(bytes);
            parser.parse();
            List<Object> out = new ArrayList<>();
            boolean changed = rewriteTokens(parser.getTokens(), res, rects, out);
            if (changed) {
                replacePageContents(doc, page, out);
            }
        }
    }

    /** 重写一条页面内容流；返回是否有改动，结果写入 out。 */
    private boolean rewriteTokens(List<Object> tokens, PDResources res, List<Rect> rects, List<Object> out)
            throws java.io.IOException {
        // 含内联图像的流整条跳过，避免解析与写出往返破坏图像数据
        for (Object tok : tokens) {
            if (tok instanceof org.apache.pdfbox.contentstream.operator.Operator
                    && ((org.apache.pdfbox.contentstream.operator.Operator) tok).getName().equals("BI")) {
                stats.streamsSkippedInlineImage++;
                return false;
            }
        }
        boolean changed = false;
        Mat ctm = Mat.identity();
        java.util.ArrayDeque<Mat> stack = new java.util.ArrayDeque<>();
        boolean inText = false;
        Mat tlm = Mat.identity();
        Mat tm = Mat.identity();
        float fontSize = 0f;
        PDFont font = null;
        float leading = 0f, charSpacing = 0f, wordSpacing = 0f, hScale = 100f, rise = 0f;
        int renderMode = 0;

        List<COSBase> pending = new ArrayList<>();
        for (Object tok : tokens) {
            if (tok instanceof COSBase) {
                pending.add((COSBase) tok);
                continue;
            }
            if (!(tok instanceof org.apache.pdfbox.contentstream.operator.Operator)) {
                out.add(tok);
                continue;
            }
            org.apache.pdfbox.contentstream.operator.Operator op =
                    (org.apache.pdfbox.contentstream.operator.Operator) tok;
            String name = op.getName();
            switch (name) {
                case "q":
                    stack.push(ctm);
                    break;
                case "Q":
                    if (!stack.isEmpty()) ctm = stack.pop();
                    break;
                case "cm": {
                    Mat m = matFromNumbers(pending);
                    if (m != null) ctm = ctm.mul(m);
                    break;
                }
                case "BT":
                    inText = true;
                    tlm = Mat.identity();
                    tm = Mat.identity();
                    break;
                case "ET":
                    inText = false;
                    break;
                case "Tf": {
                    fontSize = numAt(pending, 1);
                    if (res != null && pending.size() >= 1 && pending.get(0) instanceof COSName) {
                        font = lookupFont(res, (COSName) pending.get(0));
                    } else {
                        font = null;
                    }
                    break;
                }
                case "Tm": {
                    Mat m = matFromNumbers(pending);
                    if (m != null) { tlm = m; tm = m; }
                    break;
                }
                case "Td":
                    if (pending.size() >= 2) {
                        tlm = tlm.mul(Mat.translate(numAt(pending, 0), numAt(pending, 1)));
                        tm = tlm;
                    }
                    break;
                case "TD":
                    if (pending.size() >= 2) {
                        leading = -numAt(pending, 1);
                        tlm = tlm.mul(Mat.translate(numAt(pending, 0), numAt(pending, 1)));
                        tm = tlm;
                    }
                    break;
                case "T*":
                    tlm = tlm.mul(Mat.translate(0, -leading));
                    tm = tlm;
                    break;
                case "TL":
                    leading = numAt(pending, 0);
                    break;
                case "Tc":
                    charSpacing = numAt(pending, 0);
                    break;
                case "Tw":
                    wordSpacing = numAt(pending, 0);
                    break;
                case "Tz":
                    hScale = numAt(pending, 0);
                    break;
                case "Ts":
                    rise = numAt(pending, 0);
                    break;
                case "Tr":
                    renderMode = (int) numAt(pending, 0);
                    break;
                case "Tj":
                case "TJ":
                case "'":
                case "\"": {
                    // 原流语义顺序：行撇号先移动到下一行再显示；双引号算子还先设置字距
                    if (name.equals("'") || name.equals("\"")) {
                        tlm = tlm.mul(Mat.translate(0, -leading));
                        tm = tlm;
                    }
                    if (name.equals("\"")) {
                        wordSpacing = numAt(pending, 0);
                        charSpacing = numAt(pending, 1);
                    }
                    boolean evaluate = inText && renderMode != 7 && rects != null && !rects.isEmpty();
                    TextOpResult r = processTextOp(name, pending, ctm, tm,
                            font, fontSize, charSpacing, wordSpacing, hScale, rise, rects, evaluate);
                    if (evaluate && r.anyDropped) {
                        if (name.equals("\"")) {
                            emitOp(out, "Tw", numAt(pending, 0));
                            emitOp(out, "Tc", numAt(pending, 1));
                        }
                        if (name.equals("'") || name.equals("\"")) {
                            out.add(org.apache.pdfbox.contentstream.operator.Operator.getOperator("T*"));
                        }
                        if (r.rewritten != null) {
                            out.addAll(r.rewritten);
                        }
                        changed = true;
                        if (r.allDropped) {
                            stats.operatorsRemoved++;
                        } else {
                            stats.operatorsRewritten++;
                        }
                    } else {
                        copyOriginal(out, name, pending);
                        stats.operatorsKept++;
                    }
                    // 无论删留，解析器状态都按原流的推进量前进
                    tm = tm.mul(Mat.translate(r.totalAdvance, 0));
                    pending.clear();
                    continue;
                }
                default:
                    break;
            }
            copyOriginal(out, name, pending);
            pending.clear();
        }
        return changed;
    }

    private TextOpResult processTextOp(String name, List<COSBase> pending, Mat ctm, Mat tm,
                                       PDFont font, float fontSize, float charSpacing, float wordSpacing,
                                       float hScale, float rise, List<Rect> rects, boolean evaluate)
            throws java.io.IOException {
        TextOpResult result = new TextOpResult();
        float hs = hScale / 100f;
        Mat base = ctm.mul(tm);
        List<Piece> all = new ArrayList<>();

        if (name.equals("TJ")) {
            if (pending.isEmpty() || !(pending.get(0) instanceof COSArray)) {
                return result;
            }
            COSArray arr = (COSArray) pending.get(0);
            float cursor = 0f;
            for (int i = 0; i < arr.size(); i++) {
                COSBase el = arr.get(i);
                if (el instanceof COSString) {
                    GlyphRun run = measureString((COSString) el, font, fontSize, charSpacing, wordSpacing, hs);
                    for (Piece p : run.pieces) {
                        p.x0 += cursor;
                        p.x1 += cursor;
                        all.add(p);
                    }
                    cursor += run.advance;
                } else if (el instanceof COSNumber) {
                    Piece p = new Piece();
                    float shift = -((COSNumber) el).floatValue() / 1000f * fontSize * hs;
                    p.x0 = cursor;
                    p.x1 = cursor + shift;
                    p.original = el;
                    all.add(p);
                    cursor += shift;
                }
            }
            result.totalAdvance = cursor;
        } else {
            int strIndex = name.equals("Tj") ? 0 : 2;
            if (pending.size() <= strIndex || !(pending.get(strIndex) instanceof COSString)) {
                return result;
            }
            GlyphRun run = measureString((COSString) pending.get(strIndex),
                    font, fontSize, charSpacing, wordSpacing, hs);
            all.addAll(run.pieces);
            result.totalAdvance = run.advance;
        }

        int dropped = 0;
        for (Piece p : all) {
            double mid = (p.x0 + p.x1) / 2.0;
            double[] point = base.apply(mid, rise);
            p.keep = !evaluate || point == null || Double.isNaN(point[0]) || Double.isNaN(point[1])
                    || !inAnyRect(rects, point[0], point[1]);
            if (!p.keep) dropped++;
        }
        if (dropped == 0 || all.isEmpty()) {
            return result;
        }
        result.anyDropped = true;
        result.allDropped = dropped == all.size();

        // 重建 TJ：保留片段按原顺序输出，缺口与尾部用位移数字补齐
        COSArray rebuilt = new COSArray();
        float emitted = 0f;
        for (Piece p : all) {
            if (!p.keep) continue;
            float gap = p.x0 - emitted;
            if (Math.abs(gap) > 0.01f) {
                rebuilt.add(toShift(gap, fontSize, hs));
            }
            if (p.len == 0) {
                rebuilt.add(p.original);
            } else {
                rebuilt.add(new COSString(Arrays.copyOfRange(p.source.getBytes(), p.off, p.off + p.len)));
            }
            emitted = p.x1;
        }
        float tail = result.totalAdvance - emitted;
        if (Math.abs(tail) > 0.01f) {
            rebuilt.add(toShift(tail, fontSize, hs));
        }
        List<Object> seq = new ArrayList<>();
        seq.add(rebuilt);
        seq.add(org.apache.pdfbox.contentstream.operator.Operator.getOperator("TJ"));
        result.rewritten = seq;
        return result;
    }

    private static COSFloat toShift(float advance, float fontSize, float hs) {
        return new COSFloat(-(advance / (fontSize * hs)) * 1000f);
    }

    /** 把字符串拆成字形片段（简单字体逐字节，CID 字体逐双字节）并测量基线区间。 */
    private GlyphRun measureString(COSString str, PDFont font, float fontSize,
                                  float charSpacing, float wordSpacing, float hs) throws java.io.IOException {
        GlyphRun run = new GlyphRun();
        byte[] bytes = str.getBytes();
        if (font == null || fontSize == 0f) {
            float est = font == null ? 0.5f * fontSize : 0f;
            Piece p = new Piece();
            p.source = str;
            p.off = 0;
            p.len = bytes.length;
            p.x1 = est * bytes.length;
            run.advance = p.x1;
            run.pieces.add(p);
            return run;
        }
        boolean multibyte = font instanceof PDType0Font;
        float avg = 500f;
        try {
            float a = font.getAverageFontWidth();
            if (a > 0) avg = a;
        } catch (Exception ignore) {
            // 保持默认平均字宽
        }
        int i = 0;
        while (i < bytes.length) {
            int code;
            int len;
            if (multibyte && i + 1 < bytes.length) {
                code = ((bytes[i] & 0xFF) << 8) | (bytes[i + 1] & 0xFF);
                len = 2;
            } else {
                code = bytes[i] & 0xFF;
                len = 1;
            }
            float w;
            try {
                w = font.getWidth(code);
            } catch (Exception e) {
                w = avg;
            }
            if (w <= 0) w = avg;
            Piece p = new Piece();
            p.source = str;
            p.off = i;
            p.len = len;
            p.x0 = run.advance;
            run.advance += (w / 1000f * fontSize
                    + (code == 32 && !multibyte ? wordSpacing : 0f)
                    + charSpacing) * hs;
            p.x1 = run.advance;
            run.pieces.add(p);
            i += len;
        }
        return run;
    }

    private boolean inAnyRect(List<Rect> rects, double x, double y) {
        for (Rect r : rects) {
            if (r.contains(x, y)) return true;
        }
        return false;
    }

    private void emitOp(List<Object> out, String opName, float operand) {
        out.add(new COSFloat(operand));
        out.add(org.apache.pdfbox.contentstream.operator.Operator.getOperator(opName));
    }

    private void copyOriginal(List<Object> out, String name, List<COSBase> pending) {
        out.addAll(pending);
        out.add(org.apache.pdfbox.contentstream.operator.Operator.getOperator(name));
    }

    private PDFont lookupFont(PDResources res, COSName name) {
        Map<COSName, PDFont> m = fontCache.computeIfAbsent(res, k -> new HashMap<>());
        return m.computeIfAbsent(name, n -> {
            try {
                return res.getFont(n);
            } catch (Exception e) {
                return null;
            }
        });
    }

    private void replacePageContents(PDDocument doc, PDPage page, List<Object> tokens) throws java.io.IOException {
        PDStream ns = new PDStream(doc);
        OutputStream os = ns.createOutputStream();
        new ContentStreamWriter(os).writeTokens(tokens);
        os.close();
        page.setContents(ns);
        stats.pagesTouched++;
    }

    private static Mat matFromNumbers(List<COSBase> operands) {
        if (operands.size() < 6) return null;
        float[] v = new float[6];
        for (int i = 0; i < 6; i++) {
            if (!(operands.get(i) instanceof COSNumber)) return null;
            v[i] = ((COSNumber) operands.get(i)).floatValue();
        }
        return new Mat(v[0], v[1], v[2], v[3], v[4], v[5]);
    }

    private static float numAt(List<COSBase> operands, int idx) {
        if (idx >= operands.size() || !(operands.get(idx) instanceof COSNumber)) return 0f;
        return ((COSNumber) operands.get(idx)).floatValue();
    }

    private static byte[] readAll(java.io.InputStream in) throws java.io.IOException {
        try (java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    public static void main(String[] args) {
        try {
            if (args.length == 3 && args[0].equals("--inspect")) {
                runInspect(args[1], args[2]);
                return;
            }
            if (args.length < 3) {
                System.err.println("usage: RegionTextRemover <input.pdf> <rects-file> <output.pdf>"
                        + " | --inspect <input.pdf> <out.txt>");
                System.exit(2);
            }
            List<Rect> rects = readRects(new java.io.File(args[1]));
            System.err.println("[ztransplit-remover] rects=" + rects.size());
            PDDocument doc = PDDocument.load(new java.io.File(args[0]));
            try {
                Stats stats = remove(doc, rects);
                doc.save(args[2]);
                System.err.println("[ztransplit-remover] done " + stats);
            } finally {
                doc.close();
            }
        } catch (Exception e) {
            System.err.println("[ztransplit-remover] FAILED: " + e);
            System.exit(1);
        }
    }

    static List<Rect> readRects(java.io.File f) throws java.io.IOException {
        List<Rect> rects = new ArrayList<>();
        for (String line : java.nio.file.Files.readAllLines(f.toPath())) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            String[] p = line.split("\\s+");
            if (p.length < 5) continue;
            try {
                rects.add(new Rect(Integer.parseInt(p[0]), Float.parseFloat(p[1]),
                        Float.parseFloat(p[2]), Float.parseFloat(p[3]), Float.parseFloat(p[4])));
            } catch (NumberFormatException e) {
                // 跳过无法解析的行
            }
        }
        return rects;
    }

    // ------------------------------------------------------------------
    // 检查模式（--inspect）：报告含文字的表单对象边界框。
    //
    // 矢量图（matplotlib/TikZ 等嵌入 PDF）在页面内容流中以 Form XObject
    // 引用，其内部文字不应翻译——管线据此把这些区域内的段落整体排除。
    // 只报告"最外层"表单：嵌套表单的文字必然落在外层边界框内。
    // ------------------------------------------------------------------

    /** 收集每个页面上含文字绘制指令的顶层表单边界框（PDF 用户坐标系）。 */
    public static List<Rect> inspectFormTextRegions(PDDocument doc) throws java.io.IOException {
        List<Rect> found = new ArrayList<>();
        Map<String, Boolean> seen = new LinkedHashMap<>();
        for (int i = 0; i < doc.getNumberOfPages(); i++) {
            PDPage page = doc.getPage(i);
            PDResources res = page.getResources();
            if (res == null) continue;
            try (java.io.InputStream in = page.getContents()) {
                if (in == null) continue;
                byte[] bytes = readAll(in);
                PDFStreamParser parser = new PDFStreamParser(bytes);
                parser.parse();
                scanTokensForForms(parser.getTokens(), res, i + 1, Mat.identity(), found, seen);
            }
        }
        return found;
    }

    /** 扫描一条内容流：跟踪 ctm，遇到引用表单的 Do 算子即定位并按需报告。 */
    private static void scanTokensForForms(List<Object> tokens, PDResources res, int page1,
                                           Mat ctm, List<Rect> found, Map<String, Boolean> seen)
            throws java.io.IOException {
        java.util.ArrayDeque<Mat> stack = new java.util.ArrayDeque<>();
        List<COSBase> pending = new ArrayList<>();
        for (Object tok : tokens) {
            if (tok instanceof COSBase) {
                pending.add((COSBase) tok);
                continue;
            }
            if (!(tok instanceof org.apache.pdfbox.contentstream.operator.Operator)) continue;
            org.apache.pdfbox.contentstream.operator.Operator op =
                    (org.apache.pdfbox.contentstream.operator.Operator) tok;
            switch (op.getName()) {
                case "q":
                    stack.push(ctm);
                    break;
                case "Q":
                    if (!stack.isEmpty()) ctm = stack.pop();
                    break;
                case "cm": {
                    Mat m = matFromNumbers(pending);
                    if (m != null) ctm = ctm.mul(m);
                    break;
                }
                case "Do": {
                    if (pending.isEmpty() || !(pending.get(pending.size() - 1) instanceof COSName)) break;
                    COSName name = (COSName) pending.get(pending.size() - 1);
                    pending.clear();
                    org.apache.pdfbox.pdmodel.graphics.PDXObject xo;
                    try {
                        xo = res.getXObject(name);
                    } catch (java.io.IOException e) {
                        break; // 资源缺失：不影响其余对象
                    }
                    if (!(xo instanceof PDFormXObject)) break;
                    PDFormXObject form = (PDFormXObject) xo;
                    org.apache.pdfbox.pdmodel.common.PDRectangle bb = form.getBBox();
                    if (bb == null) break;
                    // 表单空间四角经 ctm 映射到用户空间，取包围盒
                    double[] c1 = ctm.apply(bb.getLowerLeftX(), bb.getLowerLeftY());
                    double[] c2 = ctm.apply(bb.getUpperRightX(), bb.getLowerLeftY());
                    double[] c3 = ctm.apply(bb.getLowerLeftX(), bb.getUpperRightY());
                    double[] c4 = ctm.apply(bb.getUpperRightX(), bb.getUpperRightY());
                    double x0 = Math.min(Math.min(c1[0], c2[0]), Math.min(c3[0], c4[0]));
                    double x1 = Math.max(Math.max(c1[0], c2[0]), Math.max(c3[0], c4[0]));
                    double y0 = Math.min(Math.min(c1[1], c2[1]), Math.min(c3[1], c4[1]));
                    double y1 = Math.max(Math.max(c1[1], c2[1]), Math.max(c3[1], c4[1]));
                    if (x1 - x0 <= 0.01 || y1 - y0 <= 0.01) break;
                    if (formContainsText(form, new java.util.HashSet<>())) {
                        String key = page1 + ":" + Math.round(x0 * 100) / 100.0 + ","
                                + Math.round(y0 * 100) / 100.0 + "," + Math.round(x1 * 100) / 100.0 + ","
                                + Math.round(y1 * 100) / 100.0;
                        if (seen.put(key, Boolean.TRUE) == null) {
                            found.add(new Rect(page1, (float) x0, (float) y0, (float) x1, (float) y1));
                        }
                    }
                    break;
                }
                default:
                    break;
            }
            pending.clear();
        }
    }

    /** 判断表单子树内是否出现文字显示算子（Tj/TJ/'/"），沿嵌套表单下钻，带环路保护。 */
    private static boolean formContainsText(PDFormXObject form, java.util.Set<PDFormXObject> path)
            throws java.io.IOException {
        if (!path.add(form)) return false;
        try {
            byte[] bytes;
            try (java.io.InputStream in = form.getPDStream().createInputStream()) {
                bytes = readAll(in);
            }
            PDFStreamParser parser = new PDFStreamParser(bytes);
            parser.parse();
            for (Object tok : parser.getTokens()) {
                if (!(tok instanceof org.apache.pdfbox.contentstream.operator.Operator)) continue;
                String n = ((org.apache.pdfbox.contentstream.operator.Operator) tok).getName();
                if (n.equals("Tj") || n.equals("TJ") || n.equals("'") || n.equals("\"")) {
                    return true;
                }
            }
            // 顶层流没有直接文字，继续检查嵌套表单
            PDResources res = form.getResources();
            if (res != null) {
                for (COSName name : res.getXObjectNames()) {
                    org.apache.pdfbox.pdmodel.graphics.PDXObject xo;
                    try {
                        xo = res.getXObject(name);
                    } catch (java.io.IOException e) {
                        continue;
                    }
                    if (xo instanceof PDFormXObject
                            && formContainsText((PDFormXObject) xo, path)) {
                        return true;
                    }
                }
            }
            return false;
        } finally {
            path.remove(form);
        }
    }

    /** 检查模式入口：--inspect &lt;input.pdf&gt; &lt;out.txt&gt;，输出每行 page x0 y0 x1 y1。 */
    private static void runInspect(String input, String out) throws java.io.IOException {
        PDDocument doc = PDDocument.load(new java.io.File(input));
        try {
            List<Rect> forms = inspectFormTextRegions(doc);
            StringBuilder sb = new StringBuilder();
            for (Rect r : forms) {
                sb.append(java.lang.String.format(java.util.Locale.ROOT,
                        "%d %.2f %.2f %.2f %.2f%n", r.page, r.x0, r.y0, r.x1, r.y1));
            }
            java.nio.file.Files.write(java.nio.file.Paths.get(out),
                    sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            System.err.println("[ztransplit-remover] inspect forms=" + forms.size());
        } finally {
            doc.close();
        }
    }

}
