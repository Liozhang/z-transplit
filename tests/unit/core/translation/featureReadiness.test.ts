/**
 * featureReadiness — engine-aware translation readiness tests.
 *
 * Ported from leadero's FeatureReadiness#checkTranslation coverage, minus the
 * "ai" branch (leadero routed it to the AI-model checklist; z-transplit has no
 * model registry). The zotero-pdf-translate cases pin the "must not crash
 * without the Zotero global" requirement, which only exists because these
 * modules also run under plain Node (vitest).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  checkTranslationReadiness,
  type PrefReader,
} from "../../../../src/core/translation/featureReadiness";

const savedZotero = (globalThis as any).Zotero;
const hadZotero = "Zotero" in (globalThis as any);

function reader(map: Record<string, unknown>): PrefReader {
  return (key: string) => map[key] as any;
}

afterEach(() => {
  // Restore whatever the environment had (tests may delete the global).
  if (hadZotero) (globalThis as any).Zotero = savedZotero;
  else delete (globalThis as any).Zotero;
});

describe("checkTranslationReadiness", () => {
  it("google is always ready (keyless endpoint + keyless Bing fallback)", () => {
    expect(checkTranslationReadiness(reader({}))).toEqual({
      ready: true,
      missing: [],
    });
    expect(
      checkTranslationReadiness(reader({ "translate.engineType": "google" })),
    ).toEqual({ ready: true, missing: [] });
  });

  it("bing/deepl need their apiKey", () => {
    expect(
      checkTranslationReadiness(reader({ "translate.engineType": "bing" })),
    ).toEqual({
      ready: false,
      missing: [
        {
          prefKey: "translate.bing.apiKey",
          reasonKey: "readiness-reason-engine-key",
        },
      ],
    });
    expect(
      checkTranslationReadiness(reader({ "translate.engineType": "deepl" })),
    ).toEqual({
      ready: false,
      missing: [
        {
          prefKey: "translate.deepl.apiKey",
          reasonKey: "readiness-reason-engine-key",
        },
      ],
    });
    expect(
      checkTranslationReadiness(
        reader({
          "translate.engineType": "deepl",
          "translate.deepl.apiKey": "k:fx",
        }),
      ),
    ).toEqual({ ready: true, missing: [] });
  });

  it("custom needs apiUrl AND apiKey", () => {
    expect(
      checkTranslationReadiness(reader({ "translate.engineType": "custom" })),
    ).toEqual({
      ready: false,
      missing: [
        {
          prefKey: "translate.custom.apiUrl",
          reasonKey: "readiness-reason-engine-url",
        },
        {
          prefKey: "translate.custom.apiKey",
          reasonKey: "readiness-reason-engine-key",
        },
      ],
    });
    expect(
      checkTranslationReadiness(
        reader({
          "translate.engineType": "custom",
          "translate.custom.apiUrl": "https://gw.example",
          "translate.custom.apiKey": "ck",
        }),
      ),
    ).toEqual({ ready: true, missing: [] });
  });

  it("zotero-pdf-translate: ready when the plugin API is present", () => {
    (globalThis as any).Zotero = {
      PDFTranslate: { api: { translate: async () => ({}) } },
    };
    expect(
      checkTranslationReadiness(
        reader({ "translate.engineType": "zotero-pdf-translate" }),
      ),
    ).toEqual({ ready: true, missing: [] });
  });

  it("zotero-pdf-translate: not ready when the plugin is missing (no crash)", () => {
    (globalThis as any).Zotero = {};
    expect(
      checkTranslationReadiness(
        reader({ "translate.engineType": "zotero-pdf-translate" }),
      ),
    ).toEqual({
      ready: false,
      missing: [
        {
          prefKey: "translate.engineType",
          reasonKey: "readiness-reason-engine-plugin",
        },
      ],
    });
  });

  it("zotero-pdf-translate: no Zotero global → not ready, never throws", () => {
    delete (globalThis as any).Zotero;
    expect(() =>
      checkTranslationReadiness(
        reader({ "translate.engineType": "zotero-pdf-translate" }),
      ),
    ).not.toThrow();
    expect(
      checkTranslationReadiness(
        reader({ "translate.engineType": "zotero-pdf-translate" }),
      ).ready,
    ).toBe(false);
  });

  it("unknown engine id is treated like custom (the dispatcher's fallback)", () => {
    expect(
      checkTranslationReadiness(reader({ "translate.engineType": "wat" })),
    ).toEqual({
      ready: false,
      missing: [
        {
          prefKey: "translate.custom.apiUrl",
          reasonKey: "readiness-reason-engine-url",
        },
        {
          prefKey: "translate.custom.apiKey",
          reasonKey: "readiness-reason-engine-key",
        },
      ],
    });
  });

  it("reads the real dynamic prefs when no reader is injected", async () => {
    // Default reader path: no Zotero global → empty prefs → google default.
    delete (globalThis as any).Zotero;
    expect(checkTranslationReadiness().ready).toBe(true);
  });
});
