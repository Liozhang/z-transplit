// @vitest-environment jsdom
/**
 * 回写看护：双语会话的译文必须落进与 PDF 管线同一个持久缓存、用同一种
 * 键——这正是「同一篇文献先双语阅读、后整本翻译（或反过来）」时秒出的
 * 前提。两个方向都钉住：
 *
 *   1. 会话写：buildInterleave（cacheIdentity + 真实队列 + 真实缓存）跑完后，
 *      cacheKey(identity, "auto", 目标语言, 原文) 在磁盘上能读到译文；
 *   2. 会话读：同一 identity 的新会话整页命中缓存，引擎一次都不被调用。
 *
 * 磁盘与队列都是真件（临时目录 + IOUtils 垫片），断言的是键形状与命中
 * 行为，不是内存桩。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildInterleave } from "../../../../../src/core/pdf/sdt/interleaveView";
import {
  cacheKey,
  getCachedTranslations,
  setCacheDirForTests,
} from "../../../../../src/core/translation/translationCache";
import {
  installIOUTilsShim,
  uninstallIOUTilsShim,
} from "../../../../node/helpers/ioutils-shim";

type AnySession = Parameters<typeof buildInterleave>[0];

const IDENTITY = "guardian-identity";
const TARGET = "zh-CN";

function makeSession(blocks: Array<[string, string]>): AnySession {
  const container = document.createElement("div");
  container.id = "sdt-content";
  document.body.appendChild(container);
  const sessionBlocks = blocks.map(([refPath, text]) => {
    const p = document.createElement("p");
    p.dataset.refPath = refPath;
    p.textContent = text;
    container.appendChild(p);
    return { refPath, text, el: p };
  });
  return {
    reader: {},
    internalReader: {},
    sdtView: {},
    doc: document,
    container,
    blocks: sessionBlocks,
    exit: async () => {},
  } as unknown as AnySession;
}

function flush(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await flush(50);
  }
}

describe("回写看护：会话译文与管线同键落盘、同键命中", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ztransplit-bi-cache-"));
    setCacheDirForTests(cacheDir);
    installIOUTilsShim();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setCacheDirForTests(null);
    uninstallIOUTilsShim();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("会话译文按管线同键写入磁盘", async () => {
    const pairs: Array<[string, string]> = [
      ["a", "write back alpha"],
      ["b", "write back beta"],
    ];
    const session = makeSession(pairs);
    const handle = await buildInterleave(session, {
      targetLanguage: TARGET,
      cacheIdentity: IDENTITY,
      batchTranslate: async (texts: string[]) => ({
        translations: texts.map((t) => "译-" + t),
        failedIndices: [],
      }),
    });
    await waitUntil(() => handle.stats().done === 2);

    // 逐块对账：管线读取用的 cacheKey 形状 = 会话写入的形状
    for (const [, text] of pairs) {
      const key = await cacheKey(IDENTITY, "auto", TARGET, text);
      expect(key).toBeTruthy();
      const hits = await getCachedTranslations([key as string]);
      expect(hits.get(key as string)).toBe("译-" + text);
    }
    await handle.dispose();
  });

  it("同一配置的新会话整页命中缓存，引擎零调用", async () => {
    const pairs: Array<[string, string]> = [
      ["a", "second session one"],
      ["b", "second session two"],
    ];
    const first = await buildInterleave(makeSession(pairs), {
      targetLanguage: TARGET,
      cacheIdentity: IDENTITY,
      batchTranslate: async (texts: string[]) => ({
        translations: texts.map((t) => "译-" + t),
        failedIndices: [],
      }),
    });
    await waitUntil(() => first.stats().done === 2);
    await first.dispose();

    // 新会话（新容器、同一 identity）：引擎一旦被调用就失败——命中必须
    // 发生在引擎之前。
    const second = await buildInterleave(makeSession(pairs), {
      targetLanguage: TARGET,
      cacheIdentity: IDENTITY,
      batchTranslate: async () => {
        throw new Error("engine must not be called on a full cache hit");
      },
    });
    await waitUntil(() => {
      const st = second.stats();
      return st.done + st.failed === 2;
    });
    expect(second.stats()).toMatchObject({ total: 2, done: 2, failed: 0 });
    // 页面上渲染的是缓存译文（与首轮一致）
    const container = document.querySelectorAll("#sdt-content")[1];
    const bi = container.querySelector(
      'div.ztransplit-bi[data-ref-path="a"]',
    )!;
    expect(bi.textContent).toBe("译-second session one");
    await second.dispose();
  });
});
