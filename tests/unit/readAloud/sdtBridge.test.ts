/**
 * sdtBridge#collectBlocks tests — the block inventory rules over a fabricated
 * SDT container (top-level tags, ref-path presence, reference skipping,
 * whitespace filtering).
 */

import { describe, expect, it } from "vitest";
import { collectBlocks } from "../../../src/core/pdf/sdt/sdtBridge";

function fakeEl(opts: {
  tag: string;
  refPath?: string;
  text?: string;
  reference?: boolean;
}): any {
  return {
    tagName: opts.tag.toUpperCase(),
    dataset: opts.refPath === undefined ? {} : { refPath: opts.refPath },
    classList: {
      contains: (cls: string) => cls === "sdt-reference" && !!opts.reference,
    },
    innerText: opts.text ?? "",
    textContent: opts.text ?? "",
  };
}

function container(children: any[]): any {
  return { children };
}

describe("sdtBridge#collectBlocks", () => {
  it("collects translatable top-level blocks with their ref-path", () => {
    const blocks = collectBlocks(container([
      fakeEl({ tag: "p", refPath: "0", text: "First paragraph text." }),
      fakeEl({ tag: "h2", refPath: "1", text: "2. Methods" }),
      fakeEl({ tag: "figcaption", refPath: "2", text: "Figure 1: results." }),
    ]) as any);
    expect(blocks.map((b) => b.refPath)).toEqual(["0", "1", "2"]);
    expect(blocks[1].text).toBe("2. Methods");
  });

  it("skips non-translatable containers (tables, lists, images, math)", () => {
    const blocks = collectBlocks(container([
      fakeEl({ tag: "p", refPath: "0", text: "Real paragraph." }),
      fakeEl({ tag: "table", refPath: "1", text: "aggregated cell text" }),
      fakeEl({ tag: "ul", refPath: "2", text: "list items aggregated" }),
      fakeEl({ tag: "figure", refPath: "3", text: "" }),
      fakeEl({ tag: "div", refPath: "4", text: "math" }),
    ]) as any);
    expect(blocks.map((b) => b.refPath)).toEqual(["0"]);
  });

  it("skips the reference section and whitespace-only blocks", () => {
    const blocks = collectBlocks(container([
      fakeEl({ tag: "p", refPath: "0", text: "Body text." }),
      fakeEl({ tag: "p", refPath: "1", text: "[1] Author, Title (2020).", reference: true }),
      fakeEl({ tag: "p", refPath: "2", text: "   " }),
      fakeEl({ tag: "p", text: "no ref path" }),
    ]) as any);
    expect(blocks.map((b) => b.refPath)).toEqual(["0"]);
  });
});
