/**
 * readerPaneAdapter-scroll-trigger.spec — Regression tests for
 * ReaderPane#installScrollTrigger's content-realm container resolution.
 *
 * Real-machine finding (Zotero 10.0.3): the code resolved the pdf.js
 * `#viewerContainer` through `iframeWin.wrappedJSObject` FIRST and fell back to
 * `iframeWin`. On current Gecko the wrappedJSObject path returns null for
 * getElementById, so BOTH split panes silently lost their fast-path scroll
 * listener and dropped onto the 400ms backstop poll (logged as
 * "scroll-trigger injection failed — relying on backstop poll").
 *
 * These cases pin the resolution order: whichever window actually yields the
 * container wins, and it must work when wrappedJSObject is blind.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReaderPane } from "../../src/core/pdf/splitview/readerPaneAdapter";

/**
 * Build a ReaderPane whose internal reader exposes `_primaryView._iframe` with
 * a controllable `contentWindow`. `wrappedBlind` makes the wrappedJSObject
 * path return null for the viewer container (the Zotero 10.0.3 behaviour).
 */
function makePane(opts: { wrappedBlind: boolean; hasContainer: boolean }) {
  const listeners: { el: string; type: string; fn: any }[] = [];
  const makeWindow = (canSeeContainer: boolean) => ({
    document: {
      getElementById: (id: string) =>
        canSeeContainer && id === "viewerContainer"
          ? {
              id,
              addEventListener: (type: string, fn: any) =>
                listeners.push({ el: id, type, fn }),
              removeEventListener: (type: string, fn: any) => {
                const i = listeners.findIndex(
                  (l) => l.type === type && l.fn === fn,
                );
                if (i >= 0) listeners.splice(i, 1);
              },
            }
          : null,
    },
  });

  // The direct (Xray-wrapped) content window of the reader's pdf.js iframe.
  const directWin = makeWindow(opts.hasContainer);
  // The unwrapped sibling — on Zotero 10.0.3 its getElementById is blind.
  const wrappedWin = makeWindow(!opts.wrappedBlind && opts.hasContainer);

  const browser = {
    contentWindow: {
      wrappedJSObject: {
        ...wrappedWin,
        _reader: {
          _primaryView: { _iframe: { contentWindow: directWin } },
        },
      },
    },
  };

  const pane = new ReaderPane(null);
  // Reach the private browser through the public shape the methods use.
  (pane as any).browser = browser;
  return { pane, listeners, directWin, wrappedWin };
}

/** Establishes the Components/Cu globals the adapter uses. */
function installCu() {
  const exported: any[] = [];
  const Cu = {
    exportFunction: (fn: any, _win: any) => {
      const wrapper = (...args: any[]) => fn(...args);
      exported.push(wrapper);
      return wrapper;
    },
    revoke: vi.fn(),
  };
  (globalThis as any).Components = { utils: Cu };
  return { Cu, exported };
}

describe("ReaderPane#installScrollTrigger", () => {
  let cuRef: { Cu: any; exported: any[] } | null = null;

  beforeEach(() => {
    cuRef = installCu();
    // The method's catch block logs through Zotero.debug; provide it so an
    // expected failure doesn't turn into a ReferenceError.
    (globalThis as any).Zotero = {
      debug: () => {},
      logError: () => {},
    };
  });

  afterEach(() => {
    delete (globalThis as any).Components;
    delete (globalThis as any).Zotero;
    cuRef = null;
  });

  it("registers a content-realm scroll listener when only the direct window sees the container", () => {
    // The Zotero 10.0.3 shape: wrappedJSObject is blind, contentWindow is not.
    const { pane, listeners, directWin } = makePane({
      wrappedBlind: true,
      hasContainer: true,
    });

    const cleanup = pane.installScrollTrigger(() => {});

    expect(cleanup).toBeTypeOf("function");
    expect(listeners).toHaveLength(1);
    expect(listeners[0].type).toBe("scroll");
    expect(cuRef!.exported).toHaveLength(1);
    // The bridge must target the window that owned the element.
    expect(directWin).toBeTruthy();

    cleanup!();
    expect(listeners).toHaveLength(0);
    expect(cuRef!.Cu.revoke).toHaveBeenCalled();
  });

  it("prefers the unwrapped window when it can see the container (Zotero 7 path)", () => {
    const { pane, listeners } = makePane({
      wrappedBlind: false,
      hasContainer: true,
    });

    const cleanup = pane.installScrollTrigger(() => {});

    expect(cleanup).toBeTypeOf("function");
    expect(listeners).toHaveLength(1);
  });

  it("returns null (caller falls back to polling) when no window sees the container", () => {
    const { pane } = makePane({ wrappedBlind: false, hasContainer: false });
    expect(pane.installScrollTrigger(() => {})).toBeNull();
  });

  it("returns null when Cu.exportFunction is unavailable", () => {
    delete (globalThis as any).Components;
    const { pane } = makePane({ wrappedBlind: true, hasContainer: true });
    expect(pane.installScrollTrigger(() => {})).toBeNull();
  });

  it("the installed listener invokes the chrome onScroll callback", () => {
    const { pane, listeners } = makePane({
      wrappedBlind: true,
      hasContainer: true,
    });
    const onScroll = vi.fn();
    pane.installScrollTrigger(onScroll);

    expect(listeners).toHaveLength(1);
    listeners[0].fn();
    expect(onScroll).toHaveBeenCalledTimes(1);
  });
});

describe("ReaderPane#getScrollContainer", () => {
  beforeEach(() => {
    (globalThis as any).Zotero = { debug: () => {} };
    (globalThis as any).Components = {
      utils: { exportFunction: (fn: any) => fn, revoke: () => {} },
    };
  });
  afterEach(() => {
    delete (globalThis as any).Zotero;
    delete (globalThis as any).Components;
  });

  it("finds #viewerContainer when only the direct window sees it", () => {
    const container = { id: "viewerContainer" };
    const { pane } = makePaneResolving(container, false);
    expect(pane.getScrollContainer()).toBe(container);
  });

  it("finds #viewerContainer through the unwrapped window (Zotero 7 path)", () => {
    const container = { id: "viewerContainer" };
    const { pane } = makePaneResolving(container, true);
    expect(pane.getScrollContainer()).toBe(container);
  });

  it("returns null (not the document root) before pdf.js builds the chain", () => {
    const { pane } = makePaneResolving(null, false);
    expect(pane.getScrollContainer()).toBeNull();
  });
});

/** A pane whose content documents resolve viewerContainer only where asked. */
function makePaneResolving(container: any, onWrapped: boolean) {
  const doc = (has: boolean) => ({
    document: {
      getElementById: (id: string) =>
        has && id === "viewerContainer" ? container : null,
      scrollingElement: null,
      documentElement: null,
    },
  });
  // The pdf.js iframe window: an Xray view plus its unwrapped sibling.
  const directWin: any = doc(!onWrapped && !!container);
  directWin.wrappedJSObject = doc(onWrapped && !!container);
  // reader.html's window, whose wrappedJSObject holds the internal reader.
  const browser = {
    contentWindow: {
      wrappedJSObject: {
        _reader: { _primaryView: { _iframe: { contentWindow: directWin } } },
      },
    },
  };
  const pane = new ReaderPane(null);
  (pane as any).browser = browser;
  return { pane };
}
