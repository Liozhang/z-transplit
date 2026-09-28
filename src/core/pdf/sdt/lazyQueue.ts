/**
 * sdt/lazyQueue — viewport-driven lazy translation queue for the interleave
 * view.
 *
 * An IntersectionObserver (created in the SDT iframe's own realm) watches the
 * injected placeholder blocks; a paragraph becomes eligible when it approaches
 * the viewport (rootMargin supplies the look-ahead buffer). Eligible texts are
 * merged into batch translation calls, bounded by a concurrency limit — this
 * is what keeps "translate the whole document lazily" from turning into a
 * request storm on a 200-paragraph paper.
 *
 * The queue is transport-only: DOM rendering is delegated to callbacks, and
 * caching is delegated to injected lookup/store hooks (implemented by the
 * interleave view on top of translationCache.ts).
 *
 * @module core/pdf/sdt/lazyQueue
 */

import { safeDebug } from "../../../utils/logger";

export type QueueItemState = "queued" | "loading" | "done" | "failed";

export interface LazyQueueHooks {
  /** Batch translate texts (1..batchSize). Must return aligned translations. */
  translateBatch: (
    texts: string[],
    signal?: AbortSignal,
  ) => Promise<{ translations: string[]; failedIndices: number[] }>;
  /** Look up cached translations. Absent keys are simply missing. */
  lookup?: (texts: string[]) => Promise<Map<string, string>>;
  /** Store one successful translation. */
  store?: (text: string, translated: string) => void;
  /** Render-side callbacks. */
  onLoading?: (refPath: string) => void;
  onDone?: (refPath: string, translated: string) => void;
  onFailed?: (refPath: string) => void;
  onProgress?: (stats: QueueStats) => void;
}

export interface QueueStats {
  total: number;
  done: number;
  failed: number;
  loading: number;
  queued: number;
}

export interface LazyQueueOptions {
  concurrency?: number;
  batchSize?: number;
  /** Look-ahead margin for the observer, e.g. "120% 0px". */
  rootMargin?: string;
  signal?: AbortSignal;
}

interface InternalItem {
  refPath: string;
  text: string;
  state: QueueItemState;
}

export class LazyTranslateQueue {
  private items = new Map<string, InternalItem>(); // refPath → item
  private pending: string[] = [];
  private active = 0;
  private done = 0;
  private failed = 0;
  private pollTimer: number | null = null;
  private stopped = false;
  /** Topmost visible original block (approximate reading position). */
  private topVisible: string | null = null;

  constructor(
    private doc: Document,
    /**
     * Watched entries keyed by ref-path. The OBSERVED element is the injected
     * PLACEHOLDER (not Zotero's original block): placeholders always occupy
     * layout — including translation-only mode, where the original is
     * display:none and would never intersect.
     */
    private entries: Map<string, { text: string; placeholder: HTMLElement }>,
    private hooks: LazyQueueHooks,
    private options: LazyQueueOptions = {},
  ) {}

  /**
   * Start watching with a GEOMETRY POLL instead of an IntersectionObserver.
   *
   * An IntersectionObserver constructed from the chrome realm with a chrome
   * callback observing content-realm elements never invokes the callback
   * (cross-realm DOM callback dispatch silently fails — found in the 10.0.3
   * manual verification: the queue stayed at 0/N forever). Reading element
   * rectangles from chrome, by contrast, works everywhere — so poll the
   * placeholders on a timer from the session window.
   */
  start(): void {
    for (const [refPath, entry] of this.entries) {
      entry.placeholder.setAttribute("data-ref-path", refPath);
    }
    const view = this.doc.defaultView as any;
    const tick = view?.setInterval as ((fn: any, ms: number) => number) | undefined;
    if (typeof tick !== "function") {
      // Host without timers (tests): translate everything immediately.
      for (const refPath of this.entries.keys()) this.enqueue(refPath);
      this.pump();
      return;
    }
    this.pollTimer = tick.call(view, () => this.poll(), 700);
  }

  /** One geometry poll: enqueue approaching blocks, track reading position. */
  private poll(): void {
    if (this.stopped) return;
    try {
      const view = this.doc.defaultView;
      const viewportH = Number(view?.innerHeight) || 800;
      let topCandidate: { refPath: string; top: number } | null = null;
      for (const [refPath, entry] of this.entries) {
        const rect = entry.placeholder.getBoundingClientRect();
        // Look-ahead buffer of ~a viewport above and below the fold.
        const visible =
          rect.top < viewportH * 1.8 && rect.bottom > -viewportH * 0.8;
        if (visible && !this.items.has(refPath)) this.enqueue(refPath);
        if (
          visible &&
          (topCandidate === null || rect.top < topCandidate.top)
        ) {
          topCandidate = { refPath, top: rect.top };
        }
      }
      if (topCandidate) this.topVisible = topCandidate.refPath;
      this.pump();
    } catch (e) {
      // The view may be mid-teardown — the next tick retries or stop() clears.
      safeDebug("[Z-Transplit] lazyQueue poll: " + e);
    }
  }

  /** Register one entry for polling. */
  watch(
    refPath: string,
    entry: { text: string; placeholder: HTMLElement },
  ): void {
    this.entries.set(refPath, entry);
    entry.placeholder.setAttribute("data-ref-path", refPath);
  }

  /** Manually enqueue (retry buttons). */
  retry(refPath: string): void {
    const item = this.items.get(refPath);
    if (!item || item.state === "loading" || item.state === "done") return;
    item.state = "queued";
    this.pending.unshift(refPath);
    this.emitProgress();
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    try {
      const view = this.doc.defaultView as any;
      if (this.pollTimer != null && typeof view?.clearInterval === "function") {
        view.clearInterval(this.pollTimer);
      }
    } catch {
      /* best-effort */
    }
    this.pollTimer = null;
  }

  stats(): QueueStats {
    let loading = 0;
    let queued = 0;
    for (const item of this.items.values()) {
      if (item.state === "loading") loading++;
      else if (item.state === "queued") queued++;
    }
    return {
      total: this.entries.size,
      done: this.done,
      failed: this.failed,
      loading,
      queued,
    };
  }

  /** Current reading position (topmost visible block), for read-aloud. */
  currentRefPath(): string | null {
    return this.topVisible;
  }

  private enqueue(refPath: string): void {
    const text = this.entries.get(refPath)?.text || "";
    if (!text) return;
    this.items.set(refPath, { refPath, text, state: "queued" });
    this.pending.push(refPath);
  }

  private textOf(refPath: string): string {
    return this.entries.get(refPath)?.text || this.items.get(refPath)?.text || "";
  }

  private mark(refPath: string, state: QueueItemState): void {
    const item = this.items.get(refPath);
    if (item) item.state = state;
  }

  private emitProgress(): void {
    try {
      this.hooks.onProgress?.(this.stats());
    } catch {
      /* UI callback must never break the queue */
    }
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    const concurrency = Math.max(1, this.options.concurrency ?? 2);
    const batchSize = Math.max(1, this.options.batchSize ?? 8);
    const signal = this.options.signal;

    while (
      !this.stopped &&
      this.active < concurrency &&
      this.pending.length > 0 &&
      !signal?.aborted
    ) {
      const batchRefs: string[] = [];
      while (batchRefs.length < batchSize && this.pending.length > 0) {
        const refPath = this.pending.shift() as string;
        if (this.items.get(refPath)?.state === "queued") {
          batchRefs.push(refPath);
        }
      }
      if (batchRefs.length === 0) break;
      this.active++;
      void this.runBatch(batchRefs).finally(() => {
        this.active--;
        this.emitProgress();
        this.pump();
      });
    }
  }

  private async runBatch(refPaths: string[]): Promise<void> {
    const texts = refPaths.map((r) => this.textOf(r));
    for (const refPath of refPaths) {
      this.mark(refPath, "loading");
      try {
        this.hooks.onLoading?.(refPath);
      } catch {
        /* ignore */
      }
    }

    try {
      // Cache layer first — hits never reach the engine.
      const cached = this.hooks.lookup
        ? await this.hooks.lookup(texts)
        : new Map<string, string>();

      const misses: string[] = [];
      const missPositions: number[] = [];
      const results: (string | null)[] = texts.map((text, i) => cached.get(text) ?? null);
      texts.forEach((text, i) => {
        if (results[i] === null) {
          misses.push(text);
          missPositions.push(i);
        }
      });

      if (misses.length > 0) {
        const batch = await this.hooks.translateBatch(misses, this.options.signal);
        misses.forEach((text, i) => {
          const translated = batch.translations[i];
          const failed = batch.failedIndices.includes(i);
          const position = missPositions[i];
          if (!failed && translated && translated.trim()) {
            results[position] = translated;
            try {
              this.hooks.store?.(text, translated);
            } catch {
              /* best-effort */
            }
          } else {
            results[position] = null;
          }
        });
      }

      for (let i = 0; i < refPaths.length; i++) {
        const translated = results[i];
        if (translated) {
          this.mark(refPaths[i], "done");
          this.done++;
          try {
            this.hooks.onDone?.(refPaths[i], translated);
          } catch (e) {
            safeDebug("[Z-Transplit] lazyQueue onDone: " + e);
          }
        } else {
          this.mark(refPaths[i], "failed");
          this.failed++;
          try {
            this.hooks.onFailed?.(refPaths[i]);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      if (this.options.signal?.aborted) return;
      safeDebug("[Z-Transplit] lazyQueue batch failed: " + e);
      for (const refPath of refPaths) {
        this.mark(refPath, "failed");
        this.failed++;
        try {
          this.hooks.onFailed?.(refPath);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
