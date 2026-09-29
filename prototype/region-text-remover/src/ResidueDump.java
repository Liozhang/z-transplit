import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;

import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** 输出删除后仍落在边界框内的字形明细：页码、字符、坐标、字号，用于残留归因。 */
public final class ResidueDump {

    public static void main(String[] args) throws Exception {
        File pdf = new File(args[0]);
        List<double[]> rects = new ArrayList<>();
        for (String line : java.nio.file.Files.readAllLines(new File(args[1]).toPath())) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            String[] p = line.split("\\s+");
            rects.add(new double[]{Double.parseDouble(p[0]), Double.parseDouble(p[1]),
                    Double.parseDouble(p[2]), Double.parseDouble(p[3]), Double.parseDouble(p[4])});
        }
        Map<Integer, List<double[]>> byPage = new TreeMap<>();
        for (double[] r : rects) {
            byPage.computeIfAbsent((int) r[0], k -> new ArrayList<>()).add(r);
        }
        Map<Integer, Integer> perPage = new TreeMap<>();
        Map<String, Integer> samples = new LinkedHashMap<>();
        try (PDDocument doc = PDDocument.load(pdf)) {
            for (int pg = 1; pg <= doc.getNumberOfPages(); pg++) {
                List<double[]> rs = byPage.get(pg);
                if (rs == null) continue;
                final int pageNum = pg;
                PDFTextStripper st = new PDFTextStripper() {
                    @Override
                    protected void writeString(String text, List<TextPosition> positions) {
                        for (TextPosition tp : positions) {
                            double x = tp.getX();
                            double dy = tp.getY(); // 距页面顶部的距离（磅）
                            for (double[] r : rs) {
                                double x0 = r[1], y1raw = r[2], x1 = r[3], y0raw = r[4];
                                double dy0 = 792 - y0raw < 792 - y1raw ? 792 - y0raw : 792 - y1raw;
                                double dy1 = 792 - y0raw > 792 - y1raw ? 792 - y0raw : 792 - y1raw;
                                if (x >= x0 + 1 && x <= x1 - 1 && dy >= dy0 + 1 && dy <= dy1 - 1) {
                                    perPage.merge(pageNum, 1, Integer::sum);
                                    String key = "p" + pageNum + " [" + tp.getUnicode() + "]"
                                            + " x=" + Math.round(x) + " dy=" + Math.round(dy)
                                            + " fs=" + Math.round(tp.getFontSizeInPt())
                                            + " rect=[" + Math.round(x0) + "," + Math.round(792 - y1raw)
                                            + "," + Math.round(x1) + "," + Math.round(792 - y0raw) + "]";
                                    samples.merge(key, 1, Integer::sum);
                                    break;
                                }
                            }
                        }
                    }
                };
                st.setStartPage(pg);
                st.setEndPage(pg);
                st.getText(doc);
            }
        }
        System.out.println("RESIDUE_PER_PAGE " + perPage);
        int shown = 0;
        for (Map.Entry<String, Integer> e : samples.entrySet()) {
            System.out.println(e.getKey() + " x" + e.getValue());
            if (++shown >= 40) break;
        }
    }
}
