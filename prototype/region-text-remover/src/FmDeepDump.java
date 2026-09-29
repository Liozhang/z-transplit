import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSString;

import java.io.File;

/** 深入页面表单包装，转储透明组内的字体与文字算子排布。 */
public final class FmDeepDump {
    public static void main(String[] args) throws Exception {
        int pageNo = Integer.parseInt(args[0]);
        String wrapper = args[2]; // 例如 Fm2
        try (PDDocument doc = PDDocument.load(new File(args[1]))) {
            var page = doc.getPage(pageNo - 1);
            var xo = page.getResources().getXObject(COSName.getPDFName(wrapper));
            if (!(xo instanceof PDFormXObject f)) {
                System.out.println("not a form");
                return;
            }
            COSName inner = null;
            try (var in = f.getContents()) {
                byte[] bytes = in.readAllBytes();
                PDFStreamParser p = new PDFStreamParser(bytes);
                p.parse();
                COSBase prev = null;
                for (Object t : p.getTokens()) {
                    if (t instanceof org.apache.pdfbox.contentstream.operator.Operator op
                            && op.getName().equals("Do") && prev instanceof COSName cn) {
                        inner = cn;
                    }
                    if (t instanceof COSBase b) prev = b;
                }
            }
            System.out.println("wrapper " + wrapper + " -> " + inner);
            PDFormXObject group = (PDFormXObject) f.getResources()
                    .getXObject(inner == null ? COSName.getPDFName("Im5") : inner);
            var gres = group.getResources();
            for (COSName fn : gres.getFontNames()) {
                var font = gres.getFont(fn);
                System.out.println("font " + fn.getName() + ": " + font.getClass().getSimpleName()
                        + " sub=" + font.getSubType() + " base=" + font.getName());
            }
            try (var in = group.getContents()) {
                byte[] bytes = in.readAllBytes();
                System.out.println("stream bytes=" + bytes.length);
                PDFStreamParser p = new PDFStreamParser(bytes);
                p.parse();
                java.util.List<COSBase> pending = new java.util.ArrayList<>();
                int shown = 0;
                for (Object t : p.getTokens()) {
                    if (t instanceof COSBase b) {
                        pending.add(b);
                        continue;
                    }
                    if (t instanceof org.apache.pdfbox.contentstream.operator.Operator op) {
                        String nm = op.getName();
                        if (nm.equals("Tf") || nm.equals("Tm") || nm.equals("Td") || nm.equals("Tr")
                                || nm.equals("Tj") || nm.equals("TJ") || nm.equals("BT") || nm.equals("ET")) {
                            StringBuilder sb = new StringBuilder("  " + nm + " ");
                            for (COSBase b : pending) {
                                if (b instanceof COSString s) {
                                    byte[] bs = s.getBytes();
                                    sb.append("(").append(new String(bs, 0, Math.min(8, bs.length),
                                            java.nio.charset.StandardCharsets.ISO_8859_1)).append(") ");
                                } else {
                                    sb.append(b.toString()).append(" ");
                                }
                            }
                            System.out.println(sb);
                            if (++shown > 40) return;
                        }
                        pending.clear();
                    }
                }
            }
        }
    }
}
