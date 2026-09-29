import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;

import java.io.File;
import java.io.OutputStream;

/** 往返一致性检验：把指定页的内容流原样解析再原样写回，不做任何删除。 */
public final class RoundTrip {
    public static void main(String[] args) throws Exception {
        try (PDDocument doc = PDDocument.load(new File(args[0]))) {
            int page = Integer.parseInt(args[2]) - 1;
            try (var in = doc.getPage(page).getContents()) {
                byte[] bytes = in.readAllBytes();
                PDFStreamParser parser = new PDFStreamParser(bytes);
                parser.parse();
                PDStream ns = new PDStream(doc);
                OutputStream os = ns.createOutputStream();
                new ContentStreamWriter(os).writeTokens(parser.getTokens());
                os.close();
                doc.getPage(page).setContents(ns);
            }
            doc.save(args[1]);
        }
        System.out.println("roundtrip done");
    }
}
