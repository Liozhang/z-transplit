import { describe, expect, it } from "vitest";
import { toErrorMessage } from "../../src/utils/error";
import { parseJsonFromMarkdown } from "../../src/utils/json";
import { getString, getLocaleID } from "../../src/utils/locale";
import { truncate } from "../../src/utils/truncate";

describe("toErrorMessage", () => {
  it("unwraps Error, string, number and unknown values", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
    expect(toErrorMessage("plain")).toBe("plain");
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage({ a: 1 }, "fallback")).toBe("fallback");
  });
});

describe("truncate", () => {
  it("returns the input untouched when it fits", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("appends the default suffix when slicing", () => {
    expect(truncate("abcdef", 3)).toBe("abc...");
  });

  it("honours a custom suffix, a transform and tail mode", () => {
    expect(truncate("abcdef", 3, { suffix: "…" })).toBe("abc…");
    expect(truncate("<b>abcdef</b>", 3, { transform: (s) => s.replace(/<[^>]+>/g, "") })).toBe(
      "abc...",
    );
    expect(truncate("abcdef", 3, { tail: true })).toBe("...def");
  });
});

describe("parseJsonFromMarkdown", () => {
  it("reads a fenced json block", () => {
    expect(parseJsonFromMarkdown('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("falls back to bare JSON and then to the first object in prose", () => {
    expect(parseJsonFromMarkdown('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonFromMarkdown('sure: {"a":1} — done')).toEqual({ a: 1 });
  });

  it("returns null for empty or unparseable input", () => {
    expect(parseJsonFromMarkdown("")).toBeNull();
    expect(parseJsonFromMarkdown("not json at all")).toBeNull();
  });
});

describe("getString", () => {
  it("builds the prefixed Fluent id", () => {
    expect(getLocaleID("pane-title")).toBe("ztransplit-pane-title");
  });

  it("falls back to the prefixed id when the locale is not initialized", () => {
    expect(getString("pane-title")).toBe("ztransplit-pane-title");
  });

  it("formats messages through the stubbed Localization instance", () => {
    const previous = (globalThis as any)._globalThis;
    (globalThis as any)._globalThis = {
      addon: {
        data: {
          locale: {
            current: {
              formatMessagesSync: (messages: { id: string }[]) =>
                messages.map((m) =>
                  m.id === "ztransplit-pane-title"
                    ? { value: "Translation", attributes: [] }
                    : undefined,
                ),
            },
          },
        },
      },
    };
    try {
      expect(getString("pane-title")).toBe("Translation");
      expect(getString("missing")).toBe("ztransplit-missing");
    } finally {
      (globalThis as any)._globalThis = previous;
    }
  });
});
