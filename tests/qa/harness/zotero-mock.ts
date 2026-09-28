/**
 * zotero-mock — Programmable Zotero global mock for z-transplit unit tests.
 *
 * Covers every Zotero surface the ported translation code touches:
 *   - Prefs (get/set with an in-memory map, `extensions.zotero.ztransplit.*`)
 *   - locale / debug / platform flags (isWin/isMac/platform) — forceable, so
 *     platform.ts OS detection can be tested on any host
 *   - PDFTranslate bridge (present/absent toggle)
 *   - ItemPaneManager.registerSection (spy: records pane config)
 *   - Reader integration (tabID + _selectionRanges) for the translate pane
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
  selectionRanges: Array<{ text: string }>;
  /** Attachment itemID the reader runs on (translatePane parent/attachment matching). */
  itemID?: number;
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

export class ZoteroMock {
  readonly prefs: PrefMap;
  readonly prefix: string;
  readonly registeredPanes: RegisteredPane[] = [];
  readonly registeredMenus: Array<{ id: string; [k: string]: unknown }> = [];
  readonly debugLines: string[] = [];
  readonly progressWindows: Array<{ headline: string; descriptions: string[] }> = [];
  locale: string;
  platform: "win" | "mac" | "linux";
  pdfTranslate: any;
  reader: ReaderSelectionStub | null = null;
  items: Map<number, any> = new Map();
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
        changeHeadline(h: string) {
          this.headline = h;
          self.progressWindows.push({
            headline: h,
            descriptions: this.descriptions,
          });
        }
        addDescription(d: string) {
          this.descriptions.push(d);
        }
        show() {}
        startCloseTimer() {}
        close() {}
      },
      Reader: {
        getByTabID: (tabID: number) => {
          if (!self.reader || self.reader.tabID !== tabID) return null;
          return {
            itemID: self.reader.itemID,
            _internalReader: {
              _primaryView: { _selectionRanges: self.reader.selectionRanges },
            },
          };
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
}

export function createZoteroMock(opts: ZoteroMockOptions = {}): ZoteroMock {
  return new ZoteroMock(opts);
}
