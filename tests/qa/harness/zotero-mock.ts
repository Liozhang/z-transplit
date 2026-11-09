/**
 * zotero-mock — Programmable Zotero global mock for z-transplit unit tests.
 *
 * Covers every Zotero surface the ported translation code touches:
 *   - Prefs (get/set with an in-memory map, `extensions.zotero.ztransplit.*`)
 *   - locale / debug / platform flags (isWin/isMac/platform) — forceable, so
 *     platform.ts OS detection can be tested on any host
 *   - PDFTranslate bridge (present/absent toggle)
 *   - ItemPaneManager.registerSection (spy: records pane config)
 *   - Reader integration (tabID + _selectionRanges) for the translate pane,
 *     plus registerEventListener + fireSelectionPopup so tests can drive the
 *     「renderTextSelectionPopup」 live-selection-sync path
 *   - ProgressWindow / Items / MainWindow / DataDirectory stubs
 *
 * Usage:
 *   const z = createZoteroMock({ prefs: { "translate.engineType": "bing" } });
 *   z.install();          // sets globalThis.Zotero
 *   z.prefs.set("translate.enabled", true);
 *   z.uninstall();        // restores previous globalThis.Zotero
 */

export interface ZoteroMockOptions {
  prefs?: Record<string, unknown>;
  locale?: string;
  platform?: "win" | "mac" | "linux";
  pdfTranslate?: {
    translate: (text: string, opts: Record<string, unknown>) => Promise<any>;
  } | null;
}

export interface RegisteredPane {
  paneID: string;
  header?: Record<string, unknown>;
  sidenav?: Record<string, unknown>;
  onItemChange?: (ctx: any) => void;
  onRender?: (ctx: any) => void;
  onDestroy?: (ctx: any) => void;
}

export interface ReaderSelectionStub {
  tabID: number;
  selectionRanges?: Array<{ text: string }>;
  /** Attachment itemID the reader runs on (translatePane parent/attachment matching). */
  itemID?: number;
  /**
   * Reader kind Zotero would report on this instance (`ReaderInstance.type`).
   * Defaults to "pdf": every existing stub models a PDF reader, and the
   * reader-kind gates under test override it explicitly (e.g. "epub").
   */
  type?: "pdf" | "epub" | "snapshot";
  /**
   * Model a DOM view (EPUB / HTML snapshot): the primary view exposes NO
   * `_selectionRanges` (that array is a pdf.js-view shape) but does expose
   * `getSelectionPosition()` — upstream dom-view.tsx returns null when the
   * selection is collapsed. `domSelection` decides which.
   */
  domView?: boolean;
  domSelection?: boolean;
}

export class PrefMap {
  private map: Map<string, unknown>;
  readonly writes: Array<{ key: string; value: unknown }> = [];

  constructor(initial: Record<string, unknown> = {}) {
    this.map = new Map(Object.entries(initial));
  }

  get(key: string): unknown {
    return this.map.has(key) ? this.map.get(key) : undefined;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: unknown): void {
    this.writes.push({ key, value });
    this.map.set(key, value);
  }

  /** Bulk-set from an unprefixed map: {"translate.enabled": true} → full key. */
  load(prefixed: Record<string, unknown>, prefix: string): void {
    for (const [k, v] of Object.entries(prefixed)) {
      this.map.set(`${prefix}.${k}`, v);
    }
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  clear(): void {
    this.map.clear();
    this.writes.length = 0;
  }
}

/**
 * Module-level reader-event registry. Zotero.Reader is a process-wide
 * singleton in production, and the plugin registers its shared selection-sync
 * listener once per process — while a fresh ZoteroMock is built per test even
 * though the plugin module (and its "already registered" flag) persists across
 * tests in a file. Mirroring the singleton with a module-level array keeps
 * fireSelectionPopup reaching listeners registered by earlier tests' mounts.
 */
const sharedReaderEventListeners: Array<{
  type: string;
  handler: (event: any) => void;
}> = [];

/** Drop every registered reader-event listener (test isolation helper). */
export function resetReaderEventListeners(): void {
  sharedReaderEventListeners.length = 0;
}

/**
 * Build the mock's ItemProgress class, bound to the popup that owns it. A
 * module-level factory (rather than a class expression inside the getter) so
 * the row can register itself on its owner — that is how a test reaches the
 * rows the plugin created.
 */
function makeMockItemProgress(owner: {
  rows: Array<{ texts: string[]; percents: number[] }>;
}) {
  return class {
    texts: string[] = [];
    percents: number[] = [];
    constructor(_itemType: unknown, text: string) {
      // 真实宿主的构造器内部就是调 setText()，这里照做：初始文本与第一次
      // setText 在记录上不可区分（宿主渲染结果也确实如此）。
      this.setText(text);
      owner.rows.push(this);
    }
    setText(text: string) {
      this.texts.push(text);
    }
    setProgress(percent: number) {
      this.percents.push(percent);
    }
    setError() {}
    /** Latest text, the way the host renders the row. */
    get text(): string {
      return this.texts[this.texts.length - 1] ?? "";
    }
    /** Latest percentage, -1 when setProgress was never called. */
    get percent(): number {
      return this.percents[this.percents.length - 1] ?? -1;
    }
  };
}

export class ZoteroMock {
  readonly prefs: PrefMap;
  readonly prefix: string;
  readonly registeredPanes: RegisteredPane[] = [];
  readonly registeredMenus: Array<{ id: string; [k: string]: unknown }> = [];
  readonly debugLines: string[] = [];
  readonly progressWindows: Array<{ headline: string; descriptions: string[] }> = [];
  /** Live popup instances, newest last — for asserting rows and timers. */
  readonly progressWindowInstances: any[] = [];
  /**
   * Every popup call in order, so a test can assert the sequence (headline →
   * note → fraction row → settle) rather than only the final state.
   */
  readonly progressEvents: Array<
    | { kind: "headline"; text: string }
    | { kind: "note"; text: string }
    | { kind: "show" }
    | { kind: "timer"; ms: number }
    | { kind: "close" }
  > = [];
  locale: string;
  platform: "win" | "mac" | "linux";
  pdfTranslate: any;
  private readerStub: ReaderSelectionStub | null = null;
  private readerInstance: any = null;
  items: Map<number, any> = new Map();

  /**
   * Selection stub. Assigning a NEW object invalidates the cached reader
   * instance: Zotero's getByTabID returns a stable ReaderInstance, and the
   * translate pane compares readers by identity (matchesReader), so the mock
   * must hand out the same object between assignments.
   */
  get reader(): ReaderSelectionStub | null {
    return this.readerStub;
  }

  set reader(v: ReaderSelectionStub | null) {
    this.readerStub = v;
    this.readerInstance = null;
  }

  private getReaderInstance(): any {
    if (!this.readerStub) return null;
    if (!this.readerInstance) {
      const stub = this.readerStub;
      // DOM views (EPUB / snapshot) expose a live-selection probe instead of
      // the pdf.js `_selectionRanges` array; see the stub field docs.
      const primaryView = stub.domView
        ? {
            getSelectionPosition: () =>
              stub.domSelection ? { type: "css", value: "p:nth-of-type(1)" } : null,
          }
        : { _selectionRanges: stub.selectionRanges };
      this.readerInstance = {
        itemID: stub.itemID,
        type: stub.type ?? "pdf",
        _internalReader: {
          _primaryView: primaryView,
        },
      };
    }
    return this.readerInstance;
  }
  private savedZotero: unknown;
  private savedTabs: unknown;

  constructor(opts: ZoteroMockOptions = {}) {
    this.prefix = "extensions.zotero.ztransplit";
    this.prefs = new PrefMap();
    this.locale = opts.locale ?? "zh-CN";
    this.platform = opts.platform ?? "linux";
    this.pdfTranslate = opts.pdfTranslate ?? null;
    if (opts.prefs) this.prefs.load(opts.prefs, this.prefix);
  }

  get Zotero(): any {
    const self = this;
    return {
      locale: self.locale,
      isWin: self.platform === "win",
      isMac: self.platform === "mac",
      get platform() {
        return self.platform === "win"
          ? "win32"
          : self.platform === "mac"
            ? "macosx"
            : "linux";
      },
      debug: (msg: string) => {
        self.debugLines.push(String(msg));
      },
      Prefs: {
        get: (key: string) => self.prefs.get(key),
        set: (key: string, value: unknown) => {
          self.prefs.set(key, value);
        },
      },
      PDFTranslate: self.pdfTranslate,
      getMainWindow: () => null,
      DataDirectory: { dir: "/tmp/zotero-data" },
      Items: {
        get: (id: number) => self.items.get(id) ?? null,
      },
      ItemPaneManager: {
        registerSection: (cfg: RegisteredPane) => {
          self.registeredPanes.push(cfg);
          return cfg.paneID;
        },
        unregisterSection: () => true,
      },
      MenuManager: {
        register: (cfg: Record<string, unknown>) => {
          self.registeredMenus.push({ id: String(cfg.id ?? ""), ...cfg });
          return cfg.id;
        },
      },
      ProgressWindow: class {
        headline = "";
        descriptions: string[] = [];
        closed = false;
        shows = 0;
        closeTimers: number[] = [];
        /** Rows created through the host's ItemProgress API (progress rows). */
        rows: Array<{
          texts: string[];
          percents: number[];
          get text(): string;
          get percent(): number;
        }> = [];
        constructor() {
          self.progressWindowInstances.push(this);
        }
        /**
         * Stand-in for Zotero's ItemProgress: one row whose text is rewritten
         * in place and whose circular indicator follows setProgress(). Records
         * every call so a test can assert "one row, updated N times" instead
         * of "N appended rows".
         */
        ItemProgress = makeMockItemProgress(this);
        changeHeadline(h: string) {
          this.headline = h;
          self.progressWindows.push({
            headline: h,
            descriptions: this.descriptions,
          });
          self.progressEvents.push({ kind: "headline", text: h });
        }
        addDescription(d: string) {
          this.descriptions.push(d);
          self.progressEvents.push({ kind: "note", text: d });
        }
        show() {
          this.shows++;
          self.progressEvents.push({ kind: "show" });
        }
        startCloseTimer(ms?: number) {
          this.closeTimers.push(ms ?? 2500);
          self.progressEvents.push({ kind: "timer", ms: ms ?? 2500 });
        }
        close() {
          this.closed = true;
          self.progressEvents.push({ kind: "close" });
        }
      },
      Reader: {
        registerEventListener: (type: string, handler: (event: any) => void) => {
          sharedReaderEventListeners.push({ type, handler });
        },
        unregisterEventListener: (type: string, handler: (event: any) => void) => {
          const i = sharedReaderEventListeners.findIndex(
            (l) => l.type === type && l.handler === handler,
          );
          if (i >= 0) sharedReaderEventListeners.splice(i, 1);
        },
        getByTabID: (tabID: number) => {
          if (!self.reader || self.reader.tabID !== tabID) return null;
          return self.getReaderInstance();
        },
      },
    };
  }

  install(): void {
    this.savedZotero = (globalThis as any).Zotero;
    this.savedTabs = (globalThis as any).Zotero_Tabs;
    (globalThis as any).Zotero = this.Zotero;
    (globalThis as any).Zotero_Tabs = { selectedID: this.reader?.tabID ?? 1 };
  }

  uninstall(): void {
    if (this.savedZotero === undefined) delete (globalThis as any).Zotero;
    else (globalThis as any).Zotero = this.savedZotero;
    if (this.savedTabs === undefined) delete (globalThis as any).Zotero_Tabs;
    else (globalThis as any).Zotero_Tabs = this.savedTabs;
  }

  /**
   * Fire 「renderTextSelectionPopup」 the way Zotero's reader iframe does:
   * `{ reader, doc, params: { annotation }, append }` where `annotation.text`
   * is the popup's own selection text and `annotation.position` is the PDF
   * position ({pageIndex, rects}). Pass `undefined` text (or omit) to simulate
   * a popup render that carries no annotation; pass a position to simulate
   * the geometry the in-text context capture consumes.
   */
  fireSelectionPopup(annotationText?: string, position?: unknown): void {
    const tabs = (globalThis as any).Zotero_Tabs ?? { selectedID: this.reader?.tabID ?? 1 };
    const reader = this.getReaderInstance();
    const event = {
      reader,
      doc: null,
      params: {
        annotation:
          annotationText === undefined
            ? undefined
            : position === undefined
              ? { text: annotationText }
              : { text: annotationText, position },
      },
      append: () => {},
    };
    for (const { type, handler } of [...sharedReaderEventListeners]) {
      if (type === "renderTextSelectionPopup") handler(event);
    }
  }

  /**
   * Fire an arbitrary registered reader event (e.g. 「createViewContextMenu」)
   * against every listener registered for that type. The caller builds the
   * event — reader/append/params — since each event type carries its own
   * shape; menu handlers receive `append` collectors from the test.
   */
  fireReaderEvent(type: string, event: any): void {
    for (const { type: registered, handler } of [...sharedReaderEventListeners]) {
      if (registered === type) handler(event);
    }
  }
}

export function createZoteroMock(opts: ZoteroMockOptions = {}): ZoteroMock {
  return new ZoteroMock(opts);
}
