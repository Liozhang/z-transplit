/**
 * Progress popup facade over Zotero.ProgressWindow.
 *
 * Why this exists. The eight call sites that used to talk to
 * Zotero.ProgressWindow directly shared three defects, all of them visible in
 * the field:
 *
 *   1. A popup that never closes itself. `makeJarDownloadProgress` only armed
 *      a close timer on the downloader's `done`/`failed` phases, and a fresh
 *      download ends at `verifying` — so after the first parse of a slim
 *      install the popup sat in the corner until the user clicked it.
 *   2. A popup that comes back from the dead. The bilingual session reports
 *      progress for the whole reader session (blocks are translated lazily as
 *      the user scrolls), long after the entry point had printed its
 *      "ready" line and armed a close timer. Every late report called
 *      addDescription() + show(), and show() re-opens a popup the timer had
 *      just closed — with no new timer armed, so it stayed open forever.
 *   3. One row per report. addDescription() appends a row every time, so a
 *      long run stacked dozens of near-identical "x/y" lines.
 *
 * This wrapper answers all three. `fraction()` keeps ONE row (a Zotero
 * ItemProgress, which carries the host's own circular progress indicator) and
 * rewrites its text in place; `settle()`/`fail()` print the terminal line and
 * mark the reporter closed, after which further reports are dropped instead
 * of re-opening the popup.
 *
 * Zotero's ItemProgress is the only progress affordance the host exposes on a
 * ProgressWindow: a circular arc that fills with the percentage and resolves
 * to a check-style icon at 100%. The popup is a XUL dialog and its DOM is
 * private, so a linear bar cannot be injected — the arc plus the "x/y" label
 * is the native form. When ItemProgress is unavailable (older host, a
 * different realm) the reporter degrades to plain description rows.
 *
 * Every method is best-effort and never throws: a popup failure must not take
 * down the operation it is reporting on.
 */

import { safeDebug } from "./logger";
import type { ProgressFraction } from "../core/translation/types";

export type { ProgressFraction };

const TAG = "[Z-Transplit] progressWindow";

export interface ProgressReporterOptions {
  /** Parent window, as Zotero.ProgressWindow expects. Omit for the main window. */
  window?: any;
  /** First line of the popup. */
  headline: string;
}

export class ProgressReporter {
  private pw: any;
  /** Set by settle()/fail(): later reports must not resurrect the popup. */
  private closed = false;
  /** The single in-place progress row, created on the first fraction(). */
  private row: any = null;
  /** Whether the host offered ItemProgress (decided on first use). */
  private rowUsable: boolean | null = null;

  constructor(options: ProgressReporterOptions) {
    this.pw = new (globalThis as any).Zotero.ProgressWindow({
      window: options.window ?? null,
    });
    this.headline(options.headline);
    this.pw.show();
  }

  /** Replace the popup's headline (first line). */
  headline(text: string): void {
    this.guard(() => this.pw.changeHeadline(text));
  }

  /**
   * Append one row — for phase lines that have no measurable fraction
   * ("正在解析 PDF 版面…"). Ignored once the reporter is closed.
   */
  note(text: string): void {
    if (this.closed) return;
    this.guard(() => {
      this.pw.addDescription(text);
      // show() is a no-op while the popup is up, but re-opens it (and flushes
      // queued rows) after the user closed it — an in-flight phase line must
      // not be lost silently.
      this.pw.show();
    });
  }

  /**
   * Report a measurable phase on ONE row, rewritten in place: the label
   * carries the count and the host's circular indicator carries the share.
   * Ignored once the reporter is closed.
   */
  fraction(done: number, total: number, label: string): void {
    if (this.closed) return;
    const percent =
      total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
    this.guard(() => {
      if (this.rowUsable === null) {
        this.rowUsable = typeof this.pw.ItemProgress === "function";
      }
      if (this.rowUsable) {
        if (!this.row) {
          // 构造函数自带初始文本，省掉紧接着的一次重复 setText。
          this.row = new this.pw.ItemProgress(null, label);
        } else {
          this.row.setText(label);
        }
        this.row.setProgress(percent);
      } else {
        // No ItemProgress on this host — fall back to appended rows so the
        // user still sees the numbers.
        this.pw.addDescription(label);
      }
      this.pw.show();
    });
  }

  /**
   * Terminal success line + auto-close after `ms`. From here on the reporter
   * is closed: late reports (a lazily translated block, a trailing chunk)
   * are dropped rather than re-opening the popup.
   */
  settle(text: string | null, ms: number): void {
    this.closed = true;
    this.guard(() => {
      if (text) this.pw.addDescription(text);
      this.pw.startCloseTimer(ms);
    });
  }

  /** Terminal failure line + auto-close after `ms`. Same closing semantics. */
  fail(text: string, ms: number): void {
    this.closed = true;
    this.guard(() => {
      this.pw.addDescription(text);
      this.pw.startCloseTimer(ms);
    });
  }

  /**
   * Arm the close timer WITHOUT closing the reporter — for the "dismiss the
   * in-flight popup behind the dialog I am about to open" case, where more
   * rows may still follow (a failure line after the dismissal).
   */
  dismiss(ms: number): void {
    this.guard(() => this.pw.startCloseTimer(ms));
  }

  /** Close immediately. */
  close(): void {
    this.closed = true;
    this.guard(() => this.pw.close());
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      safeDebug(`${TAG} popup call failed: ${e}`);
    }
  }
}
