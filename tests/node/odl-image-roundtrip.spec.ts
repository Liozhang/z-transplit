/**
 * odl-image-roundtrip.spec — End-to-end image preservation test on a REAL
 * OpenDataLoader JSON output (a fixture generated from a PDF that actually
 * contains embedded raster images).
 *
 * This closes the verification gap left by odl-to-assembly.spec.ts (which used
 * synthetic fixtures): it confirms that on a real ODL parse with
 * `--image-output embedded`, the full chain
 *
 *   real ODL JSON → adaptOpenDataLoaderJson → odlAnalysisToAssembly
 *     → renderLayoutPreserving
 *
 * actually (a) recovers the image elements with their base64 data + bbox, and
 * (b) embeds those images as XObjects in the rendered translated PDF.
 *
 * Fixture: tests/node/fixtures/odl-with-images.json (copied from leadero, real
 * `java -jar opendataloader-pdf-cli.jar --format json --image-output embedded`
 * output — pages 17–21 of Li et al. 2023, containing 4 image elements).
 *
 * Ported from leadero's tests/node/odl-image-roundtrip.spec.ts (import paths
 * unchanged). Run: npm run test:unit -- odl-image-roundtrip
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { adaptOpenDataLoaderJson } from "../../src/core/pdf/OpenDataLoaderJsonAdapter";
import { odlAnalysisToAssembly } from "../../src/core/pdf/translation/odlToAssembly";
import { renderLayoutPreserving } from "../../src/core/pdf/translation/LayoutPreservingRenderer";

const FIXTURE = path.join(__dirname, "fixtures", "odl-with-images.json");

function loadFixture(): any {
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(
      `Fixture missing: ${FIXTURE}. Generate it with the ODL jar (--image-output embedded) on an image-bearing PDF.`,
    );
  }
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
}

describe("ODL image round-trip (real fixture)", () => {
  it("adaptOpenDataLoaderJson preserves image elements with data + bbox", () => {
    const root = loadFixture();
    const analysis = adaptOpenDataLoaderJson(root);

    expect(analysis.source).toBe("tier2-opendataloader-pdf");
    expect(analysis.pages.length).toBeGreaterThan(0);

    // Count images across all pages (they land in chartAreas with imageDataUri).
    const imagesWith = analysis.allChartAreas.filter((c) => c.imageDataUri);
    expect(
      imagesWith.length,
      "fixture should contain image elements with data",
    ).toBeGreaterThanOrEqual(1);

    for (const img of imagesWith) {
      // bbox is a real rectangle (PDF points).
      expect(img.bbox.width).toBeGreaterThan(0);
      expect(img.bbox.height).toBeGreaterThan(0);
      // data is a base64 PNG data URI.
      expect(img.imageDataUri).toMatch(/^data:image\/png;base64,/);
    }
  });

  it("odlAnalysisToAssembly extracts images into AssemblyResult.images", () => {
    const root = loadFixture();
    const analysis = adaptOpenDataLoaderJson(root);
    const { assemblies } = odlAnalysisToAssembly(analysis);

    const totalImages = assemblies.reduce(
      (n, a) => n + (a.images?.length ?? 0),
      0,
    );
    expect(totalImages).toBeGreaterThanOrEqual(1);

    // Find a page that has images and verify the mapping.
    const pageWithImages = assemblies.find((a) => a.images && a.images.length);
    expect(pageWithImages).toBeDefined();
    const img = pageWithImages!.images![0];
    expect(img.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(img.bbox.width).toBeGreaterThan(0);
    expect(img.bbox.height).toBeGreaterThan(0);
  });

  it("renderLayoutPreserving embeds the real images as XObjects in the PDF", async () => {
    const root = loadFixture();
    const analysis = adaptOpenDataLoaderJson(root);
    const { assemblies, pageSizes } = odlAnalysisToAssembly(analysis);

    // Render every page (translated text is stubbed — we care about images).
    let totalImagesRendered = 0;
    let totalImagesDropped = 0;
    let anyPageHasImageXobject = false;

    for (let i = 0; i < assemblies.length; i++) {
      const assembly = assemblies[i];
      // Stub translation: pass original text through (we only test image path).
      const translated = assembly.texts.slice();
      const result = await renderLayoutPreserving(assembly, translated, {
        targetLanguage: "zh-CN",
        pageWidth: pageSizes[i].width,
        pageHeight: pageSizes[i].height,
      });
      totalImagesRendered += result.stats.imagesRendered;
      totalImagesDropped += result.stats.imagesDropped;

      // If this page had images, verify the PDF bytes contain an image XObject.
      if (assembly.images && assembly.images.length > 0) {
        const pdfText = Buffer.from(result.bytes).toString("latin1");
        // A real embedded PNG shows up as a /Subtype /Image XObject with the
        // PNG IDAT signature somewhere in the stream.
        if (/\/Subtype\s*\/Image/.test(pdfText)) {
          anyPageHasImageXobject = true;
        }
        expect(result.bytes.length).toBeGreaterThan(10000);
      }
    }

    expect(
      totalImagesRendered,
      "at least one real image should render",
    ).toBeGreaterThanOrEqual(1);
    expect(totalImagesDropped).toBe(0);
    expect(anyPageHasImageXobject).toBe(true);
    // 真图 XObject 渲染实测 ~16s，30s 档在负载下会假红。
  }, 90_000);
});
