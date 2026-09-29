import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.contentstream.operator.Operator;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** 对比同一页面在两个 PDF 中的算子名序列，找出往返改写后第一个分歧点。 */
public final class OpDiff {
    public static void main(String[] args) throws Exception {
        int pageNo = Integer.parseInt(args[0]);
        List<String> opsA = ops(args[1], pageNo);
        List<String> opsB = ops(args[2], pageNo);
        System.out.println("ops: before=" + opsA.size() + " after=" + opsB.size());
        int n = Math.min(opsA.size(), opsB.size());
        for (int i = 0; i < n; i++) {
            if (!opsA.get(i).equals(opsB.get(i))) {
                System.out.println("FIRST DIVERGENCE at op #" + i);
                System.out.println("before: " + context(opsA, i));
                System.out.println("after : " + context(opsB, i));
                return;
            }
        }
        if (opsA.size() != opsB.size()) {
            System.out.println("TAIL: before has extra ops from #" + n);
            System.out.println("before: " + context(opsA, n));
        } else {
            System.out.println("IDENTICAL operator sequences");
        }
    }

    private static String context(List<String> ops, int i) {
        StringBuilder sb = new StringBuilder();
        for (int j = Math.max(0, i - 6); j < Math.min(ops.size(), i + 8); j++) {
            sb.append(j == i ? ">>" : " ").append(ops.get(j)).append(" ");
        }
        return sb.toString();
    }

    private static List<String> ops(String pdf, int pageNo) throws Exception {
        List<String> names = new ArrayList<>();
        try (PDDocument doc = PDDocument.load(new File(pdf));
             var in = doc.getPage(pageNo - 1).getContents()) {
            byte[] bytes = in.readAllBytes();
            PDFStreamParser p = new PDFStreamParser(bytes);
            p.parse();
            for (Object t : p.getTokens()) {
                if (t instanceof Operator op) {
                    names.add(op.getName());
                }
            }
        }
        return names;
    }
}
