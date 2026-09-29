import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.cos.COSName;

import java.io.File;

/** 剖析某页各表单对象的内部结构：矩阵、字体、嵌套对象与内容流开头。 */
public final class FmDump {
    public static void main(String[] args) throws Exception {
        int pageNo = Integer.parseInt(args[0]);
        try (PDDocument doc = PDDocument.load(new File(args[1]))) {
            var page = doc.getPage(pageNo - 1);
            var res = page.getResources();
            for (COSName n : res.getXObjectNames()) {
                var xo = res.getXObject(n);
                System.out.println("== " + n.getName() + " type=" + xo.getClass().getSimpleName());
                if (!(xo instanceof org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject f)) continue;
                System.out.println("   matrix=" + f.getMatrix());
                var fres = f.getResources();
                if (fres != null) {
                    for (COSName fn : fres.getFontNames()) System.out.println("   font: " + fn.getName());
                    for (COSName xn : fres.getXObjectNames()) {
                        System.out.println("   xobj: " + xn.getName() + " "
                                + fres.getXObject(xn).getClass().getSimpleName());
                    }
                }
                try (var in = f.getContents()) {
                    byte[] bytes = in.readAllBytes();
                    System.out.println("   stream bytes=" + bytes.length);
                    String s = new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1);
                    System.out.println("   head: " + s.substring(0, Math.min(260, s.length())).replace("\n", " | "));
                }
            }
        }
    }
}
