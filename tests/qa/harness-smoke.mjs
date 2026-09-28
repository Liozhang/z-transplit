/**
 * harness-smoke.mjs — Functional smoke test for the QA harness itself.
 *
 * Runs under Node 22 with --experimental-strip-types so it can import the .ts
 * harness directly. Proves the mocks behave as advertised BEFORE they are used
 * to test the plugin: a mock bug found here is cheap, a mock bug found later
 * looks like a plugin bug.
 *
 *   node --experimental-strip-types harness-smoke.mjs
 */
import assert from "node:assert/strict";
import { createZoteroMock } from "./harness/zotero-mock.ts";
import { createFetchMock } from "./harness/fetch-mock.ts";

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// ── Zotero mock ──
await check("prefs: load + read + write", () => {
  const z = createZoteroMock({ prefs: { "translate.enabled": true, "translate.maxChars": 100 } });
  assert.equal(z.Zotero.Prefs.get("extensions.zotero.ztransplit.translate.enabled"), true);
  z.Zotero.Prefs.set("extensions.zotero.ztransplit.translate.auto", true);
  assert.equal(z.Zotero.Prefs.get("extensions.zotero.ztransplit.translate.auto"), true);
  assert.equal(z.prefs.writes.length, 1);
});

await check("locale + debug captured", () => {
  const z = createZoteroMock({ locale: "en-US" });
  assert.equal(z.Zotero.locale, "en-US");
  z.Zotero.debug("hello");
  assert.deepEqual(z.debugLines, ["hello"]);
});

await check("platform flags forceable (win/mac/linux)", () => {
  assert.equal(createZoteroMock({ platform: "win" }).Zotero.isWin, true);
  assert.equal(createZoteroMock({ platform: "win" }).Zotero.platform, "win32");
  assert.equal(createZoteroMock({ platform: "mac" }).Zotero.isMac, true);
  assert.equal(createZoteroMock({ platform: "mac" }).Zotero.platform, "macosx");
  assert.equal(createZoteroMock({ platform: "linux" }).Zotero.isWin, false);
  assert.equal(createZoteroMock({ platform: "linux" }).Zotero.platform, "linux");
});

await check("PDFTranslate toggleable (present / absent)", async () => {
  const calls = [];
  const present = createZoteroMock({
    pdfTranslate: {
      translate: async (text, opts) => {
        calls.push({ text, opts });
        return { status: "success", result: "你好" };
      },
    },
  });
  const task = await present.Zotero.PDFTranslate.translate("hello", {
    langfrom: "auto",
    langto: "zh-CN",
  });
  assert.equal(task.status, "success");
  assert.equal(task.result, "你好");
  assert.equal(calls[0].text, "hello");
  assert.equal(calls[0].opts.langto, "zh-CN");
  assert.equal(createZoteroMock({ pdfTranslate: null }).Zotero.PDFTranslate, null);
});

await check("ItemPaneManager.registerSection spy records config", () => {
  const z = createZoteroMock();
  const id = z.Zotero.ItemPaneManager.registerSection({ paneID: "ztransplit-translate" });
  assert.equal(id, "ztransplit-translate");
  assert.equal(z.registeredPanes.length, 1);
  assert.equal(z.registeredPanes[0].header, undefined);
});

await check("Reader selection stub plumbing + install/uninstall round-trip", () => {
  const z = createZoteroMock();
  z.reader = { tabID: 7, selectionRanges: [{ text: "hi " }, { text: "there" }] };
  z.install();
  globalThis.Zotero_Tabs.selectedID = 7;
  const reader = Zotero.Reader.getByTabID(7);
  const text = reader._internalReader._primaryView._selectionRanges.map((r) => r.text).join("");
  assert.equal(text, "hi there");
  assert.equal(Zotero.Reader.getByTabID(999), null);
  z.uninstall();
  assert.equal(globalThis.Zotero, undefined);
});

// ── fetch mock ──
await check("fetch: glob route + call recording + jsonBody", async () => {
  const fm = createFetchMock();
  fm.route("https://translation.googleapis.com/**").reply(200, {
    data: { translations: [{ translatedText: "你好" }] },
  });
  fm.install();
  const resp = await fetch("https://translation.googleapis.com/language/translate/v2?key=k", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: "hello", target: "zh-CN" }),
  });
  const data = await resp.json();
  assert.equal(data.data.translations[0].translatedText, "你好");
  assert.equal(fm.calls.length, 1);
  assert.equal(fm.calls[0].method, "POST");
  assert.equal(fm.jsonBody(fm.calls[0]).target, "zh-CN");
  assert.equal(fm.callsFor(/googleapis/).length, 1);
  fm.uninstall();
});

await check("fetch: `**` spans path segments + query string", async () => {
  const fm = createFetchMock();
  fm.route("https://translate.googleapis.com/translate_a/single?**").reply(200, [[["你好", "hello"]]]);
  fm.install();
  const resp = await fetch(
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=hello",
  );
  assert.deepEqual(await resp.json(), [[["你好", "hello"]]]);
  fm.uninstall();
});

await check("fetch: form body decoding (Bing web style)", async () => {
  const fm = createFetchMock();
  fm.route("https://www.bing.com/**").reply(200, [{ translations: [{ text: "译文" }] }]);
  fm.install();
  await fetch("https://www.bing.com/ttranslatev3", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ fromLang: "en", to: "zh-Hans", text: "hi" }).toString(),
  });
  const form = fm.formBody(fm.calls[0]);
  assert.equal(form.to, "zh-Hans");
  assert.equal(form.text, "hi");
  fm.uninstall();
});

await check("fetch: replySequence consumes in order", async () => {
  const fm = createFetchMock();
  fm.route("https://example.com/**").replySequence([
    { status: 200, body: 'IG:"ABC"' },
    { status: 200, body: { ok: true } },
  ]);
  fm.install();
  const first = await (await fetch("https://example.com/a")).text();
  const second = await (await fetch("https://example.com/b")).json();
  assert.equal(first, 'IG:"ABC"');
  assert.deepEqual(second, { ok: true });
  fm.uninstall();
});

await check("fetch: route failure throws (network-level)", async () => {
  const fm = createFetchMock();
  fm.route("https://down.test/**").throws(new Error("boom"));
  fm.install();
  await assert.rejects(() => fetch("https://down.test/x"), /boom/);
  fm.uninstall();
});

await check("fetch: unmatched route reports clearly", async () => {
  const fm = createFetchMock();
  fm.install();
  await assert.rejects(() => fetch("https://unrouted.test/x"), /no route matched/);
  fm.uninstall();
});

await check("fetch: .once limits route (fallback-chain evidence)", async () => {
  const fm = createFetchMock();
  fm.route("https://primary/**").once(503);
  fm.route("https://fallback/**").reply(200, "fb");
  fm.install();
  const a = await fetch("https://primary/1");
  assert.equal(a.status, 503);
  const b = await fetch("https://fallback/1");
  assert.equal(await b.text(), "fb");
  await assert.rejects(() => fetch("https://primary/2"), /no route matched/);
  fm.uninstall();
});

await check("fetch: dynamic reply body from request", async () => {
  const fm = createFetchMock();
  fm.route("https://echo.test/**").reply(200, (_url, init) => ({ echoed: String(init.body) }));
  fm.install();
  const data = await (
    await fetch("https://echo.test/x", { method: "POST", body: "payload" })
  ).json();
  assert.deepEqual(data, { echoed: "payload" });
  fm.uninstall();
});

console.log(`\n${passed} harness checks passed${failures.length ? `, ${failures.length} FAILED: ${failures.join(" | ")}` : ""}`);
if (failures.length) process.exitCode = 1;
