import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.pdfparser.PDFStreamParser;

import java.io.File;

/** 查看某页字体清单与内容流中文字相关算子的排布样本。 */
public final class PageFontDump {
    public static void main(String[] args) throws Exception {
        int pageNo = Integer.parseInt(args[0]);
        try (PDDocument doc = PDDocument.load(new File(args[1]))) {
            var page = doc.getPage(pageNo - 1);
            var res = page.getResources();
            for (COSName fn : res.getFontNames()) {
                PDFont font = res.getFont(fn);
                System.out.println("font " + fn.getName() + ": " + font.getClass().getSimpleName()
                        + " sub=" + font.getSubType()
                        + " base=" + font.getName()
                        + " avg=" + font.getAverageFontWidth());
            }
            try (var in = page.getContents()) {
                byte[] bytes = in.readAllBytes();
                System.out.println("stream bytes=" + bytes.length);
                PDFStreamParser p = new PDFStreamParser(bytes);
                p.parse();
                var toks = p.getTokens();
                // 找出所有 Tf 算子的字体名与字号，统计各字体承担的显示算子数
                java.util.Map<String, Integer> showByFont = new java.util.LinkedHashMap<>();
                String cur = "?";
                COSBase prev1 = null, prev2 = null;
                int show = 0, other = 0;
                for (Object t : toks) {
                    if (t instanceof org.apache.pdfbox.contentstream.operator.Operator op) {
                        String nm = op.getName();
                        if (nm.equals("Tf") && prev2 instanceof COSName cn) {
                            cur = cn.getName() + "@" + prev1;
                        }
                        if (nm.equals("Tj") || nm.equals("TJ") || nm.equals("'") || nm.equals("\"")) {
                            show++;
                            showByFont.merge(cur, 1, Integer::sum);
                        }
                        prev1 = null; prev2 = null;
                    } else {
                        prev2 = prev1; prev1 = (COSBase) t;
                    }
                }
                System.out.println("total show ops=" + show);
                System.out.println("by font: " + showByFont);
            }
        }
    }
}
