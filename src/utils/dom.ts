/**
 * Small DOM helpers for UI modules that build native-DOM trees.
 *
 * Nodes are created in the XHTML namespace so they render correctly in
 * Zotero 7's chrome documents (see translatePane.ts for the provenance of
 * this pattern — leadero's React tree ported to native DOM).
 */

/** XHTML namespace — the section bodies live in Zotero 7's chrome document. */
export const XHTML_NS = "http://www.w3.org/1999/xhtml";

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(
    XHTML_NS,
    tag,
  ) as unknown as HTMLElementTagNameMap[K];
  if (className) node.className = className;
  return node;
}

export function clearChildren(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
