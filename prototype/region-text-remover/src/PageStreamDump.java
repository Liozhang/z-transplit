import org.apache.pdfbox.pdmodel.PDDocument;
import java.io.File;

/** 原样输出某页拼接后的内容流。 */
public final class PageStreamDump {
    public static void main(String[] args) throws Exception {
        int pageNo = Integer.parseInt(args[0]);
        try (PDDocument doc = PDDocument.load(new File(args[1]));
             var in = doc.getPage(pageNo - 1).getContents()) {
            byte[] bytes = in.readAllBytes();
            String s = new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1);
            System.out.println(s);
        }
    }
}
