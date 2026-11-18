/**
 * htmlTable 测试（src/core/pdf/scan/htmlTable.ts）。
 *
 * 解析器是 OCR 表格进入 IR 结构（PdfTable.rows）的唯一通道，钉住四类
 * 承诺：
 *   1. 结构忠实：colspan/rowspan 展开成网格，被挤位的行列起点正确；
 *   2. 文本可用：实体解码、行内标签剥除、空白归一；
 *   3. 畸形不崩：缺闭合标签、属性值带 >、未识别实体、嵌套表格、script；
 *   4. 预算有界：行/列/单元格/文本超限时判失败或截断，不做无界劳动。
 *
 * 纯函数测试，不碰宿主。
 */
import { describe, it, expect } from "vitest";
import {
  parseHtmlTable,
  MAX_CELL_TEXT_CHARS,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
} from "../../../../../src/core/pdf/scan/htmlTable";

/** 把解析结果压成"行 → [文本|跨度|列起点]"的扁平数组，断言更直观。 */
function shape(t: NonNullable<ReturnType<typeof parseHtmlTable>>) {
  return t.rows.map((r) =>
    r.cells.map((c) => `${c.text}|${c.colspan},${c.rowspan}@${c.col}`),
  );
}

describe("parseHtmlTable", () => {
  it("基本表格：行、单元格、网格规模", () => {
    const t = parseHtmlTable(
      "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>",
    );
    expect(shape(t!)).toEqual([
      ["甲|1,1@0", "乙|1,1@1"],
      ["丙|1,1@0", "丁|1,1@1"],
    ]);
    expect(t!.columns).toBe(2);
    expect(t!.gridRows).toBe(2);
  });

  it("thead/tbody/tfoot 与 th 一并按行收入", () => {
    const t = parseHtmlTable(
      "<table><thead><tr><th>列一</th><th>列二</th></tr></thead>" +
        "<tbody><tr><td>1</td><td>2</td></tr></tbody>" +
        "<tfoot><tr><td>计</td><td>3</td></tr></tfoot></table>",
    );
    expect(shape(t!)).toEqual([
      ["列一|1,1@0", "列二|1,1@1"],
      ["1|1,1@0", "2|1,1@1"],
      ["计|1,1@0", "3|1,1@1"],
    ]);
  });

  it("colspan：同行合并，列数按展开计", () => {
    const t = parseHtmlTable(
      "<table><tr><td>跨两列</td><td>单独</td></tr></table>".replace(
        "<td>跨两列</td>",
        '<td colspan="2">跨两列</td>',
      ),
    );
    expect(shape(t!)).toEqual([["跨两列|2,1@0", "单独|1,1@2"]]);
    expect(t!.columns).toBe(3);
    expect(t!.gridRows).toBe(1);
  });

  it("rowspan：下方行被挤到合并单元格之后", () => {
    const t = parseHtmlTable(
      "<table><tr><td rowspan=2>左侧</td><td>右上</td></tr>" +
        "<tr><td>右下</td></tr></table>",
    );
    expect(shape(t!)).toEqual([
      ["左侧|1,2@0", "右上|1,1@1"],
      ["右下|1,1@1"],
    ]);
    expect(t!.columns).toBe(2);
    expect(t!.gridRows).toBe(2);
  });

  it("rowspan 与 colspan 同时出现：网格占位互相挤压", () => {
    const t = parseHtmlTable(
      "<table><tr><td colspan=2 rowspan=2>角</td><td>顶</td></tr>" +
        "<tr><td>左</td><td>右</td></tr></table>",
    );
    expect(shape(t!)).toEqual([
      ["角|2,2@0", "顶|1,1@2"],
      ["左|1,1@2", "右|1,1@3"],
    ]);
    expect(t!.columns).toBe(4);
    expect(t!.gridRows).toBe(2);
  });

  it("实体解码：命名、十进制、十六进制；无法识别的保持原样", () => {
    const t = parseHtmlTable(
      "<table><tr><td>a &amp; b &lt; c &gt; d &#65; &#x42; &bogus; &amp</td></tr></table>",
    );
    expect(t!.rows[0].cells[0].text).toBe("a & b < c > d A B &bogus; &amp");
  });

  it("非法码点实体保持原样（不抛）", () => {
    const t = parseHtmlTable("<table><tr><td>&#x110000; &#xD800;</td></tr></table>");
    expect(t!.rows[0].cells[0].text).toBe("&#x110000; &#xD800;");
  });

  it("行内标签剥除，<br> 折成空格，空白跨行归一", () => {
    const t = parseHtmlTable(
      "<table><tr><td>\n  <b>粗</b>\n  <i>斜</i>\n</td>" +
        "<td>上<span>标</span><br>下一行</td></tr></table>",
    );
    expect(shape(t!)).toEqual([["粗 斜|1,1@0", "上标 下一行|1,1@1"]]);
  });

  it("缺 </td> 与 </tr>：下一格/下一行隐式闭合", () => {
    const t = parseHtmlTable("<table><tr><td>一<td>二<tr><td>三</table>");
    expect(shape(t!)).toEqual([
      ["一|1,1@0", "二|1,1@1"],
      ["三|1,1@0"],
    ]);
  });

  it("属性值里的 > 不当标签结束", () => {
    const t = parseHtmlTable(
      '<table><tr><td title="a>b">内容</td><td data-x=\'1>2\'>末</td></tr></table>',
    );
    expect(shape(t!)).toEqual([["内容|1,1@0", "末|1,1@1"]]);
  });

  it("没有 <table>、空表格、纯文本都判失败", () => {
    expect(parseHtmlTable("<div>不是表格</div>")).toBeNull();
    expect(parseHtmlTable("<table></table>")).toBeNull();
    expect(parseHtmlTable("<table><tr></tr></table>")).toBeNull();
    expect(parseHtmlTable("")).toBeNull();
    expect(parseHtmlTable(undefined as unknown as string)).toBeNull();
  });

  it("script/style 内的字符与结构标签都不计入单元格", () => {
    const t = parseHtmlTable(
      "<table><tr><td>前<script>var x = '<td>坏</td>';</script>后</td></tr></table>",
    );
    expect(shape(t!)).toEqual([["前后|1,1@0"]]);
  });

  it("嵌套表格的结构不并入外层行，文本仍留在宿主单元格", () => {
    const t = parseHtmlTable(
      "<table><tr><td>外层<table><tr><td>内一</td><td>内二</td></tr></table></td>" +
        "<td>右</td></tr></table>",
    );
    expect(shape(t!)).toEqual([["外层 内一 内二|1,1@0", "右|1,1@1"]]);
  });

  it("表格之后的内容被忽略（第一个表格结束即止）", () => {
    const t = parseHtmlTable(
      "<table><tr><td>甲</td></tr></table><p>之后</p><table><tr><td>乙</td></tr></table>",
    );
    expect(shape(t!)).toEqual([["甲|1,1@0"]]);
  });

  it("colspan 超界钳到列数上限", () => {
    const t = parseHtmlTable('<table><tr><td colspan="99999">宽</td></tr></table>');
    expect(t!.rows[0].cells[0].colspan).toBe(MAX_TABLE_COLUMNS);
    expect(t!.columns).toBe(MAX_TABLE_COLUMNS);
  });

  it("colspan 非法值退回 1", () => {
    const t = parseHtmlTable('<table><tr><td colspan="abc">x</td><td>y</td></tr></table>');
    expect(shape(t!)).toEqual([["x|1,1@0", "y|1,1@1"]]);
  });

  it("行数超预算判失败（整表退回只计数）", () => {
    const html =
      "<table>" + "<tr><td>x</td></tr>".repeat(MAX_TABLE_ROWS + 1) + "</table>";
    expect(parseHtmlTable(html)).toBeNull();
  });

  it("单元格数超预算判失败", () => {
    const cells = MAX_TABLE_CELLS + 1;
    const perRow = 100;
    const rows = Math.ceil(cells / perRow);
    const rowHtml = "<tr>" + "<td>x</td>".repeat(perRow) + "</tr>";
    const html = "<table>" + rowHtml.repeat(rows) + "</table>";
    expect(parseHtmlTable(html)).toBeNull();
  });

  it("单格文本超长截断而不是判失败", () => {
    const t = parseHtmlTable(`<table><tr><td>${"x".repeat(MAX_CELL_TEXT_CHARS + 500)}</td></tr></table>`);
    expect(t!.rows[0].cells[0].text).toHaveLength(MAX_CELL_TEXT_CHARS);
  });

  it("输入超长判失败", () => {
    const huge = "<table><tr><td>x</td></tr></table>" + " ".repeat(4_100_000);
    expect(parseHtmlTable(huge)).toBeNull();
  });

  it("缺 <tr> 的畸形输出：单元格自成一行", () => {
    const t = parseHtmlTable("<table><td>散</td><td>列</td></table>");
    expect(shape(t!)).toEqual([["散|1,1@0", "列|1,1@1"]]);
  });

  it("HTML 注释与 DOCTYPE 跳过", () => {
    const t = parseHtmlTable(
      "<!DOCTYPE html><!-- 注 --><table><tr><!-- 行内注 --><td>值</td></tr></table>",
    );
    expect(shape(t!)).toEqual([["值|1,1@0"]]);
  });
});
