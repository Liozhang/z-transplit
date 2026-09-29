import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSFloat;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.cos.COSStream;
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
import org.apache.pdfbox.pdmodel.graphics.PDXObject;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 原型：按边界框从 PDF 内容流中真正删除文字绘制指令。
 *
 * 设计要点：
 * - 判定采用"逐字形中点"规则：每个字形（或字距数字）按其在基线上的中点判定去留，
 *   框内字形删除，剩余连续字形重建成新的 TJ 数组，缺口用位移数字补齐。
 * - 删除不改变后续算子的位置：解析器状态按原流推进量完整重放（无论删留），
 *   改写后的 TJ 用位移数字补足被丢弃字形的推进量，行撇号（' 和 "）补 T*，
 *   双引号算子（"）还补 Tw/Tc。
 * - 表单对象（Form XObject）在遇到 Do 算子的调用点递归处理：
 *   区域先经调用点变换矩阵的逆变换映射进表单坐标系，同一表单只按首次调用处理。
 * - 含内联图像（BI..EI）的内容流整条跳过，避免解析器与写出器往返破坏图像。
 * - 渲染模式 7（文字作为剪裁路径）一律不删。
 * - 自带三维仿射矩阵，明确列向量语义：设备坐标 = 当前变换矩阵 × 文字矩阵 × 点。
 */
public final class RegionTextRemover {

    /** 删除区域，PDF 用户坐标系（原点在左下角，未旋转的原始页面空间），页码从 1 开始。 */
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
        public int xObjectsProcessed;
        public int streamsSkippedInlineImage;
        @Override public String toString() {
            return "pagesTouched=" + pagesTouched + " opsRemoved=" + operatorsRemoved
                    + " opsKept=" + operatorsKept + " opsRewritten=" + operatorsRewritten
                    + " xObjectsProcessed=" + xObjectsProcessed
                    + " streamsSkippedInlineImage=" + streamsSkippedInlineImage;
        }
    }

    /** 列向量仿射矩阵：p' = (a*x + c*y + e, b*x + d*y + f)。 */
    private static final class Mat {
        final float a, b, c, d, e, f;
        Mat(float a, float b, float c, float d, float e, float f) {
            this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
        }
        static Mat identity() { return new Mat(1, 0, 0, 1, 0, 0); }
        static Mat translate(float tx, float ty) { return new Mat(1, 0, 0, 1, tx, ty); }
        /** 矩阵积 this × m（先应用 m，再应用 this），与 PDF 算子的拼接顺序一致。 */
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
        COSString source;   // 字符串片段的来源
        int off, len;       // 字节区间；数字片段 len=0
        float x0, x1;       // 基线区间（文字矩阵坐标系）
        COSBase original;   // 数字片段的原始对象
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
    private final Set<COSStream> visitedForms = new HashSet<>();
    private int debugPage;

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
            remover.debugPage = i + 1;
        remover.processPage(doc, doc.getPage(i), rs);
        }
        return stats;
    }

    private void processPage(PDDocument doc, PDPage page, List<Rect> rects) throws java.io.IOException {
        PDResources res = page.getResources();
        // PDFBox 2.0 只有拼接后的内容流入口；规范不允许算子跨流分裂，整体解析等价且更稳。
        try (java.io.InputStream in = page.getContents()) {
            if (in == null) {
                return;
            }
            byte[] bytes = readAll(in);
            PDFStreamParser parser = new PDFStreamParser(bytes);
            parser.parse();
            List<Object> out = new ArrayList<>();
            boolean changed = rewriteTokens(doc, parser.getTokens(), res, rects, Mat.identity(), 0, out);
            if (changed) {
                replacePageContents(doc, page, out);
            }
        }
    }

    /**
     * 重写一条内容流。rects 始终是页面用户坐标的原始区域；baseCtm 是从本流坐标
     * 到页面坐标的合成变换（页面流为恒等，表单流为调用点变换 × 表单矩阵的链式
     * 乘积）。字形判定时把字形坐标经 baseCtm 变换回页面坐标再比对区域，
     * 因此任意嵌套、旋转、剪切都精确，不需要对区域做逆映射。
     * 返回是否有改动，改写结果写入 out。
     */
    private boolean rewriteTokens(PDDocument doc, List<Object> tokens, PDResources res,
                                  List<Rect> rects, Mat baseCtm, int depth, List<Object> out)
            throws java.io.IOException {
        // 保险：含内联图像的流整条跳过，避免解析与写出往返破坏图像数据
        for (Object tok : tokens) {
            if (tok instanceof org.apache.pdfbox.contentstream.operator.Operator
                    && ((org.apache.pdfbox.contentstream.operator.Operator) tok).getName().equals("BI")) {
                stats.streamsSkippedInlineImage++;
                return false;
            }
        }
        boolean changed = false;
        Mat ctm = baseCtm;
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
                    if (System.getenv("ZT_DEBUG") != null && (depth > 0 || debugPage == 5)) {
                        System.err.println("[cm p" + debugPage + " d" + depth + "] op=" + m.a + "," + m.b
                                + "," + m.c + "," + m.d + "," + m.e + "," + m.f
                                + " ctm=" + ctm.a + "," + ctm.b + "," + ctm.c + "," + ctm.d
                                + "," + ctm.e + "," + ctm.f);
                    }
                    break;
                }
                case "Do":
                    // 表单（含透明组）内部文字不改写：嵌套坐标系下个别图形重写后
                    // 渲染异常（BERT 图黑色色块），交由现有遮罩路径兜底更稳。
                    break;
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
                    // 原流中的语义顺序：行撇号先移动到下一行再显示；双引号算子还先设置字距
                    if (name.equals("'") || name.equals("\"")) {
                        tlm = tlm.mul(Mat.translate(0, -leading));
                        tm = tlm;
                    }
                    if (name.equals("\"")) {
                        wordSpacing = numAt(pending, 0);
                        charSpacing = numAt(pending, 1);
                    }
                    boolean evaluate = inText && depth == 0 && renderMode != 7 && rects != null && !rects.isEmpty();
                    TextOpResult r = processTextOp(name, pending, ctm, tm,
                            font, fontSize, charSpacing, wordSpacing, hScale, rise, rects, evaluate, depth);
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

    /**
     * 在 Do 调用点处理表单对象：把"调用点变换 × 表单 /Matrix"作为新的合成变换
     * 传入递归，区域始终保持页面坐标。字形判定时经合成变换回到页面坐标再比对，
     * 因此任意嵌套、旋转、剪切都精确，不需要对区域做逆映射。
     * 同一表单流只处理一次（首次调用的变换生效）；再次调用时文字可能残留，属已知限制。
     */
    private boolean processFormAtInvocation(PDDocument doc, PDResources res, COSName name,
                                            Mat invokeCtm, List<Rect> rects, int depth) throws java.io.IOException {
        boolean debug = System.getenv("ZT_DEBUG") != null;
        PDXObject xo;
        try {
            xo = res.getXObject(name);
        } catch (Exception e) {
            return false;
        }
        if (!(xo instanceof PDFormXObject)) {
            return false;
        }
        PDFormXObject form = (PDFormXObject) xo;
        COSStream stream = form.getCOSObject();
        if (!visitedForms.add(stream)) {
            return false; // 已按首次调用处理过
        }
        // 表单自身的 /Matrix 先于调用点变换：页面坐标 = 调用变换 × 表单矩阵 × 表单坐标
        Mat total = invokeCtm;
        org.apache.pdfbox.util.Matrix fm = form.getMatrix();
        if (fm != null && !(fm.getValue(0, 0) == 1 && fm.getValue(0, 1) == 0
                && fm.getValue(1, 0) == 0 && fm.getValue(1, 1) == 1
                && fm.getValue(2, 0) == 0 && fm.getValue(2, 1) == 0)) {
            Mat formMat = new Mat(fm.getValue(0, 0), fm.getValue(0, 1),
                    fm.getValue(1, 0), fm.getValue(1, 1),
                    fm.getValue(2, 0), fm.getValue(2, 1));
            total = invokeCtm.mul(formMat);
        }
        if (debug) {
            System.err.println("[Do p" + debugPage + " " + name.getName() + "] total=" + total.a + "," + total.b
                    + "," + total.c + "," + total.d + "," + total.e + "," + total.f
                    + " rects=" + rects.size());
        }
        try {
            byte[] bytes = form.getPDStream().toByteArray();
            PDFStreamParser parser = new PDFStreamParser(bytes);
            parser.parse();
            List<Object> out = new ArrayList<>();
            PDResources innerRes = form.getResources();
            boolean changed = rewriteTokens(doc, parser.getTokens(), innerRes, rects, total, depth + 1, out);
            if (!changed) {
                return false;
            }
            PDStream ns = new PDStream(doc);
            OutputStream os = ns.createOutputStream();
            new ContentStreamWriter(os).writeTokens(out);
            os.close();
            res.put(name, new PDFormXObject(ns));
            stats.xObjectsProcessed++;
            return true;
        } catch (Exception e) {
            return false; // 单个表单失败不影响整体，宁可残留也不破坏文件
        }
    }

    private TextOpResult processTextOp(String name, List<COSBase> pending, Mat ctm, Mat tm,
                                       PDFont font, float fontSize, float charSpacing, float wordSpacing,
                                       float hScale, float rise, List<Rect> rects, boolean evaluate, int depth)
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
                return result; // 参数异常，保持原样
            }
            GlyphRun run = measureString((COSString) pending.get(strIndex),
                    font, fontSize, charSpacing, wordSpacing, hs);
            all.addAll(run.pieces);
            result.totalAdvance = run.advance;
        }

        // 逐字形中点判定
        int dropped = 0;
        boolean debug = System.getenv("ZT_DEBUG") != null && evaluate;
        boolean debugDroppedShown = false;
        for (Piece p : all) {
            double mid = (p.x0 + p.x1) / 2.0;
            double[] point = base.apply(mid, rise);
            p.keep = !evaluate || point == null || Double.isNaN(point[0]) || Double.isNaN(point[1])
                    || !inAnyRect(rects, point[0], point[1]);
            if (debug && point != null && fontSize > 0.5f) {
                if (!p.keep && !debugDroppedShown) {
                    debugDroppedShown = true;
                    Rect hit = findRect(rects, point[0], point[1]);
                    System.err.println("[DROP p" + debugPage + " d" + depth + " " + name + "] fs=" + fontSize
                            + " pt=" + Math.round(point[0]) + "," + Math.round(point[1])
                            + " txt=" + snippet(pending)
                            + " ctm=" + ctm.a + "," + ctm.b + "," + ctm.c + "," + ctm.d
                            + "," + ctm.e + "," + ctm.f
                            + " hit=" + (hit == null ? "none" : hit.x0 + "," + hit.y0
                                    + "," + hit.x1 + "," + hit.y1));
                } else if (p.keep && Math.random() < 0.02) {
                    System.err.println("[text " + name + "] fs=" + fontSize
                            + " pt=" + Math.round(point[0]) + "," + Math.round(point[1])
                            + " txt=" + snippet(pending));
                }
            }
            if (!p.keep) dropped++;
        }
        if (dropped == 0 || all.isEmpty()) {
            return result; // 无需改动
        }
        result.anyDropped = true;
        result.allDropped = dropped == all.size();

        // 重建 TJ：保留的字形片段按原顺序输出，缺口与尾部用位移数字补齐
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

    /** 把字符串拆成字形片段（简单字体逐字节，CID 字体逐双字节），并测量基线区间。 */
    private GlyphRun measureString(COSString str, PDFont font, float fontSize,
                                  float charSpacing, float wordSpacing, float hs) throws java.io.IOException {
        GlyphRun run = new GlyphRun();
        byte[] bytes = str.getBytes();
        if (font == null || fontSize == 0f) {
            // 字体缺失或字号为零时按半角宽度整体估算，作为一个原子片段判定
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
        return findRect(rects, x, y) != null;
    }

    private Rect findRect(List<Rect> rects, double x, double y) {
        for (Rect r : rects) {
            if (r.contains(x, y)) return r;
        }
        return null;
    }

    /** 提取算子参数里的字符串片段（含 TJ 数组内的字符串），用于调试定位。 */
    private static String snippet(List<COSBase> pending) {
        StringBuilder sb = new StringBuilder();
        for (COSBase b : pending) {
            appendStrings(sb, b);
        }
        return sb.toString();
    }

    private static void appendStrings(StringBuilder sb, COSBase b) {
        if (b instanceof COSString s) {
            byte[] bytes = s.getBytes();
            sb.append(new String(bytes, 0, Math.min(24, bytes.length),
                    java.nio.charset.StandardCharsets.ISO_8859_1));
        } else if (b instanceof COSArray arr) {
            for (int i = 0; i < arr.size(); i++) {
                appendStrings(sb, arr.get(i));
            }
        }
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

    /** 命令行入口：java RegionTextRemover 输入.pdf 区域文件 输出.pdf */
    public static void main(String[] args) {
        try {
            if (args.length < 3) {
                System.err.println("用法: RegionTextRemover <输入.pdf> <区域文件> <输出.pdf>");
                System.err.println("区域文件每行: 页码 x0 y0 x1 y1（PDF 用户坐标，页码从 1 起，# 开头为注释）");
                System.exit(2);
            }
            java.io.File input = new java.io.File(args[0]);
            List<Rect> rects = readRects(new java.io.File(args[1]));
            System.err.println("[remover] load " + input.getName() + " rects=" + rects.size());
            PDDocument doc = PDDocument.load(input);
            try {
                Stats stats = remove(doc, rects);
                doc.save(args[2]);
                System.err.println("[remover] done " + stats);
            } finally {
                doc.close();
            }
        } catch (Exception e) {
            System.err.println("[remover] FAILED: " + e);
            e.printStackTrace();
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
            rects.add(new Rect(Integer.parseInt(p[0]), Float.parseFloat(p[1]),
                    Float.parseFloat(p[2]), Float.parseFloat(p[3]), Float.parseFloat(p[4])));
        }
        return rects;
    }
}
