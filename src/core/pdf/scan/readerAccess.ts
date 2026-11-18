/**
 * readerAccess — 阅读器会话的共享管道：找 reader、取 iframe 内容域、
 * 等 pdf.js 就绪、瞬开瞬关。
 *
 * 从 ZoteroPdfRasterizer 与 opendataloaderSplitAdapter 提取而来——两处
 * 原本各有一份"按附件找 reader / 解包 iframe / 轮询等待"的实现，扫描件
 * 管线是第三个消费者，再抄一份就会三处漂移。提取后两个老消费者改为
 * 从这里导入，行为不变。
 *
 * Host-coupled by design（Zotero.Reader 内部结构 + 内容域 eval）——不可
 * 在 Node 下单测；纯函数部分（坐标换算）在 pdfPageProbe 里单独导出。
 *
 * @module core/pdf/scan/readerAccess
 */

import { safeDebug } from "../../../utils/logger";
import { getString } from "../../../utils/locale";

/**
 * 按附件 ID 找阅读器实例：遍历 Zotero.Reader，匹配底层条目 id。
 */
export function findReaderForAttachment(attachmentId: number): any {
  const readers = (Zotero as any).Reader?.getReaders?.() ||
    (Zotero as any).Reader?._readers ||
    [];
  for (const r of readers) {
    try {
      // Reader instances expose the attachment item id via _itemID / itemID /
      // _attachmentId / attachmentId depending on the Zotero version.
      const id = r._itemID ?? r.itemID ?? r._attachmentId ?? r.attachmentId;
      if (id === attachmentId) return r;
    } catch (e) {
      safeDebug("[Z-Transplit] readerAccess: " + e);
      /* skip */
    }
  }
  return null;
}

/**
 * 取阅读器 iframe 的内容域窗口（解开 Xray 包装），供 pdf.js 注入使用。
 */
export function getReaderIframeWin(reader: any): any {
  const internal = reader?._internalReader ?? reader;
  const primaryView = internal?._primaryView;
  const iframe = primaryView?._iframe ?? primaryView?._iframeWindow;
  const iframeWin = iframe?.contentWindow ?? iframe;
  if (!iframeWin) return null;
  // Unwrap XPCNativeWrapper to access content-realm globals directly.
  return iframeWin.wrappedJSObject || iframeWin;
}

/**
 * 等新开阅读器的 pdf.js 就绪（_primaryView 挂上）。外层阅读器把真实阅读器
 * 包在 _internalReader 下，直接/内部阅读器在顶层暴露 _primaryView。
 */
export async function waitForReaderPdf(reader: any): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const primaryView =
      reader?._internalReader?._primaryView ?? reader?._primaryView;
    if (primaryView) return;
    await (Zotero as any).Promise.delay(100);
  }
  throw new Error(getString("err-reader-pdf-timeout"));
}

/**
 * 为一次宿主耦合的探测瞬开阅读器。返回 { reader, openedNew } 或 null。
 * openedNew 告诉调用方是否"拥有"这个阅读器、必须负责关闭——用户自己开着
 * 的标签页永远不能关。
 */
export async function openTransientReader(
  attachmentId: number,
): Promise<{ reader: any; openedNew: boolean } | null> {
  let reader: any;
  let openedNew = false;
  try {
    reader = await (Zotero as any).Reader.open(attachmentId);
    openedNew = !!reader;
    // Reader.open() 在标签页已开时返回 undefined——改找已存在的阅读器，
    // 复用它的 pdf.js 实例。
    if (!reader) {
      reader = findReaderForAttachment(attachmentId);
    }
    if (!reader) return null;
    await waitForReaderPdf(reader);
    return { reader, openedNew };
  } catch (_e) {
    // 只关自己新开的那一个。
    if (openedNew) {
      try { reader?.close?.(); } catch (e) { safeDebug("[Z-Transplit] readerAccess: " + e); }
    }
    return null;
  }
}
