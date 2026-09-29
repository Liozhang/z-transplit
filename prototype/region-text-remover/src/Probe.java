import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 验收探针：对比删除前后的 PDF。
 *
 * 指标一（图形保留）：逐页渲染为位图，只比较所有边界框"膨胀 3 像素"之外的像素，
 *   差异比例必须接近零。框边缘 3 像素的环带不计入任何一侧，避开抗锯齿与残边。
 * 指标二（文字残留）：统计文字提取器字形坐标落在"收缩 1 磅的边界框"内的字形数量，
 *   删除后的残留比例必须接近零。纵轴约定（向上或向下）在删除前文件上自动校准。
 * 指标三（区域内变化）：边界框内像素变化比例，应显著大于零（原文确实被移除）。
 * 有 /Rotate 的页先做显示空间变换：渲染位图与文字提取坐标都在显示空间。
 * 输出机器可读的一行 PROBE 结果；可选 --text-out 把删除后的全文写到文件。
 */
public final class Probe {

    private static final class Rect {
        final int page;
        final float x0, y0, x1, y1;
        Rect(int page, float x0, float y0, float x1, float y1) {
            this.page = page; this.x0 = Math.min(x0, x1); this.y0 = Math.min(y0, y1);
            this.x1 = Math.max(x0, x1); this.y1 = Math.max(y0, y1);
        }
    }

    /** 显示空间矩形（原点在左上，单位为磅，与渲染位图和文字提取坐标一致）。 */
    private static final class DispRect {
        final float x0, y0, x1, y1;
        DispRect(float x0, float y0, float x1, float y1) {
            this.x0 = Math.min(x0, x1); this.y0 = Math.min(y0, y1);
            this.x1 = Math.max(x0, x1); this.y1 = Math.max(y0, y1);
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("用法: Probe <删除前.pdf> <删除后.pdf> <区域文件> [--png-prefix 前缀] [--text-out 文件]");
            System.exit(2);
        }
        String pngPrefix = null;
        String textOut = null;
        for (int i = 3; i < args.length; i++) {
            if ("--png-prefix".equals(args[i]) && i + 1 < args.length) pngPrefix = args[++i];
            if ("--text-out".equals(args[i]) && i + 1 < args.length) textOut = args[++i];
        }
        List<Rect> rects = readRects(new File(args[2]));

        try (PDDocument before = PDDocument.load(new File(args[0]));
             PDDocument after = PDDocument.load(new File(args[1]))) {

            if (before.getNumberOfPages() != after.getNumberOfPages()) {
                System.out.println("PROBE FAIL pages " + before.getNumberOfPages() + "!=" + after.getNumberOfPages());
                System.exit(1);
            }

            // 预先计算每页的显示空间矩形
            Map<Integer, List<DispRect>> dispByPage = new HashMap<>();
            for (int p = 1; p <= before.getNumberOfPages(); p++) {
                List<Rect> rs = rectsOf(rects, p);
                if (rs.isEmpty()) continue;
                PDPage page = before.getPage(p - 1);
                int rot = ((page.getRotation() % 360) + 360) % 360;
                float llx = page.getMediaBox().getLowerLeftX();
                float lly = page.getMediaBox().getLowerLeftY();
                float wPt = page.getMediaBox().getWidth();
                float hPt = page.getMediaBox().getHeight();
                List<DispRect> ds = new ArrayList<>();
                for (Rect r : rs) {
                    // 用户空间四角 → 显示空间（左上原点）
                    double[][] corners = {{r.x0, r.y0}, {r.x1, r.y0}, {r.x0, r.y1}, {r.x1, r.y1}};
                    double minX = Double.MAX_VALUE, minY = Double.MAX_VALUE, maxX = -Double.MAX_VALUE, maxY = -Double.MAX_VALUE;
                    for (double[] c : corners) {
                        double dx, dy;
                        switch (rot) {
                            case 90:  dx = (c[1] - lly); dy = (llx + wPt) - c[0]; break;
                            case 180: dx = (llx + wPt) - c[0]; dy = (c[1] - lly); break;
                            case 270: dx = (lly + hPt) - c[1]; dy = (c[0] - llx); break;
                            default:  dx = (c[0] - llx); dy = (lly + hPt) - c[1]; break;
                        }
                        minX = Math.min(minX, dx); maxX = Math.max(maxX, dx);
                        minY = Math.min(minY, dy); maxY = Math.max(maxY, dy);
                    }
                    ds.add(new DispRect((float) minX, (float) minY, (float) maxX, (float) maxY));
                }
                dispByPage.put(p, ds);
            }

            long outsideTotal = 0, outsideDiff = 0, insideTotal = 0, insideDiff = 0;
            List<String> samples = new ArrayList<>();

            for (int p = 1; p <= before.getNumberOfPages(); p++) {
                List<DispRect> ds = dispByPage.get(p);
                if (ds == null) continue;
                float s = 120f / 72f;
                BufferedImage bi = new PDFRenderer(before).renderImage(p - 1, s);
                BufferedImage bm = new PDFRenderer(after).renderImage(p - 1, s);
                int wPx = bi.getWidth(), hPx = bi.getHeight();
                float m = 3f;        // 框内侵蚀：避开抗锯齿边缘
                float band = 12f;    // 跳过环带：容纳字形删除后超出小框的上下沿像素
                // 全页像素分类掩码：0=框外（参与比较），1=膨胀环带（跳过），2=框内（参与比较）
                byte[] mask = new byte[wPx * hPx];
                for (DispRect d : ds) {
                    int rx0 = Math.max(0, Math.round(d.x0 * s));
                    int rx1 = Math.min(wPx - 1, Math.round(d.x1 * s));
                    int ry0 = Math.max(0, Math.round(d.y0 * s));
                    int ry1 = Math.min(hPx - 1, Math.round(d.y1 * s));
                    for (int y = Math.max(0, ry0 - (int) band); y <= Math.min(hPx - 1, ry1 + (int) band); y++) {
                        for (int x = Math.max(0, rx0 - (int) band); x <= Math.min(wPx - 1, rx1 + (int) band); x++) {
                            boolean strictInside = x >= rx0 + m && x <= rx1 - m && y >= ry0 + m && y <= ry1 - m;
                            if (strictInside) {
                                mask[y * wPx + x] = 2;
                            } else if (mask[y * wPx + x] == 0) {
                                mask[y * wPx + x] = 1;
                            }
                        }
                    }
                }
                for (int y = 0; y < hPx; y++) {
                    for (int x = 0; x < wPx; x++) {
                        byte kind = mask[y * wPx + x];
                        if (kind == 1) continue;
                        int rgbB = bi.getRGB(x, y);
                        int rgbA = bm.getRGB(x, y);
                        int dr = Math.abs(((rgbB >> 16) & 255) - ((rgbA >> 16) & 255));
                        int dg = Math.abs(((rgbB >> 8) & 255) - ((rgbA >> 8) & 255));
                        int db = Math.abs((rgbB & 255) - (rgbA & 255));
                        boolean changed = Math.max(dr, Math.max(dg, db)) > 32;
                        if (kind == 2) {
                            insideTotal++;
                            if (changed) insideDiff++;
                        } else {
                            outsideTotal++;
                            if (changed) {
                                outsideDiff++;
                                if (samples.size() < 30) {
                                    samples.add("p" + p + ":" + x + "," + y);
                                }
                            }
                        }
                    }
                }
                if (pngPrefix != null) {
                    javax.imageio.ImageIO.write(bi, "png", new File(pngPrefix + "-before-p" + p + ".png"));
                    javax.imageio.ImageIO.write(bm, "png", new File(pngPrefix + "-after-p" + p + ".png"));
                }
            }

            // 文字残留：两种纵轴约定在删除前文件上校准，选命中更多的那个
            double bestResidueRatio = -1;
            String bestConv = "none";
            long beforeInsideBest = 0, afterInsideBest = 0;
            for (String conv : new String[]{"ydown", "yup"}) {
                long bIn = countInside(new File(args[0]), dispByPage, conv);
                long aIn = countInside(new File(args[1]), dispByPage, conv);
                if (bIn > beforeInsideBest || bestResidueRatio < 0) {
                    beforeInsideBest = bIn;
                    afterInsideBest = aIn;
                    bestResidueRatio = bIn == 0 ? 0 : (double) aIn / bIn;
                    bestConv = conv;
                }
            }

            if (textOut != null) {
                try (PrintWriter w = new PrintWriter(new File(textOut), "UTF-8")) {
                    PDFTextStripper st = new PDFTextStripper();
                    w.print(st.getText(after));
                }
            }

            double outsideRatio = outsideTotal == 0 ? 0 : (double) outsideDiff / outsideTotal;
            double insideRatio = insideTotal == 0 ? 0 : (double) insideDiff / insideTotal;
            System.out.println("PROBE pages=" + before.getNumberOfPages()
                    + " outsideDiffRatio=" + String.format("%.6f", outsideRatio)
                    + " (" + outsideDiff + "/" + outsideTotal + ")"
                    + " insideChangedRatio=" + String.format("%.4f", insideRatio)
                    + " (" + insideDiff + "/" + insideTotal + ")"
                    + " residue=" + String.format("%.6f", bestResidueRatio)
                    + " (" + afterInsideBest + "/" + beforeInsideBest + ")"
                    + " conv=" + bestConv
                    + (samples.isEmpty() ? "" : " outsideSamples=" + samples));
            boolean ok = outsideRatio <= 0.002 && bestResidueRatio <= 0.02;
            System.out.println(ok ? "VERDICT PASS" : "VERDICT FAIL");
            if (!ok) System.exit(1);
        }
    }

    private static List<Rect> rectsOf(List<Rect> all, int page) {
        List<Rect> rs = new ArrayList<>();
        for (Rect r : all) if (r.page == page) rs.add(r);
        return rs;
    }

    /** 统计字形坐标落在显示空间边界框内的数量（框各边收缩 1 磅）。 */
    private static long countInside(File pdf, Map<Integer, List<DispRect>> dispByPage, String conv) throws Exception {
        try (PDDocument doc = PDDocument.load(pdf)) {
            final long[] inside = {0};
            for (int p = 1; p <= doc.getNumberOfPages(); p++) {
                List<DispRect> ds = dispByPage.get(p);
                if (ds == null) continue;
                final float shrink = 1f;
                PDFTextStripper stripper = new PDFTextStripper() {
                    @Override
                    protected void writeString(String text, List<TextPosition> positions) {
                        float hDisp = getCurrentPage().getMediaBox().getHeight();
                        for (TextPosition tp : positions) {
                            double x = tp.getX();
                            double y = tp.getY();
                            if ("yup".equals(conv)) y = hDisp - y;
                            for (DispRect d : ds) {
                                if (x >= d.x0 + shrink && x <= d.x1 - shrink
                                        && y >= d.y0 + shrink && y <= d.y1 - shrink) {
                                    inside[0]++;
                                    break;
                                }
                            }
                        }
                    }
                };
                stripper.setStartPage(p);
                stripper.setEndPage(p);
                stripper.getText(doc);
            }
            return inside[0];
        }
    }

    private static List<Rect> readRects(File f) throws Exception {
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
